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

    // Use rawBody captured in server.js middleware for perfect HMAC matching
    const body = req.rawBody || JSON.stringify(req.body);
    const hash = crypto
        .createHmac("sha256", secret)
        .update(body)
        .digest("base64");

    if (hash === hmac) {
        next();
    } else {
        console.error(`[ShopifyWebhook] HMAC validation FAILED for shop: ${req.headers["x-shopify-shop-domain"]}`);
        console.error(`[ShopifyWebhook] Expected: ${hash}`);
        console.error(`[ShopifyWebhook] Received: ${hmac}`);
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
    if (customerPhoneFormatted) {
        // Remove all non-digits
        customerPhoneFormatted = customerPhoneFormatted.replace(/\D/g, '');

        if (!customerPhoneFormatted.startsWith('92')) {
            // If it starts with 0 (e.g., 0300...), remove 0 and add 92
            if (customerPhoneFormatted.startsWith('0')) {
                customerPhoneFormatted = '92' + customerPhoneFormatted.substring(1);
            } else {
                customerPhoneFormatted = '92' + customerPhoneFormatted;
            }
        }
    }

    if (topic === "orders/create") {
        // 1. Create the Activity Log as 'pending'
        const orderId = order.id?.toString() || order.order_id?.toString() || (order.admin_graphql_api_id ? order.admin_graphql_api_id.split('/').pop() : null);
        console.log(`[ShopifyWebhook] Processing order ${orderNumber} (ID: ${orderId})`);
        console.log(`[ShopifyWebhook] Order object keys: ${Object.keys(order).join(", ")}`);
        if (order.order) console.log(`[ShopifyWebhook] Found nested order object. Keys: ${Object.keys(order.order).join(", ")}`);

        const activity = await ActivityLog.create({
            merchant: merchant?._id,
            type: 'pending',
            orderId: orderId,
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
                    console.log(`[ShopifyWebhook] Merchant found. Has accessToken: ${!!updatedMerchant?.shopifyAccessToken}, Token length: ${updatedMerchant?.shopifyAccessToken?.length || 0}`);

                    // FETCH COMPLETE ORDER FROM SHOPIFY API (webhook may have incomplete data)
                    let fullOrderData = order; // Default to webhook data
                    if (updatedMerchant?.shopifyAccessToken && orderId) {
                        console.log(`[ShopifyWebhook] Fetching complete order data from Shopify API for order ${orderId}...`);
                        try {
                            const apiOrderData = await shopifyService.getOrder(shopDomain, updatedMerchant.shopifyAccessToken, orderId);
                            if (apiOrderData) {
                                fullOrderData = apiOrderData;
                                console.log(`[ShopifyWebhook] Got complete order from API. Has shipping_address: ${!!apiOrderData.shipping_address}, Has address1: ${!!apiOrderData.shipping_address?.address1}`);
                            } else {
                                console.warn(`[ShopifyWebhook] API returned null for order ${orderId}, using webhook data`);
                            }
                        } catch (apiErr) {
                            console.warn(`[ShopifyWebhook] Failed to fetch order from API, using webhook data:`, apiErr.message);
                        }
                    } else {
                        console.warn(`[ShopifyWebhook] Skipping API fetch - accessToken: ${!!updatedMerchant?.shopifyAccessToken}, orderId: ${orderId}`);
                    }

                    const customerTemplate = await Template.findOne({ merchant: updatedMerchant?._id, event: "orders/create" });
                    let customerMsg = customerTemplate?.message || `Hi {{customer_name}}, your order {{order_number}} has been received! We'll notify you when it ships.`;

                    // Replace Placeholders using the FULL order data from API
                    console.log(`[ShopifyWebhook] Replacing placeholders in message for order ${orderId}`);
                    customerMsg = replacePlaceholders(customerMsg, { order: fullOrderData, merchant: updatedMerchant });
                    console.log(`[ShopifyWebhook] Final message to send: ${customerMsg}`);

                    // NEW: Usage & Plan Limit Check
                    const planConfig = await Plan.findOne({ id: updatedMerchant.plan || 'free' });
                    const currentLimit = planConfig ? planConfig.messageLimit : (updatedMerchant.trialLimit || 10);
                    const currentUsage = updatedMerchant.usage || 0;

                    if (currentUsage >= currentLimit) {
                        console.warn(`[ShopifyWebhook] Message limit reached for ${shopDomain} (Plan: ${updatedMerchant.plan}). Message blocked.`);
                        if (activity) {
                            activity.type = 'failed';
                            activity.message = `Limit Reached (${currentLimit} messages) 🛑`;
                            await activity.save();
                        }
                        return;
                    }

                    let result;
                    console.log(`[ShopifyWebhook] Sending WhatsApp to ${customerPhoneFormatted} via ${updatedMerchant.whatsappProvider}...`);
                    if (customerTemplate?.isPoll && customerTemplate?.pollOptions?.length > 0) {
                        result = await whatsappService.sendPoll(shopDomain, customerPhoneFormatted, customerMsg, customerTemplate.pollOptions);
                    } else {
                        result = await whatsappService.sendMessage(shopDomain, customerPhoneFormatted, customerMsg);
                    }
                    console.log(`[ShopifyWebhook] WhatsApp send result:`, result);

                    if (result && result.success) {
                        // Increment usage for all plans
                        await Merchant.updateOne({ shopDomain }, { $inc: { usage: 1, trialUsage: updatedMerchant.plan === 'trial' ? 1 : 0 } });

                        await automationService.trackSent(shopDomain, "order-confirmation");

                        // ADD SHOPIFY TAGS
                        console.log(`[ShopifyWebhook] Checking if we can tag order. AccessToken present: ${!!updatedMerchant?.shopifyAccessToken}`);

                        if (updatedMerchant?.shopifyAccessToken) {
                            console.log(`[ShopifyWebhook] Applying pending tag to order ${orderId}`);
                            const tagResult = await shopifyService.addOrderTag(
                                shopDomain,
                                updatedMerchant.shopifyAccessToken,
                                orderId,
                                updatedMerchant.pendingConfirmTag || "Pending Order Confirmation",
                                [updatedMerchant.orderConfirmTag, updatedMerchant.orderCancelTag]
                            );
                            console.log(`[ShopifyWebhook] Tagging result for order ${orderId}:`, tagResult);
                        } else {
                            console.warn(`[ShopifyWebhook] SKIPPING TAGGING - No shopifyAccessToken found for ${shopDomain}. Please complete Shopify OAuth.`);
                        }

                        // 4. UPDATE DASHBOARD TO GREEN (CONFIRMED)
                        if (activity) {
                            activity.type = 'confirmed';
                            activity.message = 'WhatsApp Confirmation Sent ✅';
                            await activity.save();
                        }
                    } else {
                        const errorMsg = result?.error || "Failed to send WhatsApp message (unknown error)";
                        console.error(`[ShopifyWebhook] WhatsApp Error for ${shopDomain}: ${errorMsg}`);
                        throw new Error(errorMsg);
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
                // Usage check for abandoned cart
                const planConfig = await Plan.findOne({ id: merchant.plan || 'free' });
                const currentLimit = planConfig ? planConfig.messageLimit : (merchant.trialLimit || 10);
                if ((merchant.usage || 0) >= currentLimit) {
                    console.warn(`[ShopifyWebhook] Limit reached for ${shopDomain} (Abandoned Cart blocked)`);
                    return res.status(200).send("ok");
                }

                const result = await whatsappService.sendPoll(shopDomain, customerPhoneFormatted, abandonedMsg, abandonedTemplate.pollOptions);
                if (result?.success) {
                    await Merchant.updateOne({ shopDomain }, { $inc: { usage: 1, trialUsage: merchant.plan === 'trial' ? 1 : 0 } });
                }
            } else {
                // Usage check for abandoned cart
                const planConfig = await Plan.findOne({ id: merchant.plan || 'free' });
                const currentLimit = planConfig ? planConfig.messageLimit : (merchant.trialLimit || 10);
                if ((merchant.usage || 0) >= currentLimit) {
                    console.warn(`[ShopifyWebhook] Limit reached for ${shopDomain} (Abandoned Cart blocked)`);
                    return res.status(200).send("ok");
                }

                const result = await whatsappService.sendMessage(shopDomain, customerPhoneFormatted, abandonedMsg);
                if (result?.success) {
                    await Merchant.updateOne({ shopDomain }, { $inc: { usage: 1, trialUsage: merchant.plan === 'trial' ? 1 : 0 } });
                }
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
                // Usage check for fulfillment
                const planConfig = await Plan.findOne({ id: merchant.plan || 'free' });
                const currentLimit = planConfig ? planConfig.messageLimit : (merchant.trialLimit || 10);
                if ((merchant.usage || 0) >= currentLimit) {
                    console.warn(`[ShopifyWebhook] Limit reached for ${shopDomain} (Fulfillment blocked)`);
                    return res.status(200).send("ok");
                }

                const result = await whatsappService.sendPoll(shopDomain, customerPhoneFormatted, fulfillmentMsg, fulfillmentTemplate.pollOptions);
                if (result?.success) {
                    await Merchant.updateOne({ shopDomain }, { $inc: { usage: 1, trialUsage: merchant.plan === 'trial' ? 1 : 0 } });
                }
            } else {
                // Usage check for fulfillment
                const planConfig = await Plan.findOne({ id: merchant.plan || 'free' });
                const currentLimit = planConfig ? planConfig.messageLimit : (merchant.trialLimit || 10);
                if ((merchant.usage || 0) >= currentLimit) {
                    console.warn(`[ShopifyWebhook] Limit reached for ${shopDomain} (Fulfillment blocked)`);
                    return res.status(200).send("ok");
                }

                const result = await whatsappService.sendMessage(shopDomain, customerPhoneFormatted, fulfillmentMsg);
                if (result?.success) {
                    await Merchant.updateOne({ shopDomain }, { $inc: { usage: 1, trialUsage: merchant.plan === 'trial' ? 1 : 0 } });
                }
            }
        }
        await automationService.trackSent(shopDomain, "fulfillment_update");
    } else if (topic === "orders/paid") {
        const revenue = parseFloat(req.body?.total_price || 0);
        await automationService.trackRecovered(shopDomain, revenue);
    } else if (topic === "app/uninstalled") {
        await Merchant.findOneAndUpdate(
            { shopDomain },
            {
                isActive: false,
                shopifyAccessToken: null,
                uninstalledAt: new Date()
            }
        );
        console.log(`[ShopifyWebhook] App UNINSTALLED for ${shopDomain}. Merchant marked inactive.`);
    } else if (topic === "checkouts/create") {
        console.log(`[ShopifyWebhook] Checkout created for ${shopDomain}.`);
        // Optional: Trigger abandoned cart logic here or via checkouts/abandoned
    }

    res.status(200).send("ok");
});

export default router;
