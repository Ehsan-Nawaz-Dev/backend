import pkg from "whatsapp-web.js";
const { Client, LocalAuth } = pkg;
import qrcode from "qrcode";
import { WhatsAppSession } from "../models/WhatsAppSession.js";

class WhatsAppService {
    constructor() {
        this.clients = new Map(); // shopDomain -> Client instance
        this.io = null; // Socket.io instance (set later)
    }

    setSocketIO(io) {
        this.io = io;
    }

    async initializeClient(shopDomain) {
        try {
            // Check if client already exists
            if (this.clients.has(shopDomain)) {
                const existingClient = this.clients.get(shopDomain);
                if (existingClient.info) {
                    return { success: true, status: "already_connected" };
                }
            }

            // Create new client
            const client = new Client({
                authStrategy: new LocalAuth({
                    clientId: shopDomain,
                }),
                puppeteer: {
                    headless: true,
                    args: [
                        "--no-sandbox",
                        "--disable-setuid-sandbox",
                        "--disable-dev-shm-usage",
                        "--disable-accelerated-2d-canvas",
                        "--no-first-run",
                        "--no-zygote",
                        "--disable-gpu",
                    ],
                },
            });

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

            // QR Code generation
            client.on("qr", async (qr) => {
                console.log(`QR Code generated for ${shopDomain}`);

                // Generate QR code as base64 image
                const qrCodeDataURL = await qrcode.toDataURL(qr);

                // Update session with QR code
                await WhatsAppSession.findOneAndUpdate(
                    { shopDomain },
                    {
                        qrCode: qrCodeDataURL,
                        status: "qr_ready",
                    }
                );

                // Emit QR code via socket
                if (this.io) {
                    this.io.to(shopDomain).emit("qr", { qrCode: qrCodeDataURL });
                }
            });

            // Ready event
            client.on("ready", async () => {
                console.log(`WhatsApp client ready for ${shopDomain}`);
                const info = client.info;

                await WhatsAppSession.findOneAndUpdate(
                    { shopDomain },
                    {
                        isConnected: true,
                        status: "connected",
                        phoneNumber: info?.wid?.user || info?.me?.user,
                        lastConnected: new Date(),
                        qrCode: null,
                        errorMessage: null,
                    }
                );

                // Emit connection success via socket
                if (this.io) {
                    this.io.to(shopDomain).emit("connected", {
                        phoneNumber: info?.wid?.user || info?.me?.user,
                    });
                }
            });

            // Authenticated event
            client.on("authenticated", async () => {
                console.log(`WhatsApp client authenticated for ${shopDomain}`);
            });

            // Disconnected event
            client.on("disconnected", async (reason) => {
                console.log(`WhatsApp client disconnected for ${shopDomain}:`, reason);

                await WhatsAppSession.findOneAndUpdate(
                    { shopDomain },
                    {
                        isConnected: false,
                        status: "disconnected",
                        qrCode: null,
                    }
                );

                // Emit disconnection via socket
                if (this.io) {
                    this.io.to(shopDomain).emit("disconnected", { reason });
                }

                // Remove client from map
                this.clients.delete(shopDomain);
            });

            // Authentication failure
            client.on("auth_failure", async (msg) => {
                console.log(`Authentication failure for ${shopDomain}:`, msg);

                await WhatsAppSession.findOneAndUpdate(
                    { shopDomain },
                    {
                        isConnected: false,
                        status: "error",
                        errorMessage: "Authentication failed",
                        qrCode: null,
                    }
                );

                // Emit error via socket
                if (this.io) {
                    this.io.to(shopDomain).emit("error", { message: "Authentication failed" });
                }
            });

            // Store client
            this.clients.set(shopDomain, client);

            // Initialize client
            await client.initialize();

            return { success: true, status: "initializing" };
        } catch (error) {
            console.error(`Error initializing WhatsApp client for ${shopDomain}:`, error);

            await WhatsAppSession.findOneAndUpdate(
                { shopDomain },
                {
                    isConnected: false,
                    status: "error",
                    errorMessage: error.message,
                },
                { upsert: true }
            );

            return { success: false, error: error.message };
        }
    }

    async disconnectClient(shopDomain) {
        try {
            const client = this.clients.get(shopDomain);

            if (!client) {
                return { success: false, error: "Client not found" };
            }

            await client.destroy();
            this.clients.delete(shopDomain);

            await WhatsAppSession.findOneAndUpdate(
                { shopDomain },
                {
                    isConnected: false,
                    status: "disconnected",
                    qrCode: null,
                }
            );

            return { success: true };
        } catch (error) {
            console.error(`Error disconnecting WhatsApp client for ${shopDomain}:`, error);
            return { success: false, error: error.message };
        }
    }

    async getConnectionStatus(shopDomain) {
        try {
            const session = await WhatsAppSession.findOne({ shopDomain });
            const client = this.clients.get(shopDomain);

            if (!session) {
                return {
                    isConnected: false,
                    status: "disconnected",
                };
            }

            // Check if client is actually connected
            const isClientConnected = client && client.info !== null;

            return {
                isConnected: isClientConnected,
                status: session.status,
                phoneNumber: session.phoneNumber,
                qrCode: session.qrCode,
                lastConnected: session.lastConnected,
                errorMessage: session.errorMessage,
            };
        } catch (error) {
            console.error(`Error getting connection status for ${shopDomain}:`, error);
            return {
                isConnected: false,
                status: "error",
                errorMessage: error.message,
            };
        }
    }

    async sendMessage(shopDomain, phoneNumber, message) {
        try {
            const client = this.clients.get(shopDomain);

            if (!client || !client.info) {
                return { success: false, error: "WhatsApp client not connected" };
            }

            // Format phone number (remove + and add country code if needed)
            const formattedNumber = phoneNumber.replace(/[^0-9]/g, "");
            const chatId = `${formattedNumber}@c.us`;

            await client.sendMessage(chatId, message);

            return { success: true };
        } catch (error) {
            console.error(`Error sending message for ${shopDomain}:`, error);
            return { success: false, error: error.message };
        }
    }

    getClient(shopDomain) {
        return this.clients.get(shopDomain);
    }
}

// Export singleton instance
export const whatsappService = new WhatsAppService();
