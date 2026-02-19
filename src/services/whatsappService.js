import makeWASocket, {
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    Browsers,
    getAggregateVotesInPollMessage,
    decryptPollVote,
    getKeyAuthor,
    jidNormalizedUser
} from "@whiskeysockets/baileys";
import pino from "pino";
import { WhatsAppSession } from "../models/WhatsAppSession.js";
import qrcode from "qrcode";
import { WhatsAppAuth } from "../models/WhatsAppAuth.js";
import { initAuthCreds, BufferJSON, proto } from "@whiskeysockets/baileys";
import { Merchant } from "../models/Merchant.js";
import { PollMessage } from "../models/PollMessage.js";
import crypto from "crypto";

const logger = pino({ level: "info" });
const SERVICE_VERSION = "1.0.2-diag"; // To verify deployment

class WhatsAppService {
    constructor() {
        this.sockets = new Map(); // shopDomain -> socket instance
        this.io = null; // Socket.io instance
        this.sessionMessageCounts = new Map(); // shopDomain -> message count in session
        this.cachedVersion = null; // Cache Baileys version to avoid GitHub fetch every time
        this.cachedVersionTime = 0; // Timestamp of last version fetch
        this.messageStores = new Map(); // shopDomain -> Map of msgId -> message (for poll decryption)
        this.conflictCounts = new Map(); // shopDomain -> count of consecutive conflicts
        this.pendingInits = new Set(); // shopDomain -> is initializing
        this.disconnecting = new Set(); // shopDomain -> is actively disconnecting
        this.reconnectTimeouts = new Map(); // shopDomain -> timeout ID
    }

    // Store a message in the in-memory cache (for poll vote decryption)
    storeMessage(shopDomain, msg) {
        if (!this.messageStores.has(shopDomain)) {
            this.messageStores.set(shopDomain, new Map());
        }
        const store = this.messageStores.get(shopDomain);
        store.set(msg.key.id, msg);
        // Limit store size to prevent memory leaks (keep last 500 messages)
        if (store.size > 500) {
            const firstKey = store.keys().next().value;
            store.delete(firstKey);
        }
    }

    // Persist a poll creation message to MongoDB (survives server restarts)
    async storePollMessage(shopDomain, msg, customerPhone) {
        try {
            // Store in memory too
            this.storeMessage(shopDomain, msg);
            // Persist to MongoDB using BufferJSON to handle Buffers
            const messageData = JSON.stringify(msg, BufferJSON.replacer);
            await PollMessage.findOneAndUpdate(
                { shopDomain, messageKeyId: msg.key.id },
                { shopDomain, messageKeyId: msg.key.id, messageData, customerPhone },
                { upsert: true }
            );
            console.log(`[PollStore] Saved poll message ${msg.key.id} to MongoDB for ${shopDomain}`);
        } catch (err) {
            console.error(`[PollStore] Error saving poll message to MongoDB:`, err.message);
        }
    }

    // Get a stored message by key — check memory first, then MongoDB
    async getMessageFromStore(shopDomain, key) {
        // 1. Check in-memory cache first
        const memStore = this.messageStores.get(shopDomain);
        if (memStore && key?.id) {
            const msg = memStore.get(key.id);
            if (msg) {
                console.log(`[PollStore] Found message ${key.id} in memory`);
                return msg; // Return FULL message struct for decryption
            }
        }

        // 2. Fall back to MongoDB
        if (key?.id) {
            try {
                const stored = await PollMessage.findOne({ shopDomain, messageKeyId: key.id });
                if (stored) {
                    console.log(`[PollStore] Found message ${key.id} in MongoDB, restoring...`);
                    const fullMsg = JSON.parse(stored.messageData, BufferJSON.reviver);
                    // Cache it back in memory for future lookups
                    this.storeMessage(shopDomain, fullMsg);
                    return fullMsg || undefined; // Return FULL message struct for decryption
                }
            } catch (err) {
                console.error(`[PollStore] Error loading poll message from MongoDB:`, err.message);
            }
        }

        console.warn(`[PollStore] Message ${key?.id} NOT found in memory or MongoDB`);
        return undefined;
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
        const variations = ["", " ", ".", "  ", "\u200B", "!", "...", "\u200C"]; // More natural variations
        const randomVar = variations[Math.floor(Math.random() * variations.length)];

        // 30% chance to add a natural filler at the end
        const fillers = ["", "", "", "😊", "👍", "✅", "🙏"];
        const maybeFiller = fillers[Math.floor(Math.random() * fillers.length)];

        return text + randomVar + maybeFiller;
    }

    /**
     * Simulates human typing speed based on message length.
     * Average human types 40-60 words per minute (200-300 chars/min).
     * This equals roughly 3-5 chars/second, or 200-330ms per character.
     */
    calculateTypingTime(message) {
        const messageLength = message.length;
        const charsPerSecond = 5 + Math.random() * 5; // 5-10 chars/sec (Faster)
        const typingTime = (messageLength / charsPerSecond) * 1000; // in ms

        // Cap between 1 and 5 seconds for responsiveness
        return Math.min(Math.max(typingTime, 1000), 5000);
    }

    /**
     * Human "thinking" pause before starting to type.
     * Returns a random delay between 0.5-2 seconds.
     */
    getThinkingPause() {
        return Math.floor(Math.random() * 1500) + 500;
    }

    /**
     * Progressive delay that increases as more messages are sent in current session.
     * This mimics natural human fatigue/caution.
     */
    getProgressiveDelay(sessionMessageCount) {
        // Base delay: 2-4 seconds
        let baseDelay = Math.floor(Math.random() * 2000) + 2000;

        // Add 500ms for every 15 messages sent
        const fatigueDelay = Math.floor(sessionMessageCount / 15) * 500;

        // Add random "distraction" delay (3% chance of 5-10 second pause)
        const distractionChance = Math.random();
        const distractionDelay = distractionChance < 0.03 ? Math.floor(Math.random() * 5000) + 5000 : 0;

        const totalDelay = baseDelay + fatigueDelay + distractionDelay;
        return Math.min(totalDelay, 15000); // Cap at 15 seconds max
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
            if (this.disconnecting.has(shopDomain)) return; // Block writes during disconnect
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

    /**
     * Wait for the socket to be authenticated and ready for sending.
     */
    async waitForSocket(shopDomain, timeoutMs = 15000) {
        const startTime = Date.now();
        while (Date.now() - startTime < timeoutMs) {
            const sock = this.sockets.get(shopDomain);
            if (sock && sock.user) {
                return sock;
            }
            await WhatsAppService.delay(1000);
        }
        return null;
    }

    async initializeClient(shopDomain) {
        // If already connected with a LIVE socket, don't create a new one (prevents conflict)
        // CRITICAL: We check ws.readyState because sock.user persists even after disconnection
        const existingSock = this.sockets.get(shopDomain);
        const isSocketAlive = existingSock && existingSock.user && existingSock.ws?.readyState === 1; // 1 = OPEN
        if (isSocketAlive) {
            console.log(`[WhatsApp] Already connected for ${shopDomain} (phone: ${existingSock.user.id}, ws: OPEN). Skipping re-init.`);
            return { success: true, status: "already_connected" };
        }

        if (this.pendingInits.has(shopDomain)) {
            console.log(`[WhatsApp] Skip initialize for ${shopDomain} - already in progress.`);
            return { success: true, status: "pending" };
        }
        this.pendingInits.add(shopDomain);

        // Clear any pending reconnects
        if (this.reconnectTimeouts.has(shopDomain)) {
            clearTimeout(this.reconnectTimeouts.get(shopDomain));
            this.reconnectTimeouts.delete(shopDomain);
        }

        try {
            // Close existing socket if any
            const existingSock = this.sockets.get(shopDomain);
            if (existingSock) {
                console.log(`Closing existing socket for ${shopDomain}`);
                existingSock.ev.removeAllListeners();
                try {
                    existingSock.end();
                } catch (e) {
                    // Silently fail if socket already closed
                }
                this.sockets.delete(shopDomain);
                await WhatsAppService.delay(500); // Give it a moment to clear
            }

            // Run auth state and version fetch in PARALLEL for speed
            const VERSION_CACHE_TTL = 60 * 60 * 1000; // 1 hour
            const now = Date.now();

            const [authResult, version] = await Promise.all([
                this.useMongoDBAuthState(shopDomain),
                (async () => {
                    // Use cached version if fresh (saves 2-5s GitHub fetch)
                    if (this.cachedVersion && (now - this.cachedVersionTime) < VERSION_CACHE_TTL) {
                        console.log(`[WhatsApp] Using cached Baileys version: ${JSON.stringify(this.cachedVersion)}`);
                        return this.cachedVersion;
                    }
                    try {
                        const { version: v } = await fetchLatestBaileysVersion();
                        this.cachedVersion = v;
                        this.cachedVersionTime = now;
                        console.log(`[WhatsApp] Fetched fresh Baileys version: ${JSON.stringify(v)}`);
                        return v;
                    } catch (err) {
                        console.warn(`[WhatsApp] Failed to fetch version, using fallback:`, err.message);
                        return this.cachedVersion || [2, 3000, 1015901307];
                    }
                })()
            ]);

            const { state, saveCreds } = authResult;

            const sock = makeWASocket({
                version,
                printQRInTerminal: false,
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(state.keys, logger),
                },
                logger,
                browser: ["Whatomatic Backend", "Chrome", "1.1.0"],
                connectTimeoutMs: 20000, // 20s connection timeout (faster failure detection)
                qrTimeout: 40000, // 40s QR code timeout
                getMessage: async (key) => {
                    // Required by Baileys for poll vote decryption
                    const fullMsg = await this.getMessageFromStore(shopDomain, key);
                    return fullMsg?.message || undefined;
                },
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
                        await WhatsAppSession.findOneAndUpdate({ shopDomain }, { status: "disconnected", isConnected: false });
                    } else if (isConflict) {
                        const count = (this.conflictCounts.get(shopDomain) || 0) + 1;
                        this.conflictCounts.set(shopDomain, count);

                        if (count > 5) {
                            console.error(`🚨 EXCEEDED CONFLICT RETRIES (${count}) for ${shopDomain}. Stopping to avoid BAN.`);
                            await WhatsAppSession.findOneAndUpdate(
                                { shopDomain },
                                { status: "error", isConnected: false, errorMessage: "Persistent Connection Conflict - Is the same account used elsewhere?" }
                            );
                            return;
                        }

                        // Faster backoff retry: 5s, 10s, 15s... + small jitter (conflict is usually transient)
                        const jitter = Math.floor(Math.random() * 3000);
                        const delay = (count * 5000) + jitter;
                        console.log(`Conflict #${count} detected for ${shopDomain}. Waiting ${delay / 1000} seconds before retry...`);
                        const timeout = setTimeout(() => this.initializeClient(shopDomain), delay);
                        this.reconnectTimeouts.set(shopDomain, timeout);
                    } else {
                        // Regular reconnect after 10-15 seconds (with jitter)
                        const retryDelay = 10000 + Math.floor(Math.random() * 5000);
                        console.log(`Attempting reconnect for ${shopDomain} in ${retryDelay / 1000} seconds...`);
                        const timeout = setTimeout(() => this.initializeClient(shopDomain), retryDelay);
                        this.reconnectTimeouts.set(shopDomain, timeout);
                    }

                    // 4. Notify Frontend of disconnection
                    if (this.io) {
                        const fullStatus = await this.getConnectionStatus(shopDomain);
                        this.io.to(shopDomain).emit("status_update", fullStatus);
                    }
                } else if (connection === "open") {
                    console.log(`WhatsApp socket ready for ${shopDomain}`);
                    this.conflictCounts.delete(shopDomain); // Reset on success
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
            this.pendingInits.delete(shopDomain);

            sock.ev.on("messages.upsert", async (m) => {
                if (m.type !== "notify") return;

                for (const msg of m.messages) {
                    if (!msg.message) continue;

                    // Store ALL messages in memory for poll vote decryption
                    this.storeMessage(shopDomain, msg);
                    // Also persist outgoing poll creation messages to MongoDB
                    if (msg.key.fromMe && (msg.message?.pollCreationMessage || msg.message?.pollCreationMessageV3)) {
                        this.storePollMessage(shopDomain, msg, msg.key.remoteJid?.split("@")[0].split(":")[0] || "");
                    }

                    // Skip processing our own outgoing messages
                    if (msg.key.fromMe) continue;

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
                        const { Template } = await import("../models/Template.js");

                        const merchant = await Merchant.findOne({ shopDomain });
                        if (!merchant) {
                            console.warn(`[Interaction] Merchant record NOT FOUND for ${shopDomain}`);
                            continue;
                        }
                        if (!merchant.shopifyAccessToken) {
                            console.warn(`[Interaction] Merchant FOUND but NO ACCESS TOKEN for ${shopDomain}`);
                            continue;
                        }

                        // PRE-PROCESS: Standardize phone and find ActivityLog
                        const isLidFormat = fullJid?.includes('@lid');
                        let log = null;

                        if (isLidFormat && isPollUpdate) {
                            // Focus on the most recent actionable activity for this customer on this shop
                            log = await ActivityLog.findOne({
                                merchant: merchant._id,
                                type: { $in: ["pending", "pre-cancel", "feedback-pending"] },
                                createdAt: { $gte: new Date(Date.now() - 48 * 60 * 60 * 1000) }
                            }).sort({ createdAt: -1 });
                        } else {
                            const phoneSuffix = fromCleaner.slice(-9);
                            if (phoneSuffix) {
                                log = await ActivityLog.findOne({
                                    merchant: merchant._id,
                                    customerPhone: new RegExp(phoneSuffix + "$"),
                                    type: { $in: ["pending", "pre-cancel", "feedback-pending"] }
                                }).sort({ createdAt: -1 });
                            }
                        }

                        let activityStatus = null;
                        let tagToAdd = null;

                        // Helper: Determine intent from option text
                        const isConfirmOption = (optionText) => {
                            const lower = optionText.toLowerCase();
                            return lower.includes("confirm") || lower.includes("yes") || optionText.includes("✅");
                        };
                        const isCancelOption = (optionText) => {
                            const lower = optionText.toLowerCase();
                            return lower.includes("cancel") || lower.includes("no") || optionText.includes("❌");
                        };
                        const isRatingOption = (text) => {
                            const stars = text.match(/⭐/g);
                            if (stars) return stars.length;
                            const num = parseInt(text.trim());
                            if (!isNaN(num) && num >= 1 && num <= 5) return num;
                            if (text.toLowerCase().includes("star")) {
                                const matched = text.match(/[1-5]/);
                                if (matched) return parseInt(matched[0]);
                            }
                            return null;
                        };

                        // Process intent from known selected option text/index in given context
                        const processSelectedOption = (selectedText, isPreCancelCtx, optionIndex = -1) => {
                            const getTagWithEmoji = (tag, defaultTag, emoji) => {
                                const finalTag = tag || defaultTag;
                                if (finalTag.includes(emoji)) return finalTag;
                                if (/[\u{1F300}-\u{1F9FF}]/u.test(finalTag)) return finalTag;
                                return `${emoji} ${finalTag}`;
                            };

                            // Priority 1: Use Position (Index) if available for better custom label support
                            if (optionIndex !== -1) {
                                if (isPreCancelCtx) {
                                    // Pre-Cancel Poll: [0] "Yes, Cancel", [1] "No, Keep"
                                    if (optionIndex === 0) return { status: "cancelled", tag: getTagWithEmoji(merchant.orderCancelTag, "Order Cancelled", "❌") };
                                    if (optionIndex === 1) return { status: "confirmed", tag: getTagWithEmoji(merchant.orderConfirmTag, "Order Confirmed", "✅") };
                                } else {
                                    // Normal Poll: [0] "Yes, Confirm", [1] "No, Cancel"
                                    if (optionIndex === 0) return { status: "confirmed", tag: getTagWithEmoji(merchant.orderConfirmTag, "Order Confirmed", "✅") };
                                    if (optionIndex === 1) return { status: "cancelled", tag: getTagWithEmoji(merchant.orderCancelTag, "Order Cancelled", "❌") };
                                }
                            }

                            // Priority 2: Keyword Fallback (if no index or index > 1)
                            if (isPreCancelCtx) {
                                if (selectedText.toLowerCase().includes("no") || selectedText.includes("✅") || selectedText.toLowerCase().includes("keep") || selectedText.includes("Ghalti")) {
                                    return { status: "confirmed", tag: getTagWithEmoji(merchant.orderConfirmTag, "Order Confirmed", "✅") };
                                } else {
                                    return { status: "cancelled", tag: getTagWithEmoji(merchant.orderCancelTag, "Order Cancelled", "❌") };
                                }
                            } else {
                                if (isConfirmOption(selectedText)) {
                                    return { status: "confirmed", tag: getTagWithEmoji(merchant.orderConfirmTag, "Order Confirmed", "✅") };
                                } else if (isCancelOption(selectedText)) {
                                    return { status: "cancelled", tag: getTagWithEmoji(merchant.orderCancelTag, "Order Cancelled", "❌") };
                                }
                            }
                            return null;
                        };

                        // 1. Detect Intent (Poll or Text)
                        if (isPollUpdate) {
                            console.log(`[Interaction] Processing poll update from ${fromRaw}`);
                            const pollUpdate = msg.message.pollUpdateMessage;
                            const pollCreationKey = pollUpdate?.pollCreationMessageKey;
                            const isPreCancelContext = log?.type === "pre-cancel";
                            const isFeedbackContext = log?.type === "feedback-pending";

                            // ===== METHOD A: Baileys Decryption (Correct 2-arg API) =====
                            try {
                                const sock = this.sockets.get(shopDomain);
                                if (sock && pollCreationKey) {
                                    // Fetch FULL WAMessage wrapper from store
                                    const pollCreationWrapper = await this.getMessageFromStore(shopDomain, pollCreationKey);

                                    if (pollCreationWrapper) {
                                        console.log(`[Interaction] Found original poll message in store (key: ${pollCreationKey.id})`);

                                        const pollMsgContent = pollCreationWrapper.message;
                                        // The encryption key is stored in messageContextInfo.messageSecret
                                        const pollEncKey = pollCreationWrapper.messageContextInfo?.messageSecret
                                            || pollMsgContent?.messageContextInfo?.messageSecret;

                                        if (!pollMsgContent) {
                                            console.warn(`[Interaction] Poll message wrapper exists but .message is missing!`);
                                        } else if (!pollEncKey) {
                                            console.warn(`[Interaction] Poll message found but messageSecret (pollEncKey) is missing! Cannot decrypt.`);
                                            console.log(`[Interaction] Wrapper keys: ${Object.keys(pollCreationWrapper).join(', ')}`);
                                            console.log(`[Interaction] Message keys: ${Object.keys(pollMsgContent).join(', ')}`);
                                            if (pollMsgContent.messageContextInfo) {
                                                console.log(`[Interaction] messageContextInfo keys: ${Object.keys(pollMsgContent.messageContextInfo).join(', ')}`);
                                            }
                                        } else {
                                            // Use Baileys' getKeyAuthor for correct JID resolution
                                            const meId = jidNormalizedUser(sock.user?.id);
                                            // const pollCreatorJid = getKeyAuthor(pollCreationWrapper.key, meId);
                                            // const voterJid = getKeyAuthor(msg.key, meId);

                                            // Candidate JIDs for Creator (Me) and Voter
                                            // WhatsApp uses both PN (Phone Number) and LID (Lookup ID).
                                            // Encryption might use either, causing AAD mismatch if we guess wrong.

                                            // Helper to generate variants: Raw, Normalized (no device), and Agent 0
                                            const generateJidVariants = (jid) => {
                                                if (!jid) return [];
                                                const variants = [jid];
                                                const normalized = jidNormalizedUser(jid); // Strips device
                                                if (normalized !== jid) variants.push(normalized);

                                                // If LID, maybe it needs explicit :0 device? 
                                                // Or if it has :0, maybe it needs to be stripped? 
                                                // We just try both normalized and raw.
                                                return variants;
                                            };

                                            const rawCreatorCandidates = [
                                                getKeyAuthor(pollCreationWrapper.key, meId), // Canonical
                                                sock.authState?.creds?.me?.lid,             // My LID (often has device)
                                                pollCreationWrapper.key.remoteJid,           // Remote Jid (might be me if self-chat)
                                                pollCreationWrapper.key.participant          // Participant (in group)
                                            ].filter(Boolean);

                                            const rawVoterCandidates = [
                                                getKeyAuthor(msg.key, meId),       // Canonical (often PN)
                                                msg.key.remoteJid,                 // Raw remote (often LID)
                                                msg.key.participant,               // Raw participant
                                            ].filter(Boolean);

                                            // Flatten and deduplicate
                                            let uniqueCreators = [...new Set(rawCreatorCandidates.flatMap(generateJidVariants))];
                                            let uniqueVoters = [...new Set(rawVoterCandidates.flatMap(generateJidVariants))];

                                            // Ensure we don't have empty strings
                                            uniqueCreators = uniqueCreators.filter(j => j && j.includes('@'));
                                            uniqueVoters = uniqueVoters.filter(j => j && j.includes('@'));

                                            console.log(`[Interaction] Decrypt candidates (Exhaustive):`);
                                            console.log(`[Interaction]   Creators: ${uniqueCreators.join(', ')}`);
                                            console.log(`[Interaction]   Voters:   ${uniqueVoters.join(', ')}`);

                                            let pollVote = null;
                                            let decryptionSuccess = false;

                                            // Brute-force retry loop
                                            outerLoop:
                                            for (const creatorJid of uniqueCreators) {
                                                for (const voterJid of uniqueVoters) {
                                                    try {
                                                        // console.log(`[Interaction] Trying decrypt with Creator: ${creatorJid} | Voter: ${voterJid}`);
                                                        pollVote = decryptPollVote(
                                                            pollUpdate.vote,
                                                            {
                                                                pollCreatorJid: creatorJid,
                                                                pollMsgId: pollCreationKey.id,
                                                                pollEncKey,
                                                                voterJid: voterJid,
                                                            }
                                                        );
                                                        if (pollVote) {
                                                            console.log(`[Interaction] ✅ Decryption passed with Creator: ${creatorJid} | Voter: ${voterJid}`);
                                                            decryptionSuccess = true;
                                                            break outerLoop;
                                                        }
                                                    } catch (e) {
                                                        // Ignore specific failures and continue trying
                                                    }
                                                }
                                            }

                                            if (!decryptionSuccess) {
                                                console.warn(`[Interaction] Decryption failed with all JID combinations.`);
                                                // Log the error from the primary candidate pair for context
                                                try {
                                                    const primaryCreator = uniqueCreators[0];
                                                    const primaryVoter = uniqueVoters[0];
                                                    decryptPollVote(
                                                        pollUpdate.vote,
                                                        {
                                                            pollCreatorJid: primaryCreator,
                                                            pollMsgId: pollCreationKey.id,
                                                            pollEncKey,
                                                            voterJid: primaryVoter
                                                        }
                                                    );
                                                } catch (finalErr) {
                                                    console.warn(`[Interaction] Primary decryption error: ${finalErr.message}`);
                                                }
                                            }

                                            if (pollVote && pollVote.selectedOptions) {
                                                console.log(`[Interaction] Decrypted vote selectedOptions count: ${pollVote.selectedOptions.length}`);

                                                // Get original options from the stored poll creation message
                                                const originalOptions = (pollMsgContent.pollCreationMessage || pollMsgContent.pollCreationMessageV3)?.options || [];
                                                const getOptionText = (opt) => opt.optionName || opt;

                                                // selectedOptions from decryptPollVote are SHA256 hashes of the option text
                                                const selectedHashes = pollVote.selectedOptions.map(h => Buffer.from(h).toString('hex').toUpperCase());
                                                // console.log(`[Interaction] Decrypted vote hashes: ${selectedHashes.map(h => h.substring(0, 16) + '...').join(', ')}`);

                                                if (selectedHashes.length > 0) {
                                                    for (let i = 0; i < originalOptions.length; i++) {
                                                        const optObj = originalOptions[i];
                                                        const optText = getOptionText(optObj);
                                                        const optHash = crypto.createHash('sha256').update(optText, 'utf8').digest('hex').toUpperCase();

                                                        if (selectedHashes.includes(optHash)) {
                                                            console.log(`[Interaction] ✅ Decrypted Match: "${optText}" (Index: ${i})`);
                                                            const result = processSelectedOption(optText, isPreCancelContext, i);
                                                            if (result) {
                                                                activityStatus = result.status;
                                                                tagToAdd = result.tag;
                                                                console.log(`[Interaction] Decryption SUCCESS: ${activityStatus}`);
                                                                break;
                                                            }

                                                            // Handle Rating in Poll
                                                            if (isFeedbackContext) {
                                                                const rating = isRatingOption(optText);
                                                                if (rating) {
                                                                    activityStatus = "rated";
                                                                    tagToAdd = `Rating: ${rating}/5`;
                                                                    log.metadata = { ...log.metadata, rating };
                                                                    break;
                                                                }
                                                            }
                                                        }
                                                    }
                                                }
                                            } else if (!decryptionSuccess) {
                                                // Don't log "returned no selectedOptions" if we already knew it failed
                                            } else {
                                                console.warn(`[Interaction] decryptPollVote returned no selectedOptions`);
                                            }
                                        }
                                    } else {
                                        console.warn(`[Interaction] Original poll message NOT found in store (key: ${pollCreationKey?.id})`);
                                    }
                                }
                            } catch (decryptErr) {
                                console.warn(`[Interaction] Decryption failed:`, decryptErr.message);
                                console.warn(`[Interaction] Decryption stack:`, decryptErr.stack);
                            }

                            // ===== METHOD B: SHA-256 Hash Matching (fallback) =====
                            if (!activityStatus) {
                                console.log(`[Interaction] Trying SHA-256 hash matching...`);
                                const vote = pollUpdate?.vote;
                                const selectedHashes = vote?.selectedOptions || [];
                                const firstHash = selectedHashes[0] ? Buffer.from(selectedHashes[0]).toString('hex').toUpperCase() : null;

                                if (firstHash) {
                                    console.log(`[Interaction] Vote hash: ${firstHash}`);

                                    const templateEvent = isPreCancelContext ? "orders/cancel_verify" : "orders/create";
                                    const template = await Template.findOne({ merchant: merchant._id, event: templateEvent });
                                    const options = isPreCancelContext
                                        ? (template?.pollOptions || ["🗑️ Yes, Cancel Order", "✅ No, Keep Order"])
                                        : (template?.isPoll ? template.pollOptions : ["✅ Yes, Confirm", "❌ No, Cancel"]);

                                    for (let i = 0; i < options.length; i++) {
                                        const option = options[i];
                                        const hashMethods = [
                                            crypto.createHash('sha256').update(option, 'utf8').digest('hex').toUpperCase(),
                                            crypto.createHash('sha256').update(Buffer.from(option, 'utf16le')).digest('hex').toUpperCase(),
                                            crypto.createHash('sha256').update(option, 'binary').digest('hex').toUpperCase(),
                                        ];
                                        console.log(`[Interaction] Option "${option}" index: ${i}`);

                                        if (hashMethods.includes(firstHash)) {
                                            console.log(`[Interaction] Hash match found for: "${option}" (Index: ${i})`);
                                            const result = processSelectedOption(option, isPreCancelContext, i);
                                            if (result) {
                                                activityStatus = result.status;
                                                tagToAdd = result.tag;
                                            }

                                            if (isFeedbackContext && !activityStatus) {
                                                const rating = isRatingOption(option);
                                                if (rating) {
                                                    activityStatus = "rated";
                                                    tagToAdd = `Rating: ${rating}/5`;
                                                    log.metadata = { ...log.metadata, rating };
                                                }
                                            }
                                            break;
                                        }
                                    }
                                }
                            }

                            // ===== METHOD C: NO DEFAULT — require explicit match =====
                            if (!activityStatus) {
                                console.warn(`[Interaction] ⚠️ All poll detection methods FAILED! NOT taking any action to avoid misinterpretation.`);
                                console.warn(`[Interaction] The vote could not be decrypted. Order status will remain unchanged.`);
                            }
                        } else {
                            // 2. Basic Keyword Detection (Text messages)
                            const input = text.toLowerCase().trim();
                            const isPreCancelContext = log?.type === "pre-cancel";

                            if (!activityStatus) {
                                if (input.includes("confirm") || input.includes("yes") || input.includes("theek") || input.includes("haan") || input.includes("sahi")) {
                                    // "Yes" always means Confirm in normal, but in pre-cancel it means "Yes, cancel"
                                    if (isPreCancelContext) {
                                        activityStatus = "cancelled";
                                        tagToAdd = merchant.orderCancelTag || "Order Cancelled";
                                    } else {
                                        activityStatus = "confirmed";
                                        tagToAdd = merchant.orderConfirmTag || "Order Confirmed";
                                    }
                                } else if (input.includes("reject") || input.includes("cancel") || input.includes("no") || input.includes("nahi") || input.includes("wrong") || input.includes("dont") || input.includes("don't")) {
                                    // "No" or "Cancel" in normal context means Cancel.
                                    // But "No" in pre-cancel context ("Are you sure?") means "No, don't cancel" -> Confirmed
                                    if (isPreCancelContext && (input.includes("no") || input.includes("nahi") || input.includes("dont") || input.includes("don't"))) {
                                        activityStatus = "confirmed";
                                        tagToAdd = merchant.orderConfirmTag || "Order Confirmed";
                                    } else {
                                        activityStatus = "cancelled";
                                        tagToAdd = merchant.orderCancelTag || "Order Cancelled";
                                    }
                                }
                            }
                        }

                        // 2. PROCESS INTENT
                        if (activityStatus && tagToAdd && log && log.orderId) {
                            console.log(`[Interaction] SUCCESS: Order ${log.orderId}. Intent: ${activityStatus}. Current Log Type: ${log.type}`);

                            const targetPhone = log.customerPhone || fromRaw;

                            // A. DOUBLE-CONFIRM FLOW FOR CANCELLATION
                            if (activityStatus === "cancelled" && log.type === "pending") {
                                console.log(`[Interaction] Sending Pre-Cancel verification to ${targetPhone}`);

                                const verifyTemplate = await Template.findOne({ merchant: merchant._id, event: "orders/cancel_verify" });
                                let preCancelMsg = verifyTemplate?.message || "Are you sure you want to cancel your order? ❌\n\nThis will stop your order from being processed immediately.";
                                const preCancelOptions = verifyTemplate?.pollOptions || ["🗑️ Yes, Cancel Order", "✅ No, Keep Order"];

                                // Replace placeholders if any in verify message
                                if (preCancelMsg.includes("{{")) {
                                    const { replacePlaceholders } = await import("../utils/placeholderHelper.js");
                                    const orderData = await shopifyService.getOrder(shopDomain, merchant.shopifyAccessToken, log.orderId);
                                    if (orderData) {
                                        preCancelMsg = replacePlaceholders(preCancelMsg, { order: orderData, merchant });
                                    }
                                }

                                await this.sendPoll(shopDomain, targetPhone, preCancelMsg, preCancelOptions);

                                log.type = "pre-cancel";
                                log.message = "Customer clicked Cancel. Verification poll sent. 🛑";
                                await log.save();
                                return; // Stop here, wait for second poll response
                            }


                            // B. FINAL PROCESSING (Confirmation or Verified Cancellation)
                            const isConfirm = activityStatus === "confirmed";

                            // Robust tag removal: Handle plain tags, emoji tags, and legacy defaults
                            const getTagVariants = (tag, emoji) => {
                                if (!tag) return [];
                                const variants = [tag]; // Raw from DB
                                if (emoji && !tag.includes(emoji)) {
                                    variants.push(`${emoji} ${tag}`); // With emoji
                                }
                                return variants;
                            };

                            const pendingTags = [
                                ...getTagVariants(merchant.pendingConfirmTag, "🕒"),
                                "Pending Confirmation",
                                "Pending Order Confirmation"
                            ];

                            const cancelTags = [
                                ...getTagVariants(merchant.orderCancelTag, "❌"),
                                "Order Cancelled",
                                "Order Cancel By customer"
                            ];

                            const confirmTags = [
                                ...getTagVariants(merchant.orderConfirmTag, "✅"),
                                "Order Confirmed"
                            ];

                            const uniqueTagsToRemove = [...new Set(
                                isConfirm
                                    ? [...pendingTags, ...cancelTags]
                                    : [...pendingTags, ...confirmTags]
                            )];

                            const tagsToRemove = uniqueTagsToRemove;

                            // 1. Attempt Shopify Tagging (Background)
                            try {
                                console.log(`[Interaction] Tagging Shopify Order ${log.orderId} as ${activityStatus}...`);
                                const tagResult = await shopifyService.addOrderTag(shopDomain, merchant.shopifyAccessToken, log.orderId, tagToAdd, tagsToRemove);

                                if (tagResult.success) {
                                    log.message = isConfirm ? `Customer confirmed via WhatsApp ✅` : `Customer requested cancellation ❌`;
                                    log.type = activityStatus;
                                    await log.save();
                                }
                            } catch (tagErr) {
                                console.error("[Interaction] Tagging Error:", tagErr.message);
                            }

                            // 2. Send Customer Reply
                            await WhatsAppService.delay(1000);

                            let replyText;
                            if (isConfirm) {
                                try {
                                    const confirmTemplate = await Template.findOne({ merchant: merchant._id, event: "orders/confirmed" });
                                    if (confirmTemplate) {
                                        const orderData = await shopifyService.getOrder(shopDomain, merchant.shopifyAccessToken, log.orderId);
                                        if (orderData) {
                                            const { replacePlaceholders } = await import("../utils/placeholderHelper.js");
                                            replyText = replacePlaceholders(confirmTemplate.message, { order: orderData, merchant });
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
                                try {
                                    const cancelTemplate = await Template.findOne({ merchant: merchant._id, event: "orders/cancelled" });
                                    if (cancelTemplate) {
                                        const orderData = await shopifyService.getOrder(shopDomain, merchant.shopifyAccessToken, log.orderId);
                                        if (orderData) {
                                            const { replacePlaceholders } = await import("../utils/placeholderHelper.js");
                                            replyText = replacePlaceholders(cancelTemplate.message, { order: orderData, merchant });
                                        } else {
                                            replyText = merchant.orderCancelReply || "Your order has been cancelled. ❌";
                                        }
                                    } else {
                                        replyText = merchant.orderCancelReply || "Your order has been cancelled. ❌";
                                    }
                                } catch (err) {
                                    replyText = merchant.orderCancelReply || "Your order has been cancelled. ❌";
                                }
                            }

                            console.log(`[Interaction] Sending reply to: ${targetPhone}`);
                            await this.sendMessage(shopDomain, targetPhone, replyText);

                            // 3. Trigger Admin Alert (only if confirm)
                            if (isConfirm) {
                                await WhatsAppService.delay(2000);
                                try {
                                    const { AutomationSetting } = await import("../models/AutomationSetting.js");
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
                        }
                    } catch (err) {
                        console.error(`[Interaction] CRITICAL ERROR for ${fromRaw}:`, err);
                    }
                }
            });

            return { success: true, status: "initializing" };
        } catch (error) {
            this.pendingInits.delete(shopDomain);
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
        this.disconnecting.add(shopDomain);

        // Cancel any pending reconnects
        if (this.reconnectTimeouts.has(shopDomain)) {
            clearTimeout(this.reconnectTimeouts.get(shopDomain));
            this.reconnectTimeouts.delete(shopDomain);
        }

        try {
            const sock = this.sockets.get(shopDomain);
            if (sock) {
                sock.ev.removeAllListeners();
                try {
                    // Try graceful logout first
                    if (sock.logout) await sock.logout();
                } catch (e) {
                    console.warn(`[Disconnect] Logout failed for ${shopDomain}, forcing close.`);
                }
                try {
                    sock.end();
                } catch (e) {
                    // ignore
                }
                this.sockets.delete(shopDomain);
            }

            await WhatsAppAuth.deleteMany({ shopDomain });
            await WhatsAppSession.findOneAndUpdate(
                { shopDomain },
                { isConnected: false, status: "disconnected", qrCode: null }
            );

            // Wait a moment to ensure no stray writes occur
            await WhatsAppService.delay(1000);
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        } finally {
            this.disconnecting.delete(shopDomain);
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
                // Stagger connections for SAAS stability (3s delay)
                await WhatsAppService.delay(3000);
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

    /**
     * Checks if a phone number exists on WhatsApp.
     */
    async checkWhatsApp(shopDomain, phoneNumber) {
        try {
            const sock = this.sockets.get(shopDomain);
            if (!sock || !sock.user) return { exists: false, error: "Not connected" };

            const formatted = phoneNumber.replace(/\D/g, "");
            const [result] = await sock.onWhatsApp(`${formatted}@s.whatsapp.net`);
            return { exists: !!(result?.exists), jid: result?.jid };
        } catch (err) {
            console.error(`[WhatsApp] checkWhatsApp error for ${phoneNumber}:`, err.message);
            return { exists: false, error: err.message };
        }
    }

    async sendMessage(shopDomain, phoneNumber, message, retryCount = 0) {
        try {
            console.log(`[WhatsApp] sendMessage called for ${shopDomain} to ${phoneNumber}${retryCount > 0 ? ` (retry ${retryCount})` : ''}`);

            const merchant = await Merchant.findOne({ shopDomain });
            if (merchant && merchant.isActive === false) {
                console.warn(`[WhatsApp] Blocked attempt: ${shopDomain} is inactive.`);
                return { success: false, error: "Operation blocked: Account is inactive." };
            }

            // 1. Daily Limit Check
            const canSend = await this.checkDailyLimit(shopDomain);
            if (!canSend) {
                return { success: false, error: "Daily safety limit reached for this number. Wait 24 hours or switch to WhatsApp Cloud API for unlimited sending." };
            }

            // 2. Socket Readiness
            let sock = this.sockets.get(shopDomain);
            if (!sock || !sock.user) {
                console.log(`[WhatsApp] Socket not ready for ${shopDomain}, waiting...`);
                sock = await this.waitForSocket(shopDomain, 10000); // 10s wait
            }

            if (!sock || !sock.user) {
                if (retryCount < 2) {
                    // Only auto-reconnect if NOT explicitly disconnected
                    const session = await WhatsAppSession.findOne({ shopDomain });
                    if (session?.status === 'disconnected') {
                        console.warn(`[WhatsApp] Skip auto-connect for ${shopDomain}: Explicitly disconnected.`);
                        return { success: false, error: "WhatsApp is disconnected. Please connect again from dashboard." };
                    }

                    console.log(`[WhatsApp] Forced Re-init for ${shopDomain} (Retry ${retryCount + 1}/2)`);
                    // Clear stale socket before re-init
                    const staleSock = this.sockets.get(shopDomain);
                    if (staleSock) {
                        staleSock.ev?.removeAllListeners();
                        try { staleSock.end(); } catch (e) { /* ignore */ }
                        this.sockets.delete(shopDomain);
                    }
                    this.pendingInits.delete(shopDomain);
                    await this.initializeClient(shopDomain);
                    await WhatsAppService.delay(10000);
                    return this.sendMessage(shopDomain, phoneNumber, message, retryCount + 1);
                }
                return { success: false, error: "WhatsApp connection timeout - check phone device" };
            }

            const formattedNumber = phoneNumber.replace(/[^0-9]/g, "");
            const safeMessage = this.randomizeMessage(message);

            // 3. ADVANCED HUMAN SIMULATION
            // Track session message count
            const sessionCount = this.sessionMessageCounts.get(shopDomain) || 0;
            this.sessionMessageCounts.set(shopDomain, sessionCount + 1);

            // 3a. Thinking pause (human reads before replying)
            const thinkingPause = this.getThinkingPause();
            console.log(`[WhatsApp] 🤔 Thinking pause: ${thinkingPause}ms`);
            await new Promise(resolve => setTimeout(resolve, thinkingPause));

            // 3b. Typing simulation based on message length
            const typingTime = this.calculateTypingTime(safeMessage);
            console.log(`[WhatsApp] ⌨️  Typing simulation: ${typingTime}ms (${safeMessage.length} chars)`);
            await new Promise(resolve => setTimeout(resolve, typingTime));

            // 3c. Progressive delay (increases with session activity)
            const progressiveDelay = this.getProgressiveDelay(sessionCount);
            console.log(`[WhatsApp] ⏱️  Progressive delay: ${progressiveDelay}ms (session msg #${sessionCount + 1})`);
            await new Promise(resolve => setTimeout(resolve, progressiveDelay));

            try {
                console.log(`[WhatsApp] 📤 Sending message to ${formattedNumber}@s.whatsapp.net`);
                await sock.sendMessage(`${formattedNumber}@s.whatsapp.net`, { text: safeMessage });
                console.log(`[WhatsApp] ✅ Message sent successfully to ${formattedNumber}`);
                return { success: true };
            } catch (innerError) {
                const statusCode = innerError.output?.statusCode || innerError.output?.payload?.statusCode;
                const errorMsg = innerError.message || innerError.output?.payload?.message || '';
                const isConnectionError = errorMsg.includes('Connection Closed') || statusCode === 428 || innerError.isBoom;

                if (retryCount < 2 && isConnectionError) {
                    console.warn(`[WhatsApp] Connection error (428). Clearing stale socket and retrying ${retryCount + 1}/2...`);
                    // Clear stale socket before re-init
                    const staleSock = this.sockets.get(shopDomain);
                    if (staleSock) {
                        staleSock.ev?.removeAllListeners();
                        try { staleSock.end(); } catch (e) { /* ignore */ }
                        this.sockets.delete(shopDomain);
                    }
                    this.pendingInits.delete(shopDomain);
                    await this.initializeClient(shopDomain);
                    await WhatsAppService.delay(10000);
                    return this.sendMessage(shopDomain, phoneNumber, message, retryCount + 1);
                }
                throw innerError;
            }
        } catch (error) {
            console.error(`[WhatsApp] sendMessage CRITICAL error:`, error);
            return { success: false, error: error.message || "Unknown error" };
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

            const sentMsg = await sock.sendMessage(`${formattedNumber}@s.whatsapp.net`, {
                poll: {
                    name: pollName,
                    values: pollOptions,
                    selectableCount: 1
                }
            });
            // Store the sent poll message so we can decrypt vote responses later
            if (sentMsg) {
                await this.storePollMessage(shopDomain, sentMsg, formattedNumber);
                console.log(`[WhatsApp] Poll sent and stored in MongoDB (key: ${sentMsg.key?.id}) for vote decryption`);
            }
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
                console.log(`[WhatsApp] Connection error for poll (${errorMsg}), clearing stale socket and re-initializing...`);

                // IMPORTANT: Clear the stale/dead socket so initializeClient creates a fresh one
                const staleSock = this.sockets.get(shopDomain);
                if (staleSock) {
                    staleSock.ev?.removeAllListeners();
                    try { staleSock.end(); } catch (e) { /* ignore */ }
                    this.sockets.delete(shopDomain);
                }
                this.pendingInits.delete(shopDomain); // Clear any pending init flag too

                await this.initializeClient(shopDomain);
                await WhatsAppService.delay(8000); // Wait longer for fresh connection to stabilize
                return this.sendPoll(shopDomain, phoneNumber, pollName, pollOptions, retryCount + 1);
            }

            return { success: false, error: errorMsg || error.message };
        }
    }
}

export const whatsappService = new WhatsAppService();
