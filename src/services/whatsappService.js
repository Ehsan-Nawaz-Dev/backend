import makeWASocket, {
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore
} from "@whiskeysockets/baileys";
import pino from "pino";
import { WhatsAppSession } from "../models/WhatsAppSession.js";
import qrcode from "qrcode";
import fs from "fs";
import path from "path";
import os from "os";

const logger = pino({ level: "info" });

class WhatsAppService {
    constructor() {
        this.sockets = new Map(); // shopDomain -> socket instance
        this.io = null; // Socket.io instance
    }

    setSocketIO(io) {
        this.io = io;
    }

    async initializeClient(shopDomain) {
        try {
            const authPath = path.join(os.tmpdir(), "auth_info", shopDomain);
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
                browser: ["WhatFlow", "Chrome", "1.0.0"],
            });

            this.sockets.set(shopDomain, sock);

            // Update session status to connecting
            await WhatsAppSession.findOneAndUpdate(
                { shopDomain },
                {
                    sessionId: shopDomain,
                    status: "connecting",
                    isConnected: false,
                    qrCode: null,
                },
                { upsert: true, new: true }
            );

            sock.ev.on("connection.update", async (update) => {
                const { connection, lastDisconnect, qr } = update;

                if (qr) {
                    console.log(`QR Code generated for ${shopDomain}`);
                    const qrCodeDataURL = await qrcode.toDataURL(qr);

                    await WhatsAppSession.findOneAndUpdate(
                        { shopDomain },
                        { qrCode: qrCodeDataURL, status: "qr_ready" }
                    );

                    if (this.io) {
                        this.io.to(shopDomain).emit("qr", { qrCode: qrCodeDataURL });
                    }
                }

                if (connection === "close") {
                    const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
                    console.log(`Connection closed for ${shopDomain}. Reconnecting: ${shouldReconnect}`);

                    if (shouldReconnect) {
                        this.initializeClient(shopDomain);
                    } else {
                        this.sockets.delete(shopDomain);
                        await WhatsAppSession.findOneAndUpdate(
                            { shopDomain },
                            { isConnected: false, status: "disconnected", qrCode: null }
                        );
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
            await this.initializeClient(shopDomain);

            await WhatsAppSession.findOneAndUpdate(
                { shopDomain },
                { status: "pairing" }
            );

            // Wait briefly for socket to be ready (heuristic)
            await new Promise(resolve => setTimeout(resolve, 2000));

            const sock = this.sockets.get(shopDomain);
            if (!sock) {
                throw new Error("Socket not initialized");
            }

            console.log(`Requesting pairing code for ${shopDomain} with number ${formattedNumber}`);

            // Request pairing code directly
            // Note: Baileys might require a little time after init before requestPairingCode works reliably
            const code = await sock.requestPairingCode(formattedNumber);
            console.log(`Pairing code for ${shopDomain}: ${code}`);

            return { success: true, pairingCode: code };
        } catch (error) {
            console.error(`Error requesting pairing code for ${shopDomain}:`, error);
            return { success: false, error: error.message || "Failed to get pairing code" };
        }
    }

    async disconnectClient(shopDomain) {
        try {
            const sock = this.sockets.get(shopDomain);
            if (sock) {
                await sock.logout();
                this.sockets.delete(shopDomain);
            }
            const authPath = path.join(os.tmpdir(), "auth_info", shopDomain);
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

    async getConnectionStatus(shopDomain) {
        const session = await WhatsAppSession.findOne({ shopDomain });
        const sock = this.sockets.get(shopDomain);
        return {
            isConnected: !!(sock?.user),
            status: session?.status || "disconnected",
            phoneNumber: session?.phoneNumber,
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
}

export const whatsappService = new WhatsAppService();
