import { Router } from "express";
import { ActivityLog } from "../../models/ActivityLog.js";
import { automationService } from "../../services/automationService.js";
import { Merchant } from "../../models/Merchant.js";
import { AutomationSetting } from "../../models/AutomationSetting.js";
import { whatsappService } from "../../services/whatsappService.js";
import { Template } from "../../models/Template.js";
import { shopifyService } from "../../services/shopifyService.js";
import crypto from "crypto";
import { replacePlaceholders } from "../../utils/placeholderHelper.js";

const router = Router();

// Bulletproof Phone & Name extraction
const getCustomerData = (order) => {
    // Try these 3 places for phone
    const phone = order.customer?.phone ||
        order.shipping_address?.phone ||
        order.billing_address?.phone ||
        order.phone;

    // Try these 2 places for name
    const first = order.customer?.first_name || order.shipping_address?.first_name || "Customer";
    const last = order.customer?.last_name || "";

    return {
        phone: phone ? phone.replace(/\D/g, '') : null,
        name: `${first} ${last}`.trim()
    };
};

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
        const { phone: customerPhone, name: customerName } = getCustomerData(req.body);
        return await ActivityLog.create({
            merchant: merchant?._id,
            type,
            orderId: req.body?.id?.toString?.() || req.body?.order_id?.toString?.(),
            customerName,
            customerPhone,
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
    const { phone: customerPhoneRaw, name: customerName } = getCustomerData(order);
    const orderNumber = order.name || order.order_number || `#${order.id}`;

    // Format the Customer Phone (Ensure country code)
    let customerPhoneFormatted = customerPhoneRaw;
    if (customerPhoneFormatted && !customerPhoneFormatted.startsWith('92')) {
        customerPhoneFormatted = '92' + customerPhoneFormatted;
    }

    if (topic === "orders/create") {
        // 1. Create the Activity Log as 'pending'
        const activity = await ActivityLog.create({
            merchant: merchant?._id,
            type: 'pending',
            orderId: order.id?.toString(),
            message: 'Processing Order Notification...',
            customerName: customerName,
            customerPhone: customerPhoneFormatted,
            rawPayload: order
        });

        res.status(200).send('ok'); // Tell Shopify we got it

        // Processing continues in the background
        (async () => {
            try {
                // Trigger 1: Customer Confirmation (Customer is notified IMMEDIATELY)
                const customerSetting = await AutomationSetting.findOne({ shopDomain, type: "order-confirmation" });
                if (customerSetting?.enabled) {
                    if (!customerPhoneFormatted) {
                        // If no phone, we update log and finish (don't throw error to catch-all)
                        if (activity) {
                            activity.type = 'failed';
                            activity.message = 'Skipped: No phone number found 📵';
                            await activity.save();
                        }
                        return;
                    }

                    // Refetch again after potential delay for the most up-to-date token
                    const updatedMerchant = await Merchant.findOne({ shopDomain });
                    const customerTemplate = await Template.findOne({ merchant: updatedMerchant?._id, event: "orders/create" });
                    let customerMsg = customerTemplate?.message || `Hi {{customer_name}}, your order {{order_number}} has been received! We'll notify you when it ships.`;

                    // Replace Placeholders (Now handles customer_name, address, city, price)
                    customerMsg = replacePlaceholders(customerMsg, { order, merchant: updatedMerchant });

                    let result;
                    if (customerTemplate?.isPoll && customerTemplate?.pollOptions?.length > 0) {
                        result = await whatsappService.sendPoll(shopDomain, customerPhoneFormatted, customerMsg, customerTemplate.pollOptions);
                    } else {
                        result = await whatsappService.sendMessage(shopDomain, customerPhoneFormatted, customerMsg);
                    }

                    if (result.success) {
                        await automationService.trackSent(shopDomain, "order-confirmation");

                        // ADD SHOPIFY TAGS
                        if (updatedMerchant?.shopifyAccessToken) {
                            // Add "Pending Order Confirmation" tag (standardized)
                            await shopifyService.addOrderTag(
                                shopDomain,
                                updatedMerchant.shopifyAccessToken,
                                order.id,
                                "Pending Order Confirmation"
                            );
                        }

                        // 4. UPDATE DASHBOARD TO GREEN (CONFIRMED)
                        if (activity) {
                            activity.type = 'confirmed';
                            activity.message = 'WhatsApp Confirmation Sent ✅';
                            await activity.save();
                        }
                    } else {
                        throw new Error(result.error || "Failed to send WhatsApp message");
                    }
                } else if (activity) {
                    // If customer setting disabled but admin alert was sent, mark as confirmed/processed
                    activity.type = 'confirmed';
                    activity.message = 'Admin Alert Sent (Customer Disabled) ✅';
                    await activity.save();
                }
            } catch (err) {
                // 5. UPDATE DASHBOARD TO RED (FAILED)
                console.error(`Webhook Background Error for ${shopDomain}:`, err);
                if (activity) {
                    activity.type = 'failed';
                    activity.message = 'Failed to send WhatsApp ❌';
                    activity.errorMessage = err.message;
                    await activity.save();
                }
            }
        })();
        return;
    } else if (topic === "orders/cancelled") {
        await logEvent("cancelled", req, shopDomain);

        const cancelSetting = await AutomationSetting.findOne({ shopDomain, type: "order-confirmation" });
        if (cancelSetting?.enabled && customerPhoneFormatted) {
            const cancelTemplate = await Template.findOne({ merchant: merchant._id, event: "orders/cancelled" });
            if (cancelTemplate) {
                let cancelMsg = cancelTemplate.message;
                cancelMsg = replacePlaceholders(cancelMsg, { order, merchant });
                cancelMsg = cancelMsg.replace(/{{customer_name}}/g, customerName);

                if (cancelTemplate.isPoll && cancelTemplate.pollOptions?.length > 0) {
                    await whatsappService.sendPoll(shopDomain, customerPhoneFormatted, cancelMsg, cancelTemplate.pollOptions);
                } else {
                    await whatsappService.sendMessage(shopDomain, customerPhoneFormatted, cancelMsg);
                }
            }
        }
    } else if (topic === "checkouts/abandoned") {
        await logEvent("pending", req, shopDomain);

        // Abandoned cart often needs a different set of data, but we use the helper for consistency
        const abandonedTemplate = await Template.findOne({ merchant: merchant._id, event: "checkouts/abandoned" });
        if (abandonedTemplate && abandonedTemplate.enabled && customerPhoneFormatted) {
            let abandonedMsg = abandonedTemplate.message;
            abandonedMsg = replacePlaceholders(abandonedMsg, { order, merchant });
            abandonedMsg = abandonedMsg.replace(/{{customer_name}}/g, customerName);

            if (abandonedTemplate.isPoll && abandonedTemplate.pollOptions?.length > 0) {
                await whatsappService.sendPoll(shopDomain, customerPhoneFormatted, abandonedMsg, abandonedTemplate.pollOptions);
            } else {
                await whatsappService.sendMessage(shopDomain, customerPhoneFormatted, abandonedMsg);
            }
        }
        await automationService.trackSent(shopDomain, "abandoned_cart");
    } else if (topic === "fulfillments/update") {
        await logEvent("confirmed", req, shopDomain);

        const fulfillmentTemplate = await Template.findOne({ merchant: merchant._id, event: "fulfillments/update" });
        if (fulfillmentTemplate && fulfillmentTemplate.enabled && customerPhoneFormatted) {
            let fulfillmentMsg = fulfillmentTemplate.message;
            fulfillmentMsg = replacePlaceholders(fulfillmentMsg, { order, merchant });
            fulfillmentMsg = fulfillmentMsg.replace(/{{customer_name}}/g, customerName);

            if (fulfillmentTemplate.isPoll && fulfillmentTemplate.pollOptions?.length > 0) {
                await whatsappService.sendPoll(shopDomain, customerPhoneFormatted, fulfillmentMsg, fulfillmentTemplate.pollOptions);
            } else {
                await whatsappService.sendMessage(shopDomain, customerPhoneFormatted, fulfillmentMsg);
            }
        }
        await automationService.trackSent(shopDomain, "fulfillment_update");
    } else if (topic === "orders/paid") {
        const revenue = parseFloat(req.body?.total_price || 0);
        await automationService.trackRecovered(shopDomain, revenue);
    }

    res.status(200).send("ok");
});

export default router;
