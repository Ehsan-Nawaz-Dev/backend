import { Router } from "express";
import { whatsappService } from "../services/whatsappService.js";
import { whatsappCloudService } from "../services/whatsappCloudService.js";
import { ActivityLog } from "../models/ActivityLog.js";

const router = Router();

// Helper to get shop domain
const getShopDomain = (req) => req.query.shop || req.headers["x-shop-domain"];

// POST /api/whatsapp-cloud/send - Send text message
router.post("/send", async (req, res) => {
    try {
        const { to, message } = req.body;

        if (!to || !message) {
            return res.status(400).json({
                success: false,
                error: "Missing required fields: 'to' and 'message'",
            });
        }

        const shopDomain = getShopDomain(req);
        if (!shopDomain) return res.status(400).json({ error: "Missing shop parameter" });

        const result = await whatsappService.sendMessage(shopDomain, to, message);

        if (result.success) {
            res.json({
                success: true,
                message: "Message sent successfully via Baileys",
            });
        } else {
            res.status(500).json({
                success: false,
                error: result.error,
            });
        }
    } catch (err) {
        console.error("Error in send message route:", err);
        res.status(500).json({ success: false, error: "Internal server error" });
    }
});

// POST /api/whatsapp-cloud/send-template - Send template message
router.post("/send-template", async (req, res) => {
    try {
        const { to, templateName, languageCode, components } = req.body;

        if (!to || !templateName) {
            return res.status(400).json({
                success: false,
                error: "Missing required fields: 'to' and 'templateName'",
            });
        }

        const shopDomain = getShopDomain(req);
        if (!shopDomain) return res.status(400).json({ error: "Missing shop parameter" });

        // Optimization: For Baileys, we just send the message as text if it's a template bridge
        // or we could implement a more complex template-to-text mapper.
        const result = await whatsappService.sendMessage(shopDomain, to, `Template: ${templateName}`);

        if (result.success) {
            res.json({
                success: true,
                message: "Template message bridge sent via Baileys",
            });
        } else {
            res.status(500).json({
                success: false,
                error: result.error,
            });
        }
    } catch (err) {
        console.error("Error in send template route:", err);
        res.status(500).json({ success: false, error: "Internal server error" });
    }
});

// POST /api/whatsapp-cloud/send-image - Send image message
router.post("/send-image", async (req, res) => {
    try {
        const { to, imageUrl, caption } = req.body;

        if (!to || !imageUrl) {
            return res.status(400).json({
                success: false,
                error: "Missing required fields: 'to' and 'imageUrl'",
            });
        }

        const shopDomain = getShopDomain(req);
        if (!shopDomain) return res.status(400).json({ error: "Missing shop parameter" });

        const result = await whatsappService.sendMessage(shopDomain, to, `Image: ${imageUrl}. ${caption || ""}`);

        if (result.success) {
            res.json({
                success: true,
                message: "Image message bridge sent via Baileys",
            });
        } else {
            res.status(500).json({
                success: false,
                error: result.error,
            });
        }
    } catch (err) {
        console.error("Error in send image route:", err);
        res.status(500).json({ success: false, error: "Internal server error" });
    }
});

// GET /api/whatsapp-cloud/templates - Get message templates
router.get("/templates", async (req, res) => {
    try {
        const result = await whatsappCloudService.getMessageTemplates();

        if (result.success) {
            res.json({
                success: true,
                templates: result.templates,
                paging: result.paging,
            });
        } else {
            res.status(500).json({
                success: false,
                error: result.error,
                details: result.details,
            });
        }
    } catch (err) {
        console.error("Error fetching templates:", err);
        res.status(500).json({ success: false, error: "Internal server error" });
    }
});

// GET /api/whatsapp-cloud/webhooks - Webhook verification
router.get("/webhooks", (req, res) => {
    try {
        const mode = req.query["hub.mode"];
        const token = req.query["hub.verify_token"];
        const challenge = req.query["hub.challenge"];

        const verifiedChallenge = whatsappCloudService.verifyWebhook(mode, token, challenge);

        if (verifiedChallenge) {
            res.status(200).send(verifiedChallenge);
        } else {
            res.status(403).json({ error: "Webhook verification failed" });
        }
    } catch (err) {
        console.error("Error in webhook verification:", err);
        res.status(500).json({ error: "Internal server error" });
    }
});

// POST /api/whatsapp-cloud/webhooks - Receive incoming messages
router.post("/webhooks", async (req, res) => {
    try {
        const webhookBody = req.body;

        console.log("Received webhook:", JSON.stringify(webhookBody, null, 2));

        // Process the incoming message
        const result = whatsappCloudService.processIncomingMessage(webhookBody);

        if (result.success) {
            console.log("Processed message:", result.data);

            const { messageId, from, text, contactName, rawPayload } = result.data;

            // Log activity to database
            try {
                // Since this is a webhook, we might not have a merchant ID easily available 
                // in the payload. For now, we'll log it with a null merchant or find the 
                // merchant who owns this phone number ID.
                // TODO: Implement merchant lookup based on phoneNumberId

                await ActivityLog.create({
                    merchant: null, // Should be populated once multi-tenant logic is finalized
                    type: "pending",
                    customerName: contactName || from,
                    message: text || "Incoming media message",
                    channel: "whatsapp-cloud",
                    rawPayload: webhookBody
                });
                console.log("Activity logged for incoming message from", from);
            } catch (logError) {
                console.error("Error logging activity:", logError);
            }

            // Mark message as read (optional)
            if (messageId) {
                await whatsappCloudService.markMessageAsRead(messageId);
            }

            res.status(200).json({ success: true });
        } else {
            console.log("Webhook processing skipped:", result.reason);
            res.status(200).json({ success: true, skipped: true });
        }
    } catch (err) {
        console.error("Error processing webhook:", err);
        // Always return 200 to acknowledge receipt
        res.status(200).json({ error: "Processing error" });
    }
});

export default router;
