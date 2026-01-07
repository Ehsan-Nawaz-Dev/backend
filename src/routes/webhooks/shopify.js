import { Router } from "express";
import { ActivityLog } from "../../models/ActivityLog.js";
import { automationService } from "../../services/automationService.js";
import { Merchant } from "../../models/Merchant.js";
import { AutomationSetting } from "../../models/AutomationSetting.js";
import { whatsappService } from "../../services/whatsappService.js";
import { Template } from "../../models/Template.js";
import crypto from "crypto";

const router = Router();

// Middleware to verify Shopify Webhook HMAC
const verifyShopifyWebhook = (req, res, next) => {
    const hmac = req.headers["x-shopify-hmac-sha256"];
    const secret = process.env.SHOPIFY_API_SECRET;

    if (!secret) {
        console.warn("SHOPIFY_API_SECRET not set, skipping HMAC validation for development");
        return next();
    }

    if (!hmac) return res.status(401).send("No HMAC header");

    const body = JSON.stringify(req.body);
    const hash = crypto
        .createHmac("sha256", secret)
        .update(body, "utf8")
        .digest("base64");

    if (hash === hmac) {
        next();
    } else {
        res.status(401).send("HMAC validation failed");
    }
};

const logEvent = async (type, req, shopDomain) => {
    try {
        const merchant = await Merchant.findOne({ shopDomain });
        return await ActivityLog.create({
            merchant: merchant?._id,
            type,
            orderId: req.body?.id?.toString?.() || req.body?.order_id?.toString?.(),
            customerName: req.body?.customer?.first_name || req.body?.shipping_address?.first_name || "Customer",
            message: `Shopify webhook: ${type}`,
            rawPayload: req.body,
        });
    } catch (err) {
        console.error("Error logging activity", err);
    }
};

// Universal Webhook Endpoint: POST /api/webhooks/shopify
router.post("/", verifyShopifyWebhook, async (req, res) => {
    const topic = req.headers["x-shopify-topic"];
    const shopDomain = req.headers["x-shopify-shop-domain"] || req.headers["x-shop-domain"] || req.query.shop;

    console.log(`Webhook received - Topic: ${topic}, Shop: ${shopDomain}`);

    if (!shopDomain) {
        console.warn("Webhook received without shop domain");
        return res.status(200).send("ok");
    }

    const merchant = await Merchant.findOne({ shopDomain });
    if (!merchant) {
        console.warn(`No merchant found for shop: ${shopDomain}`);
        return res.status(200).send("ok");
    }

    const order = req.body;
    const orderNumber = order.name || order.order_number || `#${order.id}`;
    const customerName = order.customer?.first_name || order.shipping_address?.first_name || "Customer";

    // Format the Customer Phone
    let customerPhone = order.customer?.phone || order.shipping_address?.phone || order.billing_address?.phone || "";
    customerPhone = customerPhone.replace(/\D/g, ''); // Remove non-digits
    if (customerPhone && !customerPhone.startsWith('92')) {
        customerPhone = '92' + customerPhone; // Ensure country code (Pakistan)
    }

    if (topic === "orders/create") {
        const activity = await logEvent("pending", req, shopDomain);

        // Trigger 1: Admin Alert
        const adminSetting = await AutomationSetting.findOne({ shopDomain, type: "admin-order-alert" });
        if (adminSetting?.enabled && merchant.adminPhoneNumber) {
            const adminTemplate = await Template.findOne({ merchant: merchant._id, event: "admin-order-alert" });
            let adminMsg = adminTemplate?.message || `New Order Alert: Order {{order_number}} received from {{customer_name}}`;
            adminMsg = adminMsg.replace(/{{customer_name}}/g, customerName).replace(/{{order_number}}/g, orderNumber);

            await whatsappService.sendMessage(shopDomain, merchant.adminPhoneNumber, adminMsg);
            await automationService.trackSent(shopDomain, "admin-order-alert");
        }

        // Trigger 2: Customer Confirmation
        const customerSetting = await AutomationSetting.findOne({ shopDomain, type: "order-confirmation" });
        if (customerSetting?.enabled && customerPhone) {
            const customerTemplate = await Template.findOne({ merchant: merchant._id, event: "orders/create" });
            let customerMsg = customerTemplate?.message || `Hi {{customer_name}}, your order {{order_number}} has been received! We'll notify you when it ships.`;
            customerMsg = customerMsg.replace(/{{customer_name}}/g, customerName).replace(/{{order_number}}/g, orderNumber);

            try {
                // Send via Baileys (sock.sendMessage)
                const result = await whatsappService.sendMessage(shopDomain, customerPhone, customerMsg);

                if (result.success) {
                    await automationService.trackSent(shopDomain, "order-confirmation");

                    // UPDATE THE LOG (Crucial)
                    if (activity) {
                        activity.type = 'confirmed';
                        activity.message = 'Order Confirmation Sent';
                        activity.customerName = customerName;
                        await activity.save();
                    }
                } else {
                    throw new Error(result.error || "Failed to send message via WhatsApp");
                }
            } catch (error) {
                console.error(`WhatsApp Confirmation Error for ${shopDomain}:`, error);
                if (activity) {
                    activity.type = 'cancelled';
                    activity.message = `Error: ${error.message}`;
                    activity.customerName = customerName;
                    await activity.save();
                }
            }
        }
    } else if (topic === "orders/cancelled") {
        await logEvent("cancelled", req, shopDomain);

        const cancelSetting = await AutomationSetting.findOne({ shopDomain, type: "order-confirmation" });
        if (cancelSetting?.enabled && customerPhone) {
            const cancelTemplate = await Template.findOne({ merchant: merchant._id, event: "orders/cancelled" });
            if (cancelTemplate) {
                let cancelMsg = cancelTemplate.message;
                cancelMsg = cancelMsg.replace(/{{customer_name}}/g, customerName).replace(/{{order_number}}/g, orderNumber);

                await whatsappService.sendMessage(shopDomain, customerPhone, cancelMsg);
            }
        }
    } else if (topic === "checkouts/abandoned") {
        await logEvent("pending", req, shopDomain);
        await automationService.trackSent(shopDomain, "abandoned_cart");
    } else if (topic === "fulfillments/update") {
        await logEvent("confirmed", req, shopDomain);
        await automationService.trackSent(shopDomain, "fulfillment_update");
    } else if (topic === "orders/paid") {
        const revenue = parseFloat(req.body?.total_price || 0);
        await automationService.trackRecovered(shopDomain, revenue);
    }

    res.status(200).send("ok");
});

export default router;
