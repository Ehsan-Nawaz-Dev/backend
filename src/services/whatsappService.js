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
                    await WhatsAppSession.findOneAndUpdate({ shopDomain }, { qrCode: qrCodeDataURL, status: "qr_ready" });
                    if (this.io) this.io.to(shopDomain).emit("qr", { qrCode: qrCodeDataURL });
                }

                if (connection === "close") {
                    const statusCode = (lastDisconnect?.error)?.output?.statusCode;
                    const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

                    console.log(`Connection CLOSED for ${shopDomain}. Status: ${statusCode}. Reconnecting: ${shouldReconnect}`);

                    if (shouldReconnect) {
                        // For non-logout reasons, just try to re-init after a short delay
                        setTimeout(() => this.initializeClient(shopDomain), 3000);
                    } else {
                        console.log(`Explicit logout or device removed for ${shopDomain}. Cleaning up.`);
                        this.disconnectClient(shopDomain);
                    }
                } else if (connection === "open") {
                    console.log(`WhatsApp socket ready for ${shopDomain}`);
                    const user = sock.user.id.split(":")[0];

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

                    if (this.io) {
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

                    // Basic Keyword Detection for Confirm/Reject
                    const input = text.toLowerCase().trim();
                    let tagToAdd = null;
                    let activityStatus = null;

                    if (input.includes("confirm") || input.includes("yes") || input.includes("theek")) {
                        tagToAdd = "Order Confirmed";
                        activityStatus = "confirmed";
                    } else if (input.includes("reject") || input.includes("cancel") || input.includes("no") || input.includes("nahi")) {
                        tagToAdd = "Order Rejected";
                        activityStatus = "rejected";
                    }

                    if (tagToAdd) {
                        try {
                            // 1. Find the Merchant to get Shopify Token
                            const { Merchant } = await import("../models/Merchant.js");
                            const { ActivityLog } = await import("../models/ActivityLog.js");
                            const { shopifyService } = await import("./shopifyService.js");

                            const merchant = await Merchant.findOne({ shopDomain });
                            if (!merchant || !merchant.shopifyAccessToken) continue;

                            // 2. Find the most recent ActivityLog for this phone number to get orderId
                            // Note: we look for recent 'confirmed' logs (meaning we sent a message to them)
                            const log = await ActivityLog.findOne({
                                merchant: merchant._id,
                                customerPhone: new RegExp(from.slice(-10)), // Match last 10 digits to be safe with prefixes
                                type: "confirmed"
                            }).sort({ createdAt: -1 });

                            if (log && log.orderId) {
                                console.log(`Linking reply from ${from} to Shopify Order ${log.orderId}`);
                                await shopifyService.addOrderTag(shopDomain, merchant.shopifyAccessToken, log.orderId, tagToAdd);

                                // Optional: Update activity message
                                log.message = `Customer replied: ${tagToAdd} 💬`;
                                if (activityStatus === "rejected") log.type = "failed"; // Visual feedback
                                await log.save();

                                // Auto-reply (Optional but good UX)
                                await this.sendMessage(shopDomain, from, `Thank you! Your order has been marked as: ${tagToAdd}.`);
                            }
                        } catch (err) {
                            console.error(`Error processing WhatsApp reply from ${from}:`, err);
                        }
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
            const sock = this.sockets.get(shopDomain);
            if (!sock || !sock.user) return { success: false, error: "WhatsApp not connected" };
            const formattedNumber = phoneNumber.replace(/[^0-9]/g, "");
            await sock.sendMessage(`${formattedNumber}@s.whatsapp.net`, { text: message });
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    async sendPoll(shopDomain, phoneNumber, pollName, pollOptions) {
        try {
            const sock = this.sockets.get(shopDomain);
            if (!sock || !sock.user) return { success: false, error: "WhatsApp not connected" };
            const formattedNumber = phoneNumber.replace(/[^0-9]/g, "");

            await sock.sendMessage(`${formattedNumber}@s.whatsapp.net`, {
                poll: {
                    name: pollName,
                    values: pollOptions,
                    selectableCount: 1
                }
            });
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }
}

export const whatsappService = new WhatsAppService();
