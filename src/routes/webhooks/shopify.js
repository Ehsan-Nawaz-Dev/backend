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
import { normalizePhoneNumber } from "../../utils/phoneNormalizer.js";
import { Plan } from "../../models/Plan.js";
import { NotificationSettings } from "../../models/NotificationSettings.js";
import { Contact } from "../../models/Contact.js";

const router = Router();

// Bulletproof Phone & Name extraction
const getCustomerData = (order) => {
    // Try these 3 places for phone - prioritize shipping address for delivery numbers
    const phone = order.shipping_address?.phone ||
        order.customer?.phone ||
        order.billing_address?.phone ||
        order.phone;

    // Prioritize shipping/billing address name (entered at checkout) over customer account name
    // Shopify's order.customer has the ACCOUNT holder name, not necessarily the buyer's name
    const first = order.shipping_address?.first_name || order.billing_address?.first_name || order.customer?.first_name || "Customer";
    const last = order.shipping_address?.last_name || order.billing_address?.last_name || order.customer?.last_name || "";

    return {
        phone: phone ? phone.replace(/\D/g, '') : null,
        name: `${first} ${last}`.trim()
    };
};

// ... (verifyShopifyWebhook and triggerInternalAlert remains same) ...

// Middleware to verify Shopify Webhook HMAC
const verifyShopifyWebhook = (req, res, next) => {
    const hmac = req.headers["x-shopify-hmac-sha256"];
    const shop = req.headers["x-shopify-shop-domain"];
    const secret = process.env.SHOPIFY_API_SECRET;

    if (!secret) {
        console.warn("SHOPIFY_API_SECRET not set, skipping HMAC validation for development");
        return next();
    }

    if (!hmac) {
        console.error(`[ShopifyWebhook] Missing HMAC header for shop: ${shop}`);
        return res.status(401).send("No HMAC header");
    }

    // Use rawBody captured in server.js middleware for perfect HMAC matching
    // buf in express.json is a Buffer, which is ideal for crypto.update()
    const body = req.rawBody || JSON.stringify(req.body);
    const generatedHash = crypto
        .createHmac("sha256", secret)
        .update(body)
        .digest("base64");

    // Timing safe comparison to satisfy security audits
    try {
        const hashBuffer = Buffer.from(generatedHash);
        const hmacBuffer = Buffer.from(hmac);

        if (hashBuffer.length === hmacBuffer.length && crypto.timingSafeEqual(hashBuffer, hmacBuffer)) {
            return next();
        }
    } catch (err) {
        console.warn(`[ShopifyWebhook] Timing safe comparison failed, falling back to direct match: ${err.message}`);
    }

    // Fallback to direct string comparison if buffers are incompatible
    if (generatedHash === hmac) {
        return next();
    }

    console.error(`[ShopifyWebhook] HMAC validation FAILED for shop: ${shop}`);
    console.error(`[ShopifyWebhook] Topic: ${req.headers["x-shopify-topic"]}`);
    console.error(`[ShopifyWebhook] Generated (base64): ${generatedHash}`);
    console.error(`[ShopifyWebhook] Received (base64): ${hmac}`);

    // Shopify mandatory checks REQUIRE a 401 response for invalid signatures
    res.status(401).send("HMAC validation failed");
};

const triggerInternalAlert = async (type, merchant, orderData) => {
    try {
        if (!merchant?.adminPhoneNumber) return;

        const settings = await NotificationSettings.findOne({ merchant: merchant._id });
        if (!settings?.whatsappAlerts) return;

        // Check if this specific event type is enabled
        if (type === 'confirmed' && !settings.notifyOnConfirm) return;
        if (type === 'cancelled' && !settings.notifyOnCancel) return;
        if (type === 'pending' && !settings.notifyOnAbandoned) return;

        const orderNumber = orderData.name || orderData.order_number || `#${orderData.id}`;
        const customerName = orderData.customer?.first_name ? `${orderData.customer.first_name} ${orderData.customer.last_name || ''}` : "Customer";

        let alertMsg = `🔔 *New Alert:* ${type.toUpperCase()}\n\n`;
        alertMsg += `*Order:* ${orderNumber}\n`;
        alertMsg += `*Customer:* ${customerName}\n`;
        alertMsg += `*Status:* ${type === 'confirmed' ? '✅ Confirmed' : (type === 'cancelled' ? '❌ Cancelled' : '🕒 Pending')}\n\n`;
        alertMsg += `Check your WhatFlow dashboard for details.`;

        await whatsappService.sendMessage(merchant.shopDomain, merchant.adminPhoneNumber, alertMsg);
        console.log(`[InternalAlert] Sent ${type} alert to admin for ${merchant.shopDomain}`);

        // NEW: Tag the order as 'Admin Notified' in Shopify
        if (merchant.shopifyAccessToken && orderData.id) {
            const orderId = orderData.id.toString().split('/').pop();
            const adminTag = merchant.adminNotifiedTag || "📣 Admin Notified";
            await shopifyService.addOrderTag(merchant.shopDomain, merchant.shopifyAccessToken, orderId, adminTag);
            console.log(`[InternalAlert] Applied ${adminTag} to order ${orderId}`);
        }
    } catch (err) {
        console.error("[InternalAlert] Failed to send alert:", err);
    }
};

const logEvent = async (type, req, shopDomain) => {
    try {
        const merchant = await Merchant.findOne({ shopDomain });
        const { phone: customerPhone, name: customerName } = getCustomerData(req.body);
        const log = await ActivityLog.create({
            merchant: merchant?._id,
            type,
            orderId: req.body?.id?.toString?.() || req.body?.order_id?.toString?.(),
            customerName,
            customerPhone,
            message: `Shopify webhook: ${type}`,
            rawPayload: req.body,
        });

        // Trigger Internal WhatsApp Alert if enabled
        if (merchant) {
            triggerInternalAlert(type, merchant, req.body);
        }

        return log;
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

    // --- MANDATORY GDPR COMPLIANCE WEBHOOKS ---
    // These are required for Shopify App Store approval
    if (topic === "customers/data_request") {
        console.log(`[GDPR] Customer Data Request received for shop: ${shopDomain}`);
        return res.status(200).send("ok");
    }

    if (topic === "customers/redact") {
        const { customer, shop_domain } = req.body;
        console.log(`[GDPR] Customer Redact requested for ${customer?.email} on ${shop_domain || shopDomain}`);
        try {
            if (customer?.phone) {
                const formattedPhone = customer.phone.replace(/\D/g, '');
                await Contact.deleteMany({ phone: { $regex: new RegExp(formattedPhone) } });
                await ActivityLog.deleteMany({ customerPhone: { $regex: new RegExp(formattedPhone) } });
            }
        } catch (err) {
            console.error(`[GDPR] Redact failed:`, err);
        }
        return res.status(200).send("ok");
    }

    if (topic === "shop/redact") {
        const { shop_domain } = req.body;
        console.log(`[GDPR] Shop Redact requested for ${shop_domain || shopDomain}`);
        try {
            await Merchant.findOneAndUpdate({ shopDomain: shop_domain || shopDomain }, { isActive: false, shopifyAccessToken: null });
        } catch (err) {
            console.error(`[GDPR] Shop Redact failed:`, err);
        }
        return res.status(200).send("ok");
    }

    const merchant = await Merchant.findOne({ shopDomain });
    if (!merchant) {
        console.warn(`No merchant found for shop: ${shopDomain}`);
        return res.status(200).send("ok");
    }

    const body = req.body;
    const order = body.order || body; // Handle Shopify nesting
    const { phone: customerPhoneRaw, name: customerName } = getCustomerData(order);
    const orderId = order.id?.toString() || order.order_id?.toString() || (order.admin_graphql_api_id ? order.admin_graphql_api_id.split('/').pop() : null);
    const orderNumber = order.name || order.order_number || `#${orderId || 'N/A'}`;

    // Format the Customer Phone (auto-detect country from order address)
    let customerPhoneFormatted = normalizePhoneNumber(customerPhoneRaw, order);

    // --- CASE: MISSING PHONE (Common in Fulfillments) ---
    // If phone is missing and we have an orderId, try fetching the order to get the phone
    if (!customerPhoneFormatted && orderId && merchant.shopifyAccessToken) {
        console.log(`[ShopifyWebhook] Phone missing for topic ${topic}. Attempting to fetch order ${orderId} for data...`);
        try {
            const apiOrder = await shopifyService.getOrder(shopDomain, merchant.shopifyAccessToken, orderId);
            if (apiOrder) {
                const freshData = getCustomerData(apiOrder);
                if (freshData.phone) {
                    customerPhoneFormatted = normalizePhoneNumber(freshData.phone, apiOrder);
                    console.log(`[ShopifyWebhook] Successfully recovered phone: ${customerPhoneFormatted}`);
                }
            }
        } catch (err) {
            console.warn(`[ShopifyWebhook] Failed to recover phone from API: ${err.message}`);
        }
    }

    const isDuplicateWebhook = async (merchantId, orderId, topic) => {
        try {
            const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000);

            // For Order notifications, we check if ANY activity (pending or processed) exists
            if (topic.includes('orders/create') || topic.includes('orders/updated')) {
                const existing = await ActivityLog.findOne({
                    merchant: merchantId,
                    orderId: orderId,
                    type: { $in: ['pending', 'confirmed', 'cancelled', 'pre-cancel', 'failed'] },
                    createdAt: { $gt: fifteenMinutesAgo }
                });
                return !!existing;
            }

            // For other topics, use specific type matches
            const type = topic.includes('cancel') ? 'cancelled' :
                (topic.includes('abandoned') ? 'pending' :
                    (topic.includes('fulfill') ? 'confirmed' : 'pending'));

            const existing = await ActivityLog.findOne({
                merchant: merchantId,
                orderId: orderId,
                type: type,
                createdAt: { $gt: fifteenMinutesAgo }
            });
            return !!existing;
        } catch (err) {
            return false;
        }
    };

    // ONLY handle orders/create — NOT orders/updated with pending status
    // Shopify fires BOTH webhooks simultaneously for new orders, causing duplicate messages
    if (topic === "orders/create") {
        // 1. Create the Activity Log as 'pending'
        console.log(`[ShopifyWebhook] Processing ${topic} for ${orderNumber} (ID: ${orderId})`);

        // Idempotency Check (standard query)
        if (orderId && await isDuplicateWebhook(merchant._id, orderId, topic)) {
            console.log(`[ShopifyWebhook] Duplicate orders/create for ${orderId}. Skipping.`);
            return res.status(200).send('ok');
        }

        // ATOMIC LOCK: Use MongoDB findOneAndUpdate with upsert to prevent race conditions
        // If two webhooks arrive simultaneously, only one will successfully create the lock
        try {
            const lockResult = await ActivityLog.findOneAndUpdate(
                {
                    merchant: merchant._id,
                    orderId: orderId,
                    createdAt: { $gt: new Date(Date.now() - 15 * 60 * 1000) }
                },
                {
                    $setOnInsert: {
                        merchant: merchant._id,
                        type: 'pending',
                        orderId: orderId,
                        message: 'Processing Order Notification...',
                        customerName: customerName,
                        customerPhone: customerPhoneFormatted,
                        rawPayload: order
                    }
                },
                { upsert: true, new: false } // Returns null if it was a fresh insert (no prior doc)
            );

            if (lockResult) {
                // Document already existed — another webhook already claimed this order
                console.log(`[ShopifyWebhook] ATOMIC LOCK: Order ${orderId} already being processed. Skipping duplicate.`);
                return res.status(200).send('ok');
            }
            console.log(`[ShopifyWebhook] ATOMIC LOCK: Acquired lock for order ${orderId}`);
        } catch (lockErr) {
            // E11000 duplicate key error means another webhook won the race — skip
            if (lockErr.code === 11000) {
                console.log(`[ShopifyWebhook] ATOMIC LOCK: Duplicate key for order ${orderId}. Skipping.`);
                return res.status(200).send('ok');
            }
            console.error(`[ShopifyWebhook] Lock error:`, lockErr.message);
        }

        // Fetch the activity log that was just created by the atomic lock above
        const activity = await ActivityLog.findOne({
            merchant: merchant._id,
            orderId: orderId,
            type: 'pending',
            createdAt: { $gt: new Date(Date.now() - 15 * 60 * 1000) }
        });

        // NEW: Save Customer to Contacts
        if (customerPhoneFormatted && merchant) {
            try {
                await Contact.findOneAndUpdate(
                    { merchant: merchant._id, phone: customerPhoneFormatted },
                    {
                        $set: {
                            name: customerName,
                            email: order.customer?.email,
                            lastOrderAt: new Date(),
                            source: 'shopify'
                        },
                        $inc: { totalOrders: 1 }
                    },
                    { upsert: true }
                );
                console.log(`[Contact] Saved/Updated contact ${customerName} for ${shopDomain}`);
            } catch (contactErr) {
                console.error(`[Contact] Failed to save contact:`, contactErr.message);
            }
        }

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

                    const updatedMerchant = await Merchant.findOne({ shopDomain });
                    console.log(`[ShopifyWebhook] Merchant found. Has accessToken: ${!!updatedMerchant?.shopifyAccessToken}, Token length: ${updatedMerchant?.shopifyAccessToken?.length || 0}`);

                    // NEW: WhatsApp Presence Check
                    try {
                        const whatsappCheck = await whatsappService.checkWhatsApp(shopDomain, customerPhoneFormatted);

                        // Only BLOCK if explicitly returned exists: false (meaning successful check saying NO)
                        // If 'error' is present (e.g. timeout), we proceed optimistically to try sending anyway.
                        if (whatsappCheck.exists === false && !whatsappCheck.error) {
                            console.warn(`[ShopifyWebhook] ${customerPhoneFormatted} is NOT on WhatsApp. Tagging order...`);

                            if (activity) {
                                activity.type = 'failed';
                                activity.message = 'Skipped: Number not on WhatsApp 📵';
                                await activity.save();
                            }

                            if (updatedMerchant?.shopifyAccessToken) {
                                const noWpTag = updatedMerchant.noWhatsappTag || "📵 No WhatsApp";
                                await shopifyService.addOrderTag(shopDomain, updatedMerchant.shopifyAccessToken, orderId, noWpTag);
                            }
                            return;
                        } else if (whatsappCheck.error) {
                            console.warn(`[ShopifyWebhook] WhatsApp existence check failed (${whatsappCheck.error}). Proceeding optimistically.`);
                        }
                    } catch (checkErr) {
                        console.warn(`[ShopifyWebhook] WhatsApp presence check threw error. Proceeding optimistically:`, checkErr.message);
                    }

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

                        if (updatedMerchant?.shopifyAccessToken) {
                            await shopifyService.addOrderTag(shopDomain, updatedMerchant.shopifyAccessToken, orderId, "⚠️ Limit Reached");
                        }
                        return;
                    }

                    let result;
                    console.log(`[ShopifyWebhook] Sending WhatsApp to ${customerPhoneFormatted} via ${updatedMerchant.whatsappProvider}...`);
                    if (customerTemplate?.isPoll && customerTemplate?.pollOptions?.length > 0) {
                        result = await whatsappService.sendPoll(shopDomain, customerPhoneFormatted, customerMsg, customerTemplate.pollOptions, orderId);
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

                            // Helper to ensure emoji exists
                            const formatTag = (tag, defaultText, emoji) => {
                                const final = tag || defaultText;
                                if (final.includes(emoji)) return final;
                                if (/[\u{1F300}-\u{1F9FF}]/u.test(final)) return final;
                                return `${emoji} ${final}`;
                            };

                            const pendingTag = formatTag(updatedMerchant.pendingConfirmTag, "Pending Confirmation", "🕒");

                            // Tags to remove (both old defaults and potentially current config)
                            const tagsToRemove = [
                                updatedMerchant.orderConfirmTag,
                                updatedMerchant.orderCancelTag,
                                "Order Confirmed",
                                "Order Cancelled",
                                "Order Cancel By customer",
                                "✅ Order Confirmed",
                                "❌ Order Cancelled"
                            ].filter(t => t && t !== pendingTag);

                            const tagResult = await shopifyService.addOrderTag(
                                shopDomain,
                                updatedMerchant.shopifyAccessToken,
                                orderId,
                                pendingTag,
                                tagsToRemove
                            );
                            console.log(`[ShopifyWebhook] Tagging result for order ${orderId}:`, tagResult);
                        } else {
                            console.warn(`[ShopifyWebhook] SKIPPING TAGGING - No shopifyAccessToken found for ${shopDomain}. Please complete Shopify OAuth.`);
                        }

                        // 4. UPDATE DASHBOARD TO PENDING (WAITING FOR CUSTOMER)
                        if (activity) {
                            activity.type = 'pending';
                            activity.message = 'WhatsApp Message Sent ✅ (Awaiting Customer)';
                            await activity.save();
                        }
                    } else {
                        const errorMsg = result?.error || "Failed to send WhatsApp message (unknown error)";
                        console.error(`[ShopifyWebhook] WhatsApp Error for ${shopDomain}: ${errorMsg}`);
                        throw new Error(errorMsg);
                    }
                } else {
                    console.log(`[ShopifyWebhook] Automation DISABLED for order-confirmation. Skipping.`);
                    if (activity) {
                        // If customer setting disabled but admin alert was sent, mark as confirmed/processed
                        activity.type = 'confirmed';
                        activity.message = 'Automation Disabled (Admin Alert Sent) ✅';
                        await activity.save();
                    }
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
        const orderId = order.id?.toString() || (order.admin_graphql_api_id ? order.admin_graphql_api_id.split('/').pop() : null);

        if (orderId && await isDuplicateWebhook(merchant._id, orderId, topic)) {
            console.log(`[ShopifyWebhook] Duplicate orders/cancelled for ${orderId}. Skipping.`);
            return res.status(200).send('ok');
        }

        await logEvent("cancelled", req, shopDomain);
        res.status(200).send("ok");

        (async () => {
            try {
                const cancelSetting = await AutomationSetting.findOne({ shopDomain, type: "cancellation" });
                const cancelTemplate = await Template.findOne({ merchant: merchant._id, event: "orders/cancelled" });

                if (!cancelSetting?.enabled || !cancelTemplate?.enabled) {
                    console.log(`[ShopifyWebhook] Cancellation skipped: setting=${!!cancelSetting?.enabled}, template=${!!cancelTemplate?.enabled}`);
                    return;
                }

                if (!customerPhoneFormatted) {
                    console.warn(`[ShopifyWebhook] Cannot send cancellation: No phone number for ${orderNumber}`);
                    return;
                }

                let cancelMsg = cancelTemplate.message;
                cancelMsg = replacePlaceholders(cancelMsg, { order, merchant });
                cancelMsg = cancelMsg.replace(/{{customer_name}}/g, customerName);

                if (cancelTemplate.isPoll && cancelTemplate.pollOptions?.length > 0) {
                    await whatsappService.sendPoll(shopDomain, customerPhoneFormatted, cancelMsg, cancelTemplate.pollOptions, orderId);
                } else {
                    await whatsappService.sendMessage(shopDomain, customerPhoneFormatted, cancelMsg);
                }

                if (merchant?.shopifyAccessToken && orderId) {
                    await shopifyService.addOrderTag(shopDomain, merchant.shopifyAccessToken, orderId, merchant.orderCancelTag || "Order Cancelled", [merchant.pendingConfirmTag, merchant.orderConfirmTag]);
                }
            } catch (err) {
                console.error(`[ShopifyWebhook] Error processing cancellation:`, err);
            }
        })();
        return;
    } else if (topic === "checkouts/abandoned") {
        const orderId = order.id?.toString() || order.checkout_id?.toString();

        // Idempotency Check
        if (orderId && await isDuplicateWebhook(merchant._id, orderId, topic)) {
            console.log(`[ShopifyWebhook] Duplicate checkouts/abandoned for ${orderId}. Skipping.`);
            return res.status(200).send('ok');
        }

        await logEvent("pending", req, shopDomain);
        res.status(200).send("ok");

        (async () => {
            try {
                // Abandoned cart often needs a different set of data, but we use the helper for consistency
                const abandonedTemplate = await Template.findOne({ merchant: merchant._id, event: "checkouts/abandoned" });
                if (abandonedTemplate && abandonedTemplate.enabled && customerPhoneFormatted) {
                    let abandonedMsg = abandonedTemplate.message;
                    abandonedMsg = replacePlaceholders(abandonedMsg, { order, merchant });
                    abandonedMsg = abandonedMsg.replace(/{{customer_name}}/g, customerName);

                    // Usage check for abandoned cart
                    const planConfig = await Plan.findOne({ id: merchant.plan || 'free' });
                    const currentLimit = planConfig ? planConfig.messageLimit : (merchant.trialLimit || 10);
                    if ((merchant.usage || 0) >= currentLimit) {
                        console.warn(`[ShopifyWebhook] Limit reached for ${shopDomain} (Abandoned Cart blocked)`);
                        return;
                    }

                    let result;
                    if (abandonedTemplate.isPoll && abandonedTemplate.pollOptions?.length > 0) {
                        result = await whatsappService.sendPoll(shopDomain, customerPhoneFormatted, abandonedMsg, abandonedTemplate.pollOptions, orderId);
                    } else {
                        result = await whatsappService.sendMessage(shopDomain, customerPhoneFormatted, abandonedMsg);
                    }

                    if (result?.success) {
                        await Merchant.updateOne({ shopDomain }, { $inc: { usage: 1, trialUsage: merchant.plan === 'trial' ? 1 : 0 } });
                        await automationService.trackSent(shopDomain, "abandoned_cart");
                    }
                }
            } catch (err) {
                console.error(`[ShopifyWebhook] Error processing abandoned cart for ${shopDomain}:`, err);
            }
        })();
        return;
    } else if (topic === "fulfillments/update" || topic === "fulfillments/create") {
        const orderId = order.id?.toString() || order.order_id?.toString();

        if (orderId && await isDuplicateWebhook(merchant._id, orderId, topic)) {
            console.log(`[ShopifyWebhook] Duplicate fulfillments/update for ${orderId}. Skipping.`);
            return res.status(200).send('ok');
        }

        await logEvent("confirmed", req, shopDomain);
        res.status(200).send("ok");

        (async () => {
            try {
                const setting = await AutomationSetting.findOne({ shopDomain, type: "shipment-update" }) || await AutomationSetting.findOne({ shopDomain, type: "fulfillment_update" });
                const template = await Template.findOne({ merchant: merchant._id, event: "fulfillments/update" });

                if (!setting?.enabled || !template?.enabled) {
                    console.log(`[ShopifyWebhook] Fulfillment skipped: setting=${!!setting?.enabled}, template=${!!template?.enabled}`);
                    return;
                }

                if (!customerPhoneFormatted) {
                    console.warn(`[ShopifyWebhook] Cannot send fulfillment: No phone number for ${orderNumber}`);
                    return;
                }

                // Plan limit check
                const planConfig = await Plan.findOne({ id: merchant.plan || 'free' });
                const currentLimit = planConfig ? planConfig.messageLimit : (merchant.trialLimit || 10);
                if ((merchant.usage || 0) >= currentLimit) {
                    console.warn(`[ShopifyWebhook] Limit reached for ${shopDomain} (Fulfillment blocked)`);
                    return;
                }

                let fulfillmentMsg = template.message;
                fulfillmentMsg = replacePlaceholders(fulfillmentMsg, { order, merchant });
                fulfillmentMsg = fulfillmentMsg.replace(/{{customer_name}}/g, customerName);

                const result = template.isPoll ? await whatsappService.sendPoll(shopDomain, customerPhoneFormatted, fulfillmentMsg, template.pollOptions, orderId) : await whatsappService.sendMessage(shopDomain, customerPhoneFormatted, fulfillmentMsg);

                if (result?.success) {
                    await Merchant.updateOne({ shopDomain }, { $inc: { usage: 1, trialUsage: merchant.plan === 'trial' ? 1 : 0 } });
                    await automationService.trackSent(shopDomain, "fulfillment_update");
                }
            } catch (err) {
                console.error(`[ShopifyWebhook] Error processing fulfillment:`, err);
            }
        })();
        return;
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

/**
 * MANDATORY GDPR WEBHOOKS
 * Required for Shopify App Store Compliance
 */

// 1. Customers Data Request (GDPR)
router.post("/gdpr/customers_data_request", verifyShopifyWebhook, async (req, res) => {
    console.log(`[GDPR] Customer Data Request received for shop: ${req.headers["x-shopify-shop-domain"]}`);
    // No sensitive data is stored long-term in this app outside of order logs. 
    // Usually, you respond with 200 and handle the request asynchronously if needed.
    res.status(200).send("ok");
});

// 2. Customers Redact (GDPR)
router.post("/gdpr/customers_redact", verifyShopifyWebhook, async (req, res) => {
    const { customer, shop_domain } = req.body;
    console.log(`[GDPR] Customer Redact requested for ${customer?.email} on ${shop_domain}`);

    try {
        if (customer?.phone) {
            const formattedPhone = customer.phone.replace(/\D/g, '');
            // Optional: Remove specific customer from contacts if your DB has them
            await Contact.deleteMany({ phone: { $regex: new RegExp(formattedPhone) } });
            await ActivityLog.deleteMany({ customerPhone: { $regex: new RegExp(formattedPhone) } });
            console.log(`[GDPR] Deleted data for customer: ${customer.email}`);
        }
    } catch (err) {
        console.error(`[GDPR] Redact failed:`, err);
    }

    res.status(200).send("ok");
});

// 3. Shop Redact (GDPR)
router.post("/gdpr/shop_redact", verifyShopifyWebhook, async (req, res) => {
    const { shop_domain } = req.body;
    console.log(`[GDPR] Shop Redact requested for ${shop_domain}. (Wait 48h as per policy)`);

    try {
        // Mark as fully deleted or remove data after 48h
        // For now, we ensure the merchant is inactive
        await Merchant.findOneAndUpdate({ shopDomain: shop_domain }, { isActive: false, shopifyAccessToken: null });
    } catch (err) {
        console.error(`[GDPR] Shop Redact failed:`, err);
    }

    res.status(200).send("ok");
});

export default router;
