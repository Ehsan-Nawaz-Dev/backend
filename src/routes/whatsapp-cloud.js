import { Router } from "express";
import { whatsappCloudService } from "../services/whatsappCloudService.js";

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

        const result = await whatsappCloudService.sendTextMessage(to, message);

        if (result.success) {
            res.json({
                success: true,
                messageId: result.messageId,
                message: "Message sent successfully",
            });
        } else {
            res.status(500).json({
                success: false,
                error: result.error,
                details: result.details,
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

        const result = await whatsappCloudService.sendTemplateMessage(
            to,
            templateName,
            languageCode || "en",
            components || []
        );

        if (result.success) {
            res.json({
                success: true,
                messageId: result.messageId,
                message: "Template message sent successfully",
            });
        } else {
            res.status(500).json({
                success: false,
                error: result.error,
                details: result.details,
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

        const result = await whatsappCloudService.sendImageMessage(to, imageUrl, caption || "");

        if (result.success) {
            res.json({
                success: true,
                messageId: result.messageId,
                message: "Image message sent successfully",
            });
        } else {
            res.status(500).json({
                success: false,
                error: result.error,
                details: result.details,
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

            // Mark message as read (optional)
            if (result.data.messageId) {
                await whatsappCloudService.markMessageAsRead(result.data.messageId);
            }

            // TODO: Store message in database or trigger business logic
            // For example: save to ActivityLog, trigger automated responses, etc.

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
