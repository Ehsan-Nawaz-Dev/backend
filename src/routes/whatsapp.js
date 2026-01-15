import { Router } from "express";
import { whatsappService } from "../services/whatsappService.js";
import { Merchant } from "../models/Merchant.js";

const router = Router();

// Helper to get shop domain
const getShopDomain = (req) => req.query.shop || req.headers["x-shop-domain"];

// GET /api/whatsapp/status - Get connection status
router.get("/status", async (req, res) => {
    try {
        const shopDomain = getShopDomain(req);
        if (!shopDomain) return res.status(400).json({ error: "Missing shop parameter" });

        const status = await whatsappService.getConnectionStatus(shopDomain);

        res.json({
            connected: status.isConnected,
            phoneNumber: status.phoneNumber || "",
            deviceName: status.deviceName || "Desktop"
        });
    } catch (err) {
        console.error("Error fetching WhatsApp status", err);
        res.status(500).json({ error: "Internal server error" });
    }
});

// POST /api/whatsapp/connect - Initialize WhatsApp connection
router.post("/connect", async (req, res) => {
    try {
        const shopDomain = getShopDomain(req);
        if (!shopDomain) return res.status(400).json({ error: "Missing shop parameter" });

        const result = await whatsappService.initializeClient(shopDomain);

        if (result.success) {
            res.json({
                success: true,
                message: "WhatsApp client initialization started",
                status: result.status
            });
        } else {
            res.status(500).json({
                success: false,
                error: result.error
            });
        }
    } catch (err) {
        console.error("Error connecting WhatsApp", err);
        res.status(500).json({ error: "Internal server error" });
    }
});

// POST /api/whatsapp/disconnect - Disconnect WhatsApp
router.post("/disconnect", async (req, res) => {
    try {
        const shopDomain = getShopDomain(req);
        if (!shopDomain) return res.status(400).json({ error: "Missing shop parameter" });

        const result = await whatsappService.disconnectClient(shopDomain);

        if (result.success) {
            res.json({
                success: true,
                message: "WhatsApp client disconnected successfully"
            });
        } else {
            res.status(500).json({
                success: false,
                error: result.error
            });
        }
    } catch (err) {
        console.error("Error disconnecting WhatsApp", err);
        res.status(500).json({ error: "Internal server error" });
    }
});

// POST /api/whatsapp/send - Send a message
router.post("/send", async (req, res) => {
    try {
        const shopDomain = getShopDomain(req);
        if (!shopDomain) return res.status(400).json({ error: "Missing shop parameter" });

        const { phoneNumber, message, isPoll, pollOptions } = req.body;

        if (!phoneNumber || !message) {
            return res.status(400).json({ error: "Missing phoneNumber or message" });
        }

        const merchant = await Merchant.findOne({ shopDomain });
        if (merchant && merchant.plan === 'trial') {
            if (merchant.trialUsage >= (merchant.trialLimit || 10)) {
                return res.status(403).json({
                    success: false,
                    error: "Trial limit reached (10 messages max). Please upgrade to a paid plan."
                });
            }
        }

        let result;
        if (isPoll && pollOptions?.length > 0) {
            result = await whatsappService.sendPoll(shopDomain, phoneNumber, message, pollOptions);
        } else {
            result = await whatsappService.sendMessage(shopDomain, phoneNumber, message);
        }

        if (result.success) {
            // Increment trial usage
            if (merchant && merchant.plan === 'trial') {
                await Merchant.updateOne({ shopDomain }, { $inc: { trialUsage: 1 } });
            }

            res.json({
                success: true,
                message: "Message sent successfully"
            });
        } else {
            res.status(500).json({
                success: false,
                error: result.error
            });
        }
    } catch (err) {
        console.error("Error sending WhatsApp message", err);
        res.status(500).json({ error: "Internal server error" });
    }
});

// POST /api/whatsapp/pair - Request pairing code
router.post("/pair", async (req, res) => {
    try {
        const shopDomain = getShopDomain(req);
        const phoneNumber = req.body.phone || req.query.phone;

        if (!shopDomain) return res.status(400).json({ error: "Missing shop parameter" });
        if (!phoneNumber) return res.status(400).json({ error: "Missing phone parameter" });

        // Warning for Vercel environments
        if (process.env.VERCEL === "1") {
            console.warn(`Pairing requested for ${shopDomain} on Vercel. This will likely fail due to serverless timeout.`);
        }

        const result = await whatsappService.requestPairingCode(shopDomain, phoneNumber);

        if (result.success) {
            res.json({
                success: true,
                pairingCode: result.pairingCode
            });
        } else {
            res.status(400).json({
                success: false,
                error: result.error
            });
        }
    } catch (err) {
        console.error("Error requesting pairing code", err);
        res.status(500).json({ error: "Internal server error", message: err.message });
    }
});

// GET /api/whatsapp/qr - Get current QR code
router.get("/qr", async (req, res) => {
    try {
        const shopDomain = getShopDomain(req);
        if (!shopDomain) return res.status(400).json({ error: "Missing shop parameter" });

        const status = await whatsappService.getConnectionStatus(shopDomain);

        if (status.qrCode) {
            res.json({
                qrCode: status.qrCode,
                status: status.status
            });
        } else {
            res.json({
                qrCode: null,
                status: status.status,
                message: status.isConnected ? "Already connected" : "No QR code available"
            });
        }
    } catch (err) {
        console.error("Error fetching QR code", err);
        res.status(500).json({ error: "Internal server error" });
    }
});

export default router;
