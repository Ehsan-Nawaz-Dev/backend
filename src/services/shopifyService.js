import axios from "axios";

class ShopifyService {
    /**
     * Appends a tag to a Shopify order.
     * @param {string} shopDomain - The shop's domain (e.g., store.myshopify.com)
     * @param {string} accessToken - The Shopify Admin API access token
     * @param {string} orderId - The ID of the order to update
     * @param {string} newTag - The tag to add
     */
    async addOrderTag(shopDomain, accessToken, orderId, newTag) {
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
            const tagArray = currentTags.split(",").map(t => t.trim()).filter(t => t);

            // 2. Add if not already present
            if (!tagArray.includes(newTag)) {
                tagArray.push(newTag);
            }

            // 3. Update order
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
}

export const shopifyService = new ShopifyService();
