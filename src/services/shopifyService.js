import axios from "axios";

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
            const url = `https://${shopDomain}/admin/api/2023-10/orders/${numericOrderId}.json`;
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
                "Cancelled"
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
            return { success: false, error: JSON.stringify(errorDetails) };
        }
    }

    /**
     * Fetches order details from Shopify.
     */
    async getOrder(shopDomain, accessToken, orderId) {
        try {
            const url = `https://${shopDomain}/admin/api/2023-10/orders/${orderId}.json`;
            const response = await axios.get(url, {
                headers: { "X-Shopify-Access-Token": accessToken }
            });
            return response.data.order;
        } catch (error) {
            console.error(`Error fetching Shopify order ${orderId}:`, error.message);
            return null;
        }
    }
}

export const shopifyService = new ShopifyService();
