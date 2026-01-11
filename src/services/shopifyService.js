import axios from "axios";

class ShopifyService {
    /**
     * Appends a tag to a Shopify order.
     * @param {string} shopDomain - The shop's domain (e.g., store.myshopify.com)
     * @param {string} accessToken - The Shopify Admin API access token
     * @param {string} orderId - The ID of the order to update
     * @param {string} newTag - The tag to add
     */
    async addOrderTag(shopDomain, accessToken, orderId, newTag, removeConflictingTags = true) {
        if (!accessToken) {
            console.warn(`No access token for ${shopDomain}, skipping tagging.`);
            return { success: false, error: "Missing access token" };
        }

        try {
            // 1. Get current tags
            const url = `https://${shopDomain}/admin/api/2023-10/orders/${orderId}.json`;
            const getResponse = await axios.get(url, {
                headers: { "X-Shopify-Access-Token": accessToken }
            });

            const currentTags = getResponse.data.order.tags || "";
            let tagArray = currentTags.split(",").map(t => t.trim()).filter(t => t);

            // 2. Remove conflicting tags if needed
            if (removeConflictingTags) {
                const orderStatusTags = [
                    "Pending Order Confirmation",
                    "Order Confirmed",
                    "Order Cancelled",
                    "Order Rejected",
                    "Pending Confirmation", // Legacy tag
                    "Confirmed", // Legacy tag
                    "Cancelled" // Legacy tag
                ];

                // Remove all order status tags except the new one
                tagArray = tagArray.filter(tag => !orderStatusTags.includes(tag));
            }

            // 3. Add new tag if not already present
            if (!tagArray.includes(newTag)) {
                tagArray.push(newTag);
            }

            // 4. Update order
            const putResponse = await axios.put(url, {
                order: {
                    id: orderId,
                    tags: tagArray.join(", ")
                }
            }, {
                headers: { "X-Shopify-Access-Token": accessToken }
            });

            console.log(`Successfully added tag "${newTag}" to order ${orderId} on ${shopDomain}`);
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
