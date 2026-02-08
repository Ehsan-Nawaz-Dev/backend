import { Router } from "express";
import { Merchant } from "../models/Merchant.js";
import { whatsappService } from "../services/whatsappService.js";
import { WhatsAppSession } from "../models/WhatsAppSession.js";

const router = Router();

// GET /api/diagnostics?shop=YOUR_SHOP.myshopify.com
router.get("/", async (req, res) => {
    try {
        const { shop } = req.query;

        if (!shop) {
            return res.status(400).json({ error: "Missing shop parameter" });
        }

        const merchant = await Merchant.findOne({ shopDomain: shop });
        const whatsappSession = await WhatsAppSession.findOne({ shopDomain: shop });
        const socketStatus = await whatsappService.getConnectionStatus(shop);

        res.json({
            shop,
            merchant: {
                exists: !!merchant,
                hasAccessToken: !!merchant?.shopifyAccessToken,
                needsReauth: merchant?.needsReauth || false,
                reauthReason: merchant?.reauthReason || null,
                reauthDetectedAt: merchant?.reauthDetectedAt || null,
                pendingConfirmTag: merchant?.pendingConfirmTag,
                orderConfirmTag: merchant?.orderConfirmTag,
                orderCancelTag: merchant?.orderCancelTag,
                whatsappProvider: merchant?.whatsappProvider
            },
            whatsapp: {
                sessionInDb: {
                    exists: !!whatsappSession,
                    status: whatsappSession?.status,
                    isConnected: whatsappSession?.isConnected
                },
                socketStatus: socketStatus
            },
            config: {
                SHOPIFY_APP_URL: process.env.SHOPIFY_APP_URL,
                SHOPIFY_API_KEY: process.env.SHOPIFY_API_KEY ? "CONFIGURED" : "MISSING",
                SHOPIFY_API_SECRET: process.env.SHOPIFY_API_SECRET ? "CONFIGURED" : "MISSING"
            }
        });
    } catch (err) {
        console.error("Diagnostics Error:", err);
        res.status(500).json({ error: "Internal server error", message: err.message });
    }
});

export default router;
