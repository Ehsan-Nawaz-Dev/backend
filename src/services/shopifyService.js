import axios from "axios";
import { Merchant } from "../models/Merchant.js";

class ShopifyService {
    /**
     * Appends a tag to a Shopify order.
     * @param {string} shopDomain - The shop's domain (e.g., store.myshopify.com)
     * @param {string} accessToken - The Shopify Admin API access token
     * @param {string|number} orderId - The ID of the order to update
     * @param {string} newTag - The tag to add
     */
    async addOrderTag(shopDomain, accessToken, orderId, newTag, extraTagsToRemove = []) {
        console.log(`[ShopifyService] addOrderTag called with:`, {
            shopDomain,
            hasAccessToken: !!accessToken,
            accessTokenLength: accessToken?.length,
            orderId,
            orderIdType: typeof orderId,
            newTag
        });

        if (!accessToken) {
            console.error(`[ShopifyService] ERROR: No access token for ${shopDomain}, skipping tagging.`);
            return { success: false, error: "Missing access token" };
        }

        if (!orderId) {
            console.error(`[ShopifyService] ERROR: No orderId provided for tagging on ${shopDomain}.`);
            return { success: false, error: "Missing orderId" };
        }

        // Ensure orderId is a string number (not a GID)
        let numericOrderId = orderId;
        if (typeof orderId === 'string' && orderId.includes('/')) {
            // Extract numeric ID from GID format like "gid://shopify/Order/123456"
            numericOrderId = orderId.split('/').pop();
        }
        numericOrderId = String(numericOrderId);

        try {
            console.log(`[ShopifyService] Adding tag "${newTag}" to order ${numericOrderId} on ${shopDomain}`);

            // 1. Get current tags
            const url = `https://${shopDomain}/admin/api/2024-01/orders/${numericOrderId}.json`;
            console.log(`[ShopifyService] GET ${url}`);

            const getResponse = await axios.get(url, {
                headers: { "X-Shopify-Access-Token": accessToken }
            });

            if (!getResponse.data.order) {
                throw new Error(`Order ${numericOrderId} not found on ${shopDomain}`);
            }

            const currentTags = getResponse.data.order.tags || "";
            let tagArray = currentTags.split(",").map(t => t.trim()).filter(t => t);

            console.log(`[ShopifyService] Current tags: "${currentTags}"`);

            // 2. Define tags to remove (defaults + extra merchant-specific tags)
            const defaultStatusTags = [
                "Pending Order Confirmation",
                "Order Confirmed",
                "Order Cancelled",
                "Order Rejected",
                "Pending Confirmation",
                "Confirmed",
                "Cancelled",
                "Order Cancel By customer"
            ];

            const tagsToRemove = [...new Set([...defaultStatusTags, ...extraTagsToRemove.filter(t => t)])];

            // Remove old status tags
            tagArray = tagArray.filter(tag => !tagsToRemove.includes(tag) || tag === newTag);

            // 3. Add new tag if not already present
            if (!tagArray.includes(newTag)) {
                tagArray.push(newTag);
            }

            const finalTags = tagArray.join(", ");
            console.log(`[ShopifyService] Final tags to set: "${finalTags}"`);

            // 4. Update order
            console.log(`[ShopifyService] PUT ${url}`);
            const putResponse = await axios.put(url, {
                order: {
                    id: numericOrderId,
                    tags: finalTags
                }
            }, {
                headers: { "X-Shopify-Access-Token": accessToken }
            });

            console.log(`[ShopifyService] SUCCESS - Tags updated for order ${numericOrderId}`);
            return { success: true, data: putResponse.data.order };
        } catch (error) {
            const errorDetails = error.response?.data || error.message;
            console.error(`[ShopifyService] ERROR adding tag to order ${numericOrderId}:`, errorDetails);

            // Check if this is an invalid token error
            await this.handlePotentialAuthError(shopDomain, error);

            return { success: false, error: JSON.stringify(errorDetails) };
        }
    }

    /**
     * Checks if an error is due to invalid authentication and marks merchant for re-auth
     * @param {string} shopDomain - The shop's domain
     * @param {Error} error - The axios error object
     */
    async handlePotentialAuthError(shopDomain, error) {
        const errorData = error.response?.data;
        const errorString = JSON.stringify(errorData || error.message).toLowerCase();

        // Detect various forms of authentication errors
        const isAuthError =
            error.response?.status === 401 ||
            errorString.includes('invalid api key') ||
            errorString.includes('access token') ||
            errorString.includes('unauthorized') ||
            errorString.includes('unrecognized login');

        if (isAuthError && shopDomain) {
            console.error(`[ShopifyService] 🚨 AUTH ERROR DETECTED for ${shopDomain} - Marking for re-authorization`);

            try {
                await Merchant.findOneAndUpdate(
                    { shopDomain },
                    {
                        needsReauth: true,
                        reauthReason: 'Invalid or expired Shopify access token',
                        reauthDetectedAt: new Date()
                    }
                );
                console.log(`[ShopifyService] Merchant ${shopDomain} marked for re-authorization`);
            } catch (dbError) {
                console.error(`[ShopifyService] Failed to mark merchant for reauth:`, dbError.message);
            }
        }
    }

    /**
     * Fetches order details from Shopify.
     */
    async getOrder(shopDomain, accessToken, orderId) {
        try {
            const url = `https://${shopDomain}/admin/api/2024-01/orders/${orderId}.json`;
            const response = await axios.get(url, {
                headers: { "X-Shopify-Access-Token": accessToken }
            });
            return response.data.order;
        } catch (error) {
            console.error(`Error fetching Shopify order ${orderId}:`, error.message);

            // Check if this is an invalid token error
            await this.handlePotentialAuthError(shopDomain, error);

            return null;
        }
    }

    /**
     * Registers a webhook with Shopify
     */
    async registerWebhook(shopDomain, accessToken, topic, callbackUrl) {
        try {
            const url = `https://${shopDomain}/admin/api/2024-01/webhooks.json`;
            const response = await axios.post(url, {
                webhook: {
                    topic: topic,
                    address: callbackUrl,
                    format: "json"
                }
            }, {
                headers: { "X-Shopify-Access-Token": accessToken }
            });
            console.log(`[ShopifyService] Registered webhook: ${topic}`);
            return { success: true, data: response.data.webhook };
        } catch (error) {
            // Webhook might already exist
            if (error.response?.status === 422) {
                console.log(`[ShopifyService] Webhook ${topic} already exists`);
                return { success: true, existing: true };
            }
            console.error(`[ShopifyService] Error registering webhook ${topic}:`, error.response?.data || error.message);
            return { success: false, error: error.message };
        }
    }

    /**
     * Gets shop information from Shopify
     */
    async getShopInfo(shopDomain, accessToken) {
        try {
            const url = `https://${shopDomain}/admin/api/2023-10/shop.json`;
            const response = await axios.get(url, {
                headers: { "X-Shopify-Access-Token": accessToken }
            });
            return response.data.shop;
        } catch (error) {
            console.error(`[ShopifyService] Error getting shop info:`, error.message);
            return null;
        }
    }

    /**
     * Complete auto-setup for a new merchant installation
     * Registers all required webhooks automatically
     */
    async autoSetupMerchant(shopDomain, accessToken, webhookBaseUrl) {
        console.log(`[ShopifyService] Starting auto-setup for ${shopDomain}...`);

        const webhooks = [
            { topic: "orders/create", path: "/api/webhooks/shopify" },
            { topic: "orders/cancelled", path: "/api/webhooks/shopify" },
            { topic: "orders/updated", path: "/api/webhooks/shopify" },
            { topic: "checkouts/create", path: "/api/webhooks/shopify" },
            { topic: "fulfillments/create", path: "/api/webhooks/shopify" },
            { topic: "fulfillments/update", path: "/api/webhooks/shopify" },
            { topic: "app/uninstalled", path: "/api/webhooks/shopify" }
        ];

        const results = [];
        for (const webhook of webhooks) {
            const callbackUrl = `${webhookBaseUrl}${webhook.path}`;
            const result = await this.registerWebhook(shopDomain, accessToken, webhook.topic, callbackUrl);
            results.push({ topic: webhook.topic, ...result });
        }

        // Get shop info to save store name
        const shopInfo = await this.getShopInfo(shopDomain, accessToken);

        console.log(`[ShopifyService] Auto-setup complete for ${shopDomain}`);
        return {
            webhooks: results,
            shopInfo: shopInfo
        };
    }
}

export const shopifyService = new ShopifyService();
