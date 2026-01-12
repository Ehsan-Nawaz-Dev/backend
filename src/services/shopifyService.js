import axios from "axios";

class ShopifyService {
    /**
     * Appends a tag to a Shopify order.
     * @param {string} shopDomain - The shop's domain (e.g., store.myshopify.com)
     * @param {string} accessToken - The Shopify Admin API access token
     * @param {string} orderId - The ID of the order to update
     * @param {string} newTag - The tag to add
     */
    async addOrderTag(shopDomain, accessToken, orderId, newTag, extraTagsToRemove = []) {
        if (!accessToken) {
            console.warn(`No access token for ${shopDomain}, skipping tagging.`);
            return { success: false, error: "Missing access token" };
        }

        if (!orderId) {
            console.warn(`No orderId provided for tagging on ${shopDomain}.`);
            return { success: false, error: "Missing orderId" };
        }

        try {
            console.log(`[ShopifyService] Adding tag "${newTag}" to order ${orderId} on ${shopDomain}`);

            // 1. Get current tags
            const url = `https://${shopDomain}/admin/api/2023-10/orders/${orderId}.json`;
            const getResponse = await axios.get(url, {
                headers: { "X-Shopify-Access-Token": accessToken }
            });

            if (!getResponse.data.order) {
                throw new Error(`Order ${orderId} not found on ${shopDomain}`);
            }

            const currentTags = getResponse.data.order.tags || "";
            let tagArray = currentTags.split(",").map(t => t.trim()).filter(t => t);

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

            console.log(`[ShopifyService] Current tags: ${currentTags}. Removing: ${tagsToRemove.join(", ")}`);

            // Remove tags and only keep the new one (if it was already there, we filter inclusive of it then push it later)
            tagArray = tagArray.filter(tag => !tagsToRemove.includes(tag) || tag === newTag);

            // 3. Add new tag if not already present
            if (!tagArray.includes(newTag)) {
                tagArray.push(newTag);
            }

            const finalTags = tagArray.join(", ");
            console.log(`[ShopifyService] Final tags to preserve: ${finalTags}`);

            // 4. Update order
            const putResponse = await axios.put(url, {
                order: {
                    id: orderId,
                    tags: finalTags
                }
            }, {
                headers: { "X-Shopify-Access-Token": accessToken }
            });

            console.log(`Successfully updated tags for order ${orderId} on ${shopDomain}`);
            return { success: true, data: putResponse.data.order };
        } catch (error) {
            console.error(`Error adding tag to Shopify order ${orderId}:`, error.response?.data || error.message);
            return { success: false, error: error.message };
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
