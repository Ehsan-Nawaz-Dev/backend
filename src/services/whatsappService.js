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
                    headless: false, // Temporarily set to false for debugging
                    args: [
                        "--no-sandbox",
                        "--disable-setuid-sandbox",
                        "--disable-dev-shm-usage",
                        "--disable-accelerated-2d-canvas",
                        "--no-first-run",
                        "--no-zygote",
                        "--disable-gpu",
                        "--disable-extensions",
                        "--disable-blink-features=AutomationControlled",
                    ],
                },
            });

            // Log all client events for debugging
            client.on("loading_screen", (percent, message) => {
                console.log(`[${shopDomain}] Loading: ${percent}% - ${message}`);
            });

            client.on("change_state", (state) => {
                console.log(`[${shopDomain}] State changed to: ${state}`);
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

    async requestPairingCode(shopDomain, phoneNumber) {
        try {
            // Check if client already exists and is connected
            if (this.clients.has(shopDomain)) {
                const existingClient = this.clients.get(shopDomain);
                if (existingClient.info) {
                    return { success: false, error: "Session already active" };
                }
                // If initializing or qr_ready, we might want to restart or just use it
                // But for pairing code, it's safer to ensure a fresh state or specific flow
            }

            // Initialize client if not already done or if we want to ensure it's ready for pairing
            // We can reuse initializeClient but we need to know when it's ready to request code

            // Format phone number (remove + and non-digits)
            const formattedNumber = phoneNumber.replace(/[^0-9]/g, "");

            if (!formattedNumber) {
                return { success: false, error: "Invalid phone number" };
            }

            // If client doesn't exist, start it
            if (!this.clients.has(shopDomain)) {
                await this.initializeClient(shopDomain);
            }

            const client = this.clients.get(shopDomain);

            // Wait for client to be initialized enough to request pairing code
            // whatsapp-web.js requires the client to be in a state where it's ready to show QR or Pairing Code

            return new Promise((resolve, reject) => {
                const onQr = async () => {
                    try {
                        const code = await client.requestPairingCode(formattedNumber);

                        // Update status to pairing
                        await WhatsAppSession.findOneAndUpdate(
                            { shopDomain },
                            { status: "pairing", qrCode: null }
                        );

                        // Cleanup listeners
                        client.off("qr", onQr);
                        client.off("ready", onReady);

                        resolve({ success: true, pairingCode: code });
                    } catch (err) {
                        client.off("qr", onQr);
                        client.off("ready", onReady);
                        reject(err);
                    }
                };

                const onReady = () => {
                    client.off("qr", onQr);
                    client.off("ready", onReady);
                    resolve({ success: false, error: "Already connected" });
                };

                client.once("qr", onQr);
                client.once("ready", onReady);

                // If it's already in a state where it has a QR or is ready, we might need to handle it
                // But usually initializeClient starts the process and 'qr' will fire.
            });

        } catch (error) {
            console.error(`[${shopDomain}] Error requesting pairing code:`, error);
            return { success: false, error: error.message };
        }
    }

    getClient(shopDomain) {
        return this.clients.get(shopDomain);
    }
}

// Export singleton instance
export const whatsappService = new WhatsAppService();
