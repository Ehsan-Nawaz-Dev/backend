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
import fs from "fs";
import path from "path";
import os from "os";

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

    setSocketIO(io) {
        this.io = io;
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

            const authPath = path.join(process.cwd(), "whatsapp_auth", shopDomain);
            const { state, saveCreds } = await useMultiFileAuthState(authPath);
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

                    const from = msg.key.remoteJid.split("@")[0];
                    const text = msg.message.conversation || msg.message.extendedTextMessage?.text || "";

                    console.log(`Incoming message from ${from} (${shopDomain}): ${text}`);

                    try {
                        const { Merchant } = await import("../models/Merchant.js");
                        const { ActivityLog } = await import("../models/ActivityLog.js");
                        const { shopifyService } = await import("./shopifyService.js");

                        const merchant = await Merchant.findOne({ shopDomain });
                        if (!merchant || !merchant.shopifyAccessToken) continue;

                        let activityStatus = null;
                        let tagToAdd = null;

                        // 1. Detect Poll Response (Baileys poll update)
                        if (msg.message?.pollUpdateMessage) {
                            // Conceptual logic: default to confirm if interaction happens
                            activityStatus = "confirmed";
                            tagToAdd = merchant.orderConfirmTag || "Order Confirmed";
                        } else {
                            // 2. Basic Keyword Detection (Text messages)
                            const input = text.toLowerCase().trim();
                            if (input.includes("confirm") || input.includes("yes") || input.includes("theek")) {
                                activityStatus = "confirmed";
                                tagToAdd = merchant.orderConfirmTag || "Order Confirmed";
                            } else if (input.includes("reject") || input.includes("cancel") || input.includes("no") || input.includes("nahi")) {
                                activityStatus = "cancelled";
                                tagToAdd = merchant.orderCancelTag || "Order Cancelled";
                            }
                        }

                        if (activityStatus && tagToAdd) {
                            // Find the most recent "confirmed" (pending) log to link this reply
                            const log = await ActivityLog.findOne({
                                merchant: merchant._id,
                                customerPhone: new RegExp(from.slice(-10))
                            }).sort({ createdAt: -1 });

                            if (log && log.orderId) {
                                console.log(`Linking ${activityStatus} reply from ${from} to Order ${log.orderId}`);

                                const isConfirm = activityStatus === "confirmed";
                                const tagsToRemove = isConfirm
                                    ? [merchant.pendingConfirmTag, merchant.orderCancelTag]
                                    : [merchant.pendingConfirmTag, merchant.orderConfirmTag];

                                await shopifyService.addOrderTag(shopDomain, merchant.shopifyAccessToken, log.orderId, tagToAdd, tagsToRemove);

                                // Update activity log
                                log.message = `Customer replied: ${tagToAdd} 💬`;
                                log.type = activityStatus;
                                await log.save();

                                // Send Customer Reply (2s delay for demo)
                                await WhatsAppService.delay(2000);
                                const replyText = isConfirm
                                    ? (merchant.orderConfirmReply || "Your order is confirmed, thank you! ✅")
                                    : (merchant.orderCancelReply || "Your order has been cancelled. ❌");
                                await this.sendMessage(shopDomain, from, replyText);

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
                                        console.error("Error triggering admin alert:", adminErr);
                                    }
                                }
                            }
                        }
                    } catch (err) {
                        console.error(`Error handling WhatsApp interaction from ${from}:`, err);
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
            const authPath = path.join(process.cwd(), "whatsapp_auth", shopDomain);
            if (fs.existsSync(authPath)) {
                fs.rmSync(authPath, { recursive: true, force: true });
            }
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
        const sock = this.sockets.get(shopDomain);
        return {
            isConnected: !!(sock?.user),
            status: session?.status || "disconnected",
            phoneNumber: session?.phoneNumber,
            deviceName: "Windows Chrome", // Baileys uses this currently
            qrCode: session?.qrCode,
            lastConnected: session?.lastConnected,
            errorMessage: session?.errorMessage,
        };
    }

    async sendMessage(shopDomain, phoneNumber, message) {
        try {
            console.log(`[WhatsApp] sendMessage called for ${shopDomain} to ${phoneNumber}`);
            const sock = this.sockets.get(shopDomain);

            if (!sock) {
                console.error(`[WhatsApp] No socket found for ${shopDomain}. Available sockets: ${Array.from(this.sockets.keys()).join(", ") || "none"}`);
                return { success: false, error: "WhatsApp not connected - no socket" };
            }

            if (!sock.user) {
                console.error(`[WhatsApp] Socket exists but no user for ${shopDomain}. Connection might be initializing.`);
                return { success: false, error: "WhatsApp not connected - not authenticated" };
            }

            const formattedNumber = phoneNumber.replace(/[^0-9]/g, "");
            console.log(`[WhatsApp] Sending message to ${formattedNumber}@s.whatsapp.net`);

            await sock.sendMessage(`${formattedNumber}@s.whatsapp.net`, { text: message });
            console.log(`[WhatsApp] Message sent successfully to ${formattedNumber}`);
            return { success: true };
        } catch (error) {
            console.error(`[WhatsApp] Error sending message:`, error);
            return { success: false, error: error.message };
        }
    }

    async sendPoll(shopDomain, phoneNumber, pollName, pollOptions) {
        try {
            console.log(`[WhatsApp] sendPoll called for ${shopDomain} to ${phoneNumber}`);
            const sock = this.sockets.get(shopDomain);

            if (!sock) {
                console.error(`[WhatsApp] No socket found for ${shopDomain}. Available sockets: ${Array.from(this.sockets.keys()).join(", ") || "none"}`);
                return { success: false, error: "WhatsApp not connected - no socket" };
            }

            if (!sock.user) {
                console.error(`[WhatsApp] Socket exists but no user for ${shopDomain}. Connection might be initializing.`);
                return { success: false, error: "WhatsApp not connected - not authenticated" };
            }

            const formattedNumber = phoneNumber.replace(/[^0-9]/g, "");
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
            return { success: false, error: error.message };
        }
    }
}

export const whatsappService = new WhatsAppService();
