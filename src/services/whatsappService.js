import makeWASocket, {
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    Browsers
} from "@whiskeysockets/baileys";
import pino from "pino";
import { WhatsAppSession } from "../models/WhatsAppSession.js";
import qrcode from "qrcode";
import { WhatsAppAuth } from "../models/WhatsAppAuth.js";
import { initAuthCreds, BufferJSON, proto } from "@whiskeysockets/baileys";
import { Merchant } from "../models/Merchant.js";

const logger = pino({ level: "info" });
const SERVICE_VERSION = "1.0.2-diag"; // To verify deployment

class WhatsAppService {
    constructor() {
        this.sockets = new Map(); // shopDomain -> socket instance
        this.io = null; // Socket.io instance
    }

    // Helper for sleep/delay
    static delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Injects micro-variations into a message to avoid identical bulk message flags.
     * Adds random invisible chars or slight variations like a trailing dot or space.
     */
    randomizeMessage(text) {
        const variations = ["", " ", ".", "  ", "\u200B"]; // invisible zero-width space included
        const randomVar = variations[Math.floor(Math.random() * variations.length)];
        return text + randomVar;
    }

    /**
     * Checks and increments daily usage for a merchant.
     * Returns true if allowed, false if limit exceeded.
     */
    async checkDailyLimit(shopDomain) {
        try {
            const today = new Date().toISOString().split('T')[0];
            const merchant = await Merchant.findOne({ shopDomain });

            if (!merchant) return true; // Fail safe

            if (merchant.lastUsageDate !== today) {
                // Reset daily usage for new day
                merchant.dailyUsage = 1;
                merchant.lastUsageDate = today;
                await merchant.save();
                return true;
            }

            if (merchant.dailyUsage >= (merchant.dailyLimit || 250)) {
                console.warn(`[WhatsApp] Daily limit reached for ${shopDomain} (${merchant.dailyUsage}/${merchant.dailyLimit})`);
                return false;
            }

            // Increment usage
            merchant.dailyUsage += 1;
            await merchant.save();
            return true;
        } catch (err) {
            console.error("Error checking daily limit:", err);
            return true; // Don't block on DB errors
        }
    }

    setSocketIO(io) {
        this.io = io;
    }

    /**
     * Custom MongoDB Auth State for Baileys
     * Replaces useMultiFileAuthState to survive Cloud Run ephemeral filesystem
     */
    async useMongoDBAuthState(shopDomain) {
        const writeData = async (data, type, id) => {
            const json = JSON.parse(JSON.stringify(data, BufferJSON.replacer));
            await WhatsAppAuth.findOneAndUpdate(
                { shopDomain, dataType: type, id },
                { data: json },
                { upsert: true }
            );
        };

        const readData = async (type, id) => {
            try {
                const res = await WhatsAppAuth.findOne({ shopDomain, dataType: type, id });
                if (res && res.data) {
                    return JSON.parse(JSON.stringify(res.data), BufferJSON.reviver);
                }
                return null;
            } catch (error) {
                return null;
            }
        };

        const removeData = async (type, id) => {
            await WhatsAppAuth.deleteOne({ shopDomain, dataType: type, id });
        };

        const creds = await readData('creds', 'main') || initAuthCreds();

        return {
            state: {
                creds,
                keys: {
                    get: async (type, ids) => {
                        const data = {};
                        await Promise.all(
                            ids.map(async (id) => {
                                let value = await readData(type, id);
                                if (type === 'app-state-sync-key' && value) {
                                    value = proto.Message.AppStateSyncKeyData.fromObject(value);
                                }
                                data[id] = value;
                            })
                        );
                        return data;
                    },
                    set: async (data) => {
                        const tasks = [];
                        for (const category in data) {
                            for (const id in data[category]) {
                                const value = data[category][id];
                                if (value) {
                                    tasks.push(writeData(value, category, id));
                                } else {
                                    tasks.push(removeData(category, id));
                                }
                            }
                        }
                        await Promise.all(tasks);
                    }
                }
            },
            saveCreds: () => writeData(creds, 'creds', 'main')
        };
    }

    async initializeClient(shopDomain) {
        try {
            // Close existing socket if any
            const existingSock = this.sockets.get(shopDomain);
            if (existingSock) {
                console.log(`Closing existing socket for ${shopDomain}`);
                existingSock.ev.removeAllListeners();
                try {
                    existingSock.end();
                } catch (e) {
                    console.error("Error ending socket:", e);
                }
                this.sockets.delete(shopDomain);
            }

            const { state, saveCreds } = await this.useMongoDBAuthState(shopDomain);
            const { version } = await fetchLatestBaileysVersion();

            const sock = makeWASocket({
                version,
                printQRInTerminal: false,
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(state.keys, logger),
                },
                logger,
                browser: Browsers.windows("Chrome"),
            });

            this.sockets.set(shopDomain, sock);

            sock.ev.on("connection.update", async (update) => {
                const { connection, lastDisconnect, qr } = update;

                if (qr) {
                    console.log(`QR Code generated for ${shopDomain}`);
                    const qrCodeDataURL = await qrcode.toDataURL(qr);

                    // Always update session with QR code
                    await WhatsAppSession.findOneAndUpdate(
                        { shopDomain },
                        {
                            qrCode: qrCodeDataURL,
                            status: "qr_ready",
                            isConnected: false
                        },
                        { upsert: true } // Create if doesn't exist
                    );

                    console.log(`QR code stored for ${shopDomain}, ready to display`);

                    if (this.io) this.io.to(shopDomain).emit("qr", { qrCode: qrCodeDataURL });
                }

                if (connection === "close") {
                    const statusCode = (lastDisconnect?.error)?.output?.statusCode;
                    const errorMessage = lastDisconnect?.error?.message || "Unknown error";

                    console.log(`Connection CLOSED for ${shopDomain}. Status: ${statusCode}. Error: ${errorMessage}`);

                    // Update session status
                    await WhatsAppSession.findOneAndUpdate(
                        { shopDomain },
                        { status: "disconnected", isConnected: false, errorMessage: errorMessage }
                    );

                    // Reconnection Logic
                    const isConflict = errorMessage.toLowerCase().includes("conflict");
                    const isLoggedOut = statusCode === DisconnectReason.loggedOut;

                    if (isLoggedOut || (isConflict && statusCode === 401)) {
                        console.log(`Permanent disconnect (Logout/Conflict) for ${shopDomain}. Stopping auto-reconnect.`);
                        // Don't disconnectClient here to keep auth files for manual retry if it was just a transient conflict
                    } else if (isConflict) {
                        console.log(`Conflict detected for ${shopDomain}. Waiting 30 seconds before retry to allow old connection to expire...`);
                        setTimeout(() => this.initializeClient(shopDomain), 30000);
                    } else {
                        // Regular reconnect after 10 seconds
                        console.log(`Attempting reconnect for ${shopDomain} in 10 seconds...`);
                        setTimeout(() => this.initializeClient(shopDomain), 10000);
                    }

                    // 4. Notify Frontend of disconnection
                    if (this.io) {
                        const fullStatus = await this.getConnectionStatus(shopDomain);
                        this.io.to(shopDomain).emit("status_update", fullStatus);
                    }
                } else if (connection === "open") {
                    console.log(`WhatsApp socket ready for ${shopDomain}`);
                    const user = sock.user.id.split(":")[0];

                    // 1. Update WhatsApp Session
                    await WhatsAppSession.findOneAndUpdate(
                        { shopDomain },
                        {
                            isConnected: true,
                            status: "connected",
                            phoneNumber: user,
                            lastConnected: new Date(),
                            qrCode: null,
                            errorMessage: null,
                        }
                    );

                    // 2. Sync with Merchant record
                    try {
                        const { Merchant } = await import("../models/Merchant.js");
                        await Merchant.findOneAndUpdate(
                            { shopDomain },
                            { whatsappNumber: user }
                        );
                    } catch (merchErr) {
                        console.error("Error updating merchant whatsappNumber:", merchErr);
                    }

                    // 3. Notify Frontend
                    if (this.io) {
                        const fullStatus = await this.getConnectionStatus(shopDomain);
                        this.io.to(shopDomain).emit("status_update", fullStatus);
                        this.io.to(shopDomain).emit("connected", { phoneNumber: user });
                    }
                }
            });

            sock.ev.on("creds.update", saveCreds);

            sock.ev.on("messages.upsert", async (m) => {
                if (m.type !== "notify") return;

                for (const msg of m.messages) {
                    if (!msg.message || msg.key.fromMe) continue;

                    // Refined source extraction: handle device IDs like 1234567:1@s.whatsapp.net
                    const fullJid = msg.key.remoteJid;
                    const fromRaw = fullJid?.split("@")[0].split(":")[0] || "";
                    const fromCleaner = fromRaw.replace(/\D/g, "");

                    console.log(`[Interaction] Incoming from ${fromRaw} (${shopDomain})`);
                    console.log(`[Interaction] Message keys: ${Object.keys(msg.message || {}).join(", ")}`);

                    const text = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
                    const isPollUpdate = !!msg.message.pollUpdateMessage;

                    if (isPollUpdate) {
                        console.log(`[Interaction] DETECTED POLL UPDATE from ${fromRaw}`);
                        console.log(`[Interaction] Poll Update details:`, JSON.stringify(msg.message.pollUpdateMessage, null, 2));
                    }

                    try {
                        const { Merchant } = await import("../models/Merchant.js");
                        const { ActivityLog } = await import("../models/ActivityLog.js");
                        const { shopifyService } = await import("./shopifyService.js");

                        const merchant = await Merchant.findOne({ shopDomain });
                        if (!merchant) {
                            console.warn(`[Interaction] Merchant record NOT FOUND for ${shopDomain}`);
                            continue;
                        }
                        if (!merchant.shopifyAccessToken) {
                            console.warn(`[Interaction] Merchant FOUND but NO ACCESS TOKEN for ${shopDomain}`);
                            continue;
                        }

                        let activityStatus = null;
                        let tagToAdd = null;

                        // 1. Detect Poll Response (Baileys poll update)
                        if (isPollUpdate) {
                            console.log(`[Interaction] Processing as poll update for ${fromRaw}`);

                            // Try to detect if it's a cancellation based on selection index if available
                            // selectedOptions is an array of hashes. Normally the first option (index 0) is Confirm.
                            const pollUpdate = msg.message.pollUpdateMessage;
                            const vote = pollUpdate?.vote;

                            // In many Baileys implementations, we can't see the text without decryption.
                            // But we can check if it's a known 'Cancel' or 'No' keyword if it's a text reply.
                            // Since this is a poll update, we default to confirmed unless we find a reason otherwise.

                            activityStatus = "confirmed";
                            tagToAdd = merchant.orderConfirmTag || "Order Confirmed";
                        } else {
                            // 2. Basic Keyword Detection (Text messages)
                            const input = text.toLowerCase().trim();
                            if (input.includes("confirm") || input.includes("yes") || input.includes("theek") || input.includes("haan")) {
                                activityStatus = "confirmed";
                                tagToAdd = merchant.orderConfirmTag || "Order Confirmed";
                            } else if (input.includes("reject") || input.includes("cancel") || input.includes("no") || input.includes("nahi")) {
                                activityStatus = "cancelled";
                                tagToAdd = merchant.orderCancelTag || "Order Cancelled";
                            }
                        }

                        if (activityStatus && tagToAdd) {
                            console.log(`[Interaction] Matched intent: ${activityStatus}. Looking for recent ActivityLog...`);

                            let log = null;

                            // Check if this is an LID format (poll responses often come from LID)
                            const isLidFormat = fullJid?.includes('@lid');

                            if (isLidFormat && isPollUpdate) {
                                // For LID poll responses, find the most recent pending activity for this merchant
                                console.log(`[Interaction] LID poll detected (${fromRaw}), searching for most recent pending activity...`);
                                log = await ActivityLog.findOne({
                                    merchant: merchant._id,
                                    type: "pending",
                                    createdAt: { $gte: new Date(Date.now() - 48 * 60 * 60 * 1000) } // Last 48 hours
                                }).sort({ createdAt: -1 });

                                if (log) {
                                    console.log(`[Interaction] MATCHED LID poll to Order: ${log.orderId}`);
                                } else {
                                    // Fallback: search for ANY recent confirmed/pending log
                                    log = await ActivityLog.findOne({
                                        merchant: merchant._id,
                                        createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }
                                    }).sort({ createdAt: -1 });
                                }
                            } else {
                                // Normal phone number matching using last 9 digits
                                const phoneSuffix = fromCleaner.slice(-9);
                                if (phoneSuffix) {
                                    console.log(`[Interaction] Searching ActivityLog for phone suffix ${phoneSuffix}`);
                                    log = await ActivityLog.findOne({
                                        merchant: merchant._id,
                                        customerPhone: new RegExp(phoneSuffix + "$")
                                    }).sort({ createdAt: -1 });
                                }
                            }

                            if (log && log.orderId) {
                                console.log(`[Interaction] SUCCESS: Found Order ${log.orderId}. Status: ${activityStatus}`);

                                const isConfirm = activityStatus === "confirmed";
                                const tagsToRemove = isConfirm
                                    ? [merchant.pendingConfirmTag, merchant.orderCancelTag]
                                    : [merchant.pendingConfirmTag, merchant.orderConfirmTag];

                                // 1. Attempt Shopify Tagging (Background)
                                try {
                                    console.log(`[Interaction] Calling shopifyService.addOrderTag for ${log.orderId}...`);
                                    const tagResult = await shopifyService.addOrderTag(shopDomain, merchant.shopifyAccessToken, log.orderId, tagToAdd, tagsToRemove);
                                    console.log(`[Interaction] Tagging result success: ${tagResult.success}`);

                                    if (tagResult.success) {
                                        log.message = `Customer confirmed via WhatsApp ✅`;
                                        log.type = activityStatus;
                                        await log.save();
                                    }
                                } catch (tagErr) {
                                    console.error("[Interaction] Tagging Error (Continuing to reply):", tagErr.message);
                                }

                                // 2. Send Customer Reply (Always send even if tagging fails)
                                await WhatsAppService.delay(1000);

                                let replyText;
                                if (isConfirm) {
                                    try {
                                        const { Template } = await import("../models/Template.js");
                                        const confirmTemplate = await Template.findOne({
                                            merchant: merchant._id,
                                            event: "orders/confirmed"
                                        });

                                        if (confirmTemplate) {
                                            const orderData = await shopifyService.getOrder(shopDomain, merchant.shopifyAccessToken, log.orderId);
                                            if (orderData) {
                                                const { replacePlaceholders } = await import("../utils/placeholderHelper.js");
                                                replyText = replacePlaceholders(confirmTemplate.message, { order: orderData, merchant });
                                                console.log(`[Interaction] Using Dynamic Template`);
                                            } else {
                                                replyText = merchant.orderConfirmReply || "Thank you! Order confirmed. ✅";
                                            }
                                        } else {
                                            replyText = merchant.orderConfirmReply || "Thank you! Order confirmed. ✅";
                                        }
                                    } catch (err) {
                                        replyText = merchant.orderConfirmReply || "Thank you! Order confirmed. ✅";
                                    }
                                } else {
                                    replyText = merchant.orderCancelReply || "Order cancelled as requested. ❌";
                                }

                                // ALWAYS SEND TO REAL PHONE NUMBER, NOT LID
                                const targetPhone = log.customerPhone || fromRaw;
                                console.log(`[Interaction] Sending confirmation reply to: ${targetPhone}`);
                                await this.sendMessage(shopDomain, targetPhone, replyText);

                                // Trigger Admin Alert (2s delay for demo, only if confirmed)
                                if (isConfirm) {
                                    await WhatsAppService.delay(2000);
                                    try {
                                        const { AutomationSetting } = await import("../models/AutomationSetting.js");
                                        const { Template } = await import("../models/Template.js");
                                        const adminSetting = await AutomationSetting.findOne({ shopDomain, type: "admin-order-alert" });

                                        if (adminSetting?.enabled && merchant.adminPhoneNumber) {
                                            const adminTemplate = await Template.findOne({ merchant: merchant._id, event: "admin-order-alert" });
                                            if (adminTemplate) {
                                                const orderData = await shopifyService.getOrder(shopDomain, merchant.shopifyAccessToken, log.orderId);
                                                if (orderData) {
                                                    const { replacePlaceholders } = await import("../utils/placeholderHelper.js");
                                                    const { automationService } = await import("./automationService.js");
                                                    let adminMsg = replacePlaceholders(adminTemplate.message, { order: orderData, merchant });
                                                    await this.sendMessage(shopDomain, merchant.adminPhoneNumber, adminMsg);
                                                    await automationService.trackSent(shopDomain, "admin-order-alert");
                                                }
                                            }
                                        }
                                    } catch (adminErr) {
                                        console.error("[Interaction] Admin alert error:", adminErr);
                                    }
                                }
                            } else {
                                console.warn(`[Interaction] FAIL: No matching ActivityLog found for incoming message from ${fromRaw}`);
                            }
                        }
                    } catch (err) {
                        console.error(`[Interaction] CRITICAL ERROR for ${fromRaw}:`, err);
                    }
                }
            });

            return { success: true, status: "initializing" };
        } catch (error) {
            console.error(`Error initializing Baileys for ${shopDomain}:`, error);
            return { success: false, error: error.message };
        }
    }

    async requestPairingCode(shopDomain, phoneNumber) {
        try {
            const formattedNumber = phoneNumber.replace(/[^0-9]/g, "");
            if (!formattedNumber) return { success: false, error: "Invalid phone number" };

            // Check if already connected
            const existingSock = this.sockets.get(shopDomain);
            if (existingSock && existingSock.user) {
                return { success: false, error: "Already connected" };
            }

            // Initialize separately without triggering the internal pairing logic
            // Ensure any existing non-functional socket is cleared
            console.log(`[${SERVICE_VERSION}] Starting fresh pairing for ${shopDomain}`);
            await this.disconnectClient(shopDomain);

            const initResult = await this.initializeClient(shopDomain);
            if (!initResult.success) {
                return initResult;
            }

            await WhatsAppSession.findOneAndUpdate(
                { shopDomain },
                { status: "pairing" }
            );

            // Wait longer for socket to be ready on Render/slower hosts
            console.log(`Waiting 5 seconds for socket handshake preparation...`);
            await new Promise(resolve => setTimeout(resolve, 5000));

            const sock = this.sockets.get(shopDomain);
            if (!sock) {
                console.error(`Socket for ${shopDomain} disappeared from Map!`);
                throw new Error("Socket not initialized");
            }

            // Check if it automatically connected (e.g. from existing /tmp auth)
            if (sock.user) {
                const user = sock.user.id.split(":")[0];
                return { success: false, error: `Already connected with ${user}` };
            }

            console.log(`Requesting pairing code for ${shopDomain} with number ${formattedNumber}`);

            // Save the phone number to merchant record during pairing
            try {
                const { Merchant } = await import("../models/Merchant.js");
                await Merchant.findOneAndUpdate(
                    { shopDomain },
                    { whatsappNumber: formattedNumber }
                );
                console.log(`Saved WhatsApp number ${formattedNumber} to merchant ${shopDomain}`);
            } catch (merchErr) {
                console.error("Error saving WhatsApp number during pairing:", merchErr);
            }

            // Request pairing code directly
            // Note: Baileys might require a little time after init before requestPairingCode works reliably
            const code = await sock.requestPairingCode(formattedNumber);
            console.log(`Pairing code for ${shopDomain}: ${code}`);

            return { success: true, pairingCode: code };
        } catch (error) {
            console.error(`Error requesting pairing code for ${shopDomain}:`, error);

            // Clean up on failure
            const sock = this.sockets.get(shopDomain);
            if (sock) {
                sock.ev.removeAllListeners();
                try { sock.end(); } catch (e) { }
                this.sockets.delete(shopDomain);
            }

            return { success: false, error: error.message || "Failed to get pairing code" };
        }
    }

    async disconnectClient(shopDomain) {
        try {
            const sock = this.sockets.get(shopDomain);
            if (sock) {
                sock.ev.removeAllListeners();
                try {
                    sock.logout();
                } catch (e) {
                    sock.end();
                }
                this.sockets.delete(shopDomain);
            }
            await WhatsAppAuth.deleteMany({ shopDomain });
            await WhatsAppSession.findOneAndUpdate(
                { shopDomain },
                { isConnected: false, status: "disconnected", qrCode: null }
            );
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    async warmupSessions() {
        try {
            console.log("Warming up active WhatsApp sessions...");
            const activeSessions = await WhatsAppSession.find({ isConnected: true });
            console.log(`Found ${activeSessions.length} active sessions to restore.`);

            for (const session of activeSessions) {
                console.log(`Restoring session for ${session.shopDomain}...`);
                this.initializeClient(session.shopDomain);
            }
        } catch (err) {
            console.error("Error during session warmup:", err);
        }
    }

    async getConnectionStatus(shopDomain) {
        const session = await WhatsAppSession.findOne({ shopDomain });
        const merchant = await Merchant.findOne({ shopDomain });
        const sock = this.sockets.get(shopDomain);
        return {
            isConnected: !!(sock?.user),
            status: session?.status || "disconnected",
            phoneNumber: session?.phoneNumber,
            deviceName: "Windows Chrome", // Baileys uses this currently
            qrCode: session?.qrCode,
            lastConnected: session?.lastConnected,
            errorMessage: session?.errorMessage,
            dailyUsage: merchant?.dailyUsage || 0,
            dailyLimit: merchant?.dailyLimit || 250,
        };
    }

    async sendMessage(shopDomain, phoneNumber, message, retryCount = 0) {
        try {
            console.log(`[WhatsApp] sendMessage called for ${shopDomain} to ${phoneNumber}${retryCount > 0 ? ` (retry ${retryCount})` : ''}`);

            // Protection: Check if merchant is blocked
            const merchant = await Merchant.findOne({ shopDomain });
            if (merchant && merchant.isActive === false) {
                console.warn(`[WhatsApp] Blocked attempt: ${shopDomain} is inactive.`);
                return { success: false, error: "Operation blocked: Account is inactive." };
            }

            const sock = this.sockets.get(shopDomain);

            if (!sock) {
                // Try to reconnect if no socket
                if (retryCount < 1) {
                    console.log(`[WhatsApp] No socket, attempting to reconnect...`);
                    await this.initializeClient(shopDomain);
                    await WhatsAppService.delay(5000);
                    return this.sendMessage(shopDomain, phoneNumber, message, retryCount + 1);
                }
                console.error(`[WhatsApp] No socket found for ${shopDomain}. Available sockets: ${Array.from(this.sockets.keys()).join(", ") || "none"}`);
                return { success: false, error: "WhatsApp not connected - no socket" };
            }

            if (!sock.user) {
                // Wait a bit if connection is initializing
                if (retryCount < 1) {
                    console.log(`[WhatsApp] Socket exists but not authenticated, waiting...`);
                    await WhatsAppService.delay(5000);
                    return this.sendMessage(shopDomain, phoneNumber, message, retryCount + 1);
                }
                console.error(`[WhatsApp] Socket exists but no user for ${shopDomain}. Connection might be initializing.`);
                return { success: false, error: "WhatsApp not connected - not authenticated" };
            }

            const formattedNumber = phoneNumber.replace(/[^0-9]/g, "");

            // 1. Check daily safety limit (Unofficial Device only)
            const canSend = await this.checkDailyLimit(shopDomain);
            if (!canSend) {
                return { success: false, error: "Daily safety limit reached for this number. Wait 24 hours or switch to WhatsApp Cloud API for unlimited sending." };
            }

            // 2. Randomize message slightly
            const safeMessage = this.randomizeMessage(message);

            // 3. Add a small human-like delay even for single messages (3 - 6 seconds for better safety)
            const randomDelay = Math.floor(Math.random() * 3000) + 3000;
            console.log(`[WhatsApp] Throttling message to ${formattedNumber} for ${randomDelay}ms...`);
            await new Promise(resolve => setTimeout(resolve, randomDelay));

            console.log(`[WhatsApp] Sending message to ${formattedNumber}@s.whatsapp.net`);

            await sock.sendMessage(`${formattedNumber}@s.whatsapp.net`, { text: safeMessage });
            console.log(`[WhatsApp] Message sent successfully to ${formattedNumber}`);
            return { success: true };
        } catch (error) {
            console.error(`[WhatsApp] Error sending message:`, error);

            // Check multiple error message locations (Baileys uses Boom errors)
            const statusCode = error.output?.statusCode || error.output?.payload?.statusCode;
            const errorMsg = error.message || error.output?.payload?.message || '';
            const isConnectionError =
                errorMsg.includes('Connection Closed') ||
                errorMsg.includes('Connection Terminated') ||
                errorMsg.includes('conflict') ||
                statusCode === 428 ||
                statusCode === 408 ||
                error.isBoom;  // All Boom errors typically mean connection issues

            // Retry on connection errors
            if (retryCount < 2 && isConnectionError) {
                console.log(`[WhatsApp] 🔄 Connection error detected (Status: ${statusCode}, Msg: ${errorMsg}). Attempting re-init and retry ${retryCount + 1}/2...`);

                // IMPORTANT: We must wait for initializeClient to actually set the new socket
                await this.initializeClient(shopDomain);

                // Give it some time to actually start Connecting
                await WhatsAppService.delay(7000);

                return this.sendMessage(shopDomain, phoneNumber, message, retryCount + 1);
            }

            return { success: false, error: errorMsg || error.message };
        }
    }

    async sendPoll(shopDomain, phoneNumber, pollName, pollOptions, retryCount = 0) {
        try {
            console.log(`[WhatsApp] sendPoll called for ${shopDomain} to ${phoneNumber}${retryCount > 0 ? ` (retry ${retryCount})` : ''}`);

            // Protection: Check if merchant is blocked
            const merchant = await Merchant.findOne({ shopDomain });
            if (merchant && merchant.isActive === false) {
                console.warn(`[WhatsApp] Blocked poll attempt: ${shopDomain} is inactive.`);
                return { success: false, error: "Operation blocked: Account is inactive." };
            }

            const sock = this.sockets.get(shopDomain);

            if (!sock) {
                // Try to reconnect if no socket
                if (retryCount < 1) {
                    console.log(`[WhatsApp] No socket for poll, attempting to reconnect...`);
                    await this.initializeClient(shopDomain);
                    await WhatsAppService.delay(5000);
                    return this.sendPoll(shopDomain, phoneNumber, pollName, pollOptions, retryCount + 1);
                }
                console.error(`[WhatsApp] No socket found for ${shopDomain}. Available sockets: ${Array.from(this.sockets.keys()).join(", ") || "none"}`);
                return { success: false, error: "WhatsApp not connected - no socket" };
            }

            if (!sock.user) {
                // Wait a bit if connection is initializing
                if (retryCount < 1) {
                    console.log(`[WhatsApp] Socket exists but not authenticated for poll, waiting...`);
                    await WhatsAppService.delay(5000);
                    return this.sendPoll(shopDomain, phoneNumber, pollName, pollOptions, retryCount + 1);
                }
                console.error(`[WhatsApp] Socket exists but no user for ${shopDomain}. Connection might be initializing.`);
                return { success: false, error: "WhatsApp not connected - not authenticated" };
            }

            const formattedNumber = phoneNumber.replace(/[^0-9]/g, "");

            // Add a small human-like delay for polls (2 - 5 seconds)
            const randomDelay = Math.floor(Math.random() * 3000) + 2000;
            console.log(`[WhatsApp] Throttling poll for ${formattedNumber} for ${randomDelay}ms...`);
            await new Promise(resolve => setTimeout(resolve, randomDelay));

            console.log(`[WhatsApp] Sending poll to ${formattedNumber}@s.whatsapp.net with options:`, pollOptions);

            await sock.sendMessage(`${formattedNumber}@s.whatsapp.net`, {
                poll: {
                    name: pollName,
                    values: pollOptions,
                    selectableCount: 1
                }
            });
            console.log(`[WhatsApp] Poll sent successfully to ${formattedNumber}`);
            return { success: true };
        } catch (error) {
            console.error(`[WhatsApp] Error sending poll:`, error);

            // Check multiple error message locations (Baileys uses Boom errors)
            const errorMsg = error.message || error.output?.payload?.message || '';
            const isConnectionError = errorMsg.includes('Connection Closed') ||
                errorMsg.includes('conflict') ||
                error.isBoom;  // All Boom errors typically mean connection issues

            // Retry on connection errors
            if (retryCount < 1 && isConnectionError) {
                console.log(`[WhatsApp] Connection error for poll (${errorMsg}), attempting re-init and retry...`);
                await this.initializeClient(shopDomain);
                await WhatsAppService.delay(5000);
                return this.sendPoll(shopDomain, phoneNumber, pollName, pollOptions, retryCount + 1);
            }

            return { success: false, error: errorMsg || error.message };
        }
    }
}

export const whatsappService = new WhatsAppService();
