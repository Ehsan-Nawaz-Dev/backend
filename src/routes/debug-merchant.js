import { Router } from "express";
import { Merchant } from "../models/Merchant.js";

const router = Router();

/**
 * Debug endpoint to check merchant configuration
 * GET /api/debug/merchant?shop=ezone-9374.myshopify.com
 */
router.get("/merchant", async (req, res) => {
    try {
        const { shop } = req.query;

        if (!shop) {
            return res.status(400).json({ error: "Missing shop parameter" });
        }

        const merchant = await Merchant.findOne({ shopDomain: shop });

        if (!merchant) {
            return res.status(404).json({
                error: "Merchant not found",
                shop: shop,
                suggestion: "Please complete OAuth flow first"
            });
        }

        // Return diagnostic info (hide sensitive data)
        const diagnostics = {
            shopDomain: merchant.shopDomain,
            storeName: merchant.storeName,
            hasAccessToken: !!merchant.shopifyAccessToken,
            accessTokenLength: merchant.shopifyAccessToken?.length || 0,
            accessTokenPreview: merchant.shopifyAccessToken ?
                `${merchant.shopifyAccessToken.substring(0, 10)}...` : null,
            tags: {
                pendingConfirmTag: merchant.pendingConfirmTag,
                orderConfirmTag: merchant.orderConfirmTag,
                orderCancelTag: merchant.orderCancelTag
            },
            whatsappSettings: {
                whatsappNumber: merchant.whatsappNumber,
                adminPhoneNumber: merchant.adminPhoneNumber,
                whatsappProvider: merchant.whatsappProvider
            },
            isActive: merchant.isActive,
            installedAt: merchant.installedAt,
            createdAt: merchant.createdAt,
            updatedAt: merchant.updatedAt
        };

        res.json({
            success: true,
            diagnostics,
            recommendations: generateRecommendations(merchant)
        });

    } catch (error) {
        console.error("[Debug] Error fetching merchant:", error);
        res.status(500).json({
            error: "Internal server error",
            message: error.message
        });
    }
});

function generateRecommendations(merchant) {
    const recommendations = [];

    if (!merchant.shopifyAccessToken) {
        recommendations.push({
            severity: "CRITICAL",
            issue: "Missing Shopify Access Token",
            solution: `Visit: ${process.env.SHOPIFY_APP_URL}/api/auth/shopify?shop=${merchant.shopDomain}`
        });
    }

    if (!merchant.pendingConfirmTag || merchant.pendingConfirmTag === "Pending Confirmation") {
        recommendations.push({
            severity: "WARNING",
            issue: "Using old default tag",
            solution: "Re-run OAuth to update to 'Order Pending'"
        });
    }

    if (!merchant.whatsappNumber) {
        recommendations.push({
            severity: "INFO",
            issue: "No WhatsApp number configured",
            solution: "Configure WhatsApp in dashboard settings"
        });
    }

    return recommendations;
}

export default router;
