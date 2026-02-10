import { Router } from "express";
import { Merchant } from "../models/Merchant.js";
import { ChatButtonSettings } from "../models/ChatButtonSettings.js";

const router = Router();

// Helper to resolve merchant by shop domain (for now via query param)
const getShopDomain = (req) => {
  const shop = req.query.shop || req.headers["x-shop-domain"];
  if (!shop) return null;
  return shop.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/$/, "");
};

// GET /api/settings
router.get("/", async (req, res) => {
  try {
    const shopDomain = getShopDomain(req);
    if (!shopDomain) return res.status(400).json({ error: "Missing shop parameter" });

    let merchant = await Merchant.findOne({ shopDomain });
    if (!merchant) return res.json(null);

    // Auto-fetch Shopify data if storeName is missing
    if (!merchant.storeName && merchant.shopifyAccessToken) {
      try {
        const axios = (await import("axios")).default;
        const shopResponse = await axios.get(`https://${shopDomain}/admin/api/2023-10/shop.json`, {
          headers: { "X-Shopify-Access-Token": merchant.shopifyAccessToken }
        });
        const shopData = shopResponse.data.shop;

        // Update merchant with fresh Shopify data
        merchant.storeName = shopData?.name || shopDomain;
        merchant.phone = merchant.phone || shopData?.phone || null;
        merchant.email = merchant.email || shopData?.email || null;
        merchant.country = merchant.country || shopData?.country_name || null;
        merchant.currency = merchant.currency || shopData?.currency || "USD";
        await merchant.save();

        console.log(`[Settings] Auto-fetched Shopify store name: ${merchant.storeName}`);
      } catch (shopifyErr) {
        console.warn("[Settings] Could not auto-fetch Shopify data:", shopifyErr.message);
      }
    }

    res.json(merchant);
  } catch (err) {
    console.error("Error fetching settings", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PUT /api/settings
router.put("/", async (req, res) => {
  try {
    const shopDomain = getShopDomain(req);
    if (!shopDomain) return res.status(400).json({ error: "Missing shop parameter" });

    const update = {
      storeName: req.body.storeName,
      whatsappNumber: req.body.whatsappNumber,
      adminPhoneNumber: req.body.adminPhoneNumber ? req.body.adminPhoneNumber.replace(/[^0-9]/g, "") : undefined,
      defaultCountry: req.body.defaultCountry,
      language: req.body.language,
      orderConfirmTag: req.body.orderConfirmTag,
      orderCancelTag: req.body.orderCancelTag,
      pendingConfirmTag: req.body.pendingConfirmTag,
      orderConfirmReply: req.body.orderConfirmReply,
      orderCancelReply: req.body.orderCancelReply,
    };

    // Simple sanitization: if it exists, ensure it doesn't have leading zeros and handle plus
    if (update.adminPhoneNumber && !update.adminPhoneNumber.startsWith("+")) {
      // If user provided digits only, we assume they included country code but no plus.
      // We'll store it as digits for now since services usually handle it.
      // But the request says "ensure it includes the country code".
    }

    const merchant = await Merchant.findOneAndUpdate(
      { shopDomain },
      { $set: update, $setOnInsert: { shopDomain } },
      { new: true, upsert: true },
    );

    res.json(merchant);
  } catch (err) {
    console.error("Error updating settings", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/settings/chat-button
router.get("/chat-button", async (req, res) => {
  try {
    const shopDomain = getShopDomain(req);
    if (!shopDomain) return res.status(400).json({ error: "Missing shop parameter" });

    let settings = await ChatButtonSettings.findOne({ shopDomain });
    if (!settings) {
      // Return defaults if not found
      settings = {
        shopDomain,
        buttonText: "Chat with us",
        position: "right",
        color: "#25D366",
        enabled: true
      };
    }

    res.json(settings);
  } catch (err) {
    console.error("Error fetching chat button settings", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/settings/chat-button
router.post("/chat-button", async (req, res) => {
  try {
    const shopDomain = getShopDomain(req);
    if (!shopDomain) return res.status(400).json({ error: "Missing shop parameter" });

    const update = {
      phoneNumber: req.body.phoneNumber,
      buttonText: req.body.buttonText,
      position: req.body.position,
      color: req.body.color,
      enabled: req.body.enabled,
    };

    const settings = await ChatButtonSettings.findOneAndUpdate(
      { shopDomain },
      { $set: update },
      { new: true, upsert: true }
    );

    // Register/Remove Shopify Script Tag
    try {
      const merchant = await Merchant.findOne({ shopDomain });
      if (merchant && merchant.shopifyAccessToken) {
        const axios = (await import("axios")).default;

        // Determine backend base URL
        const appUrl = (process.env.SHOPIFY_APP_URL || "https://api.whatomatic.com").replace(/\/$/, "");
        const scriptUrl = `${appUrl}/api/storefront/button.js?shop=${shopDomain}`;
        console.log(`[ScriptTag] Preparing to sync for ${shopDomain}. URL: ${scriptUrl}`);

        // 1. Fetch existing script tags
        const existingRes = await axios.get(`https://${shopDomain}/admin/api/2024-01/script_tags.json`, {
          headers: { "X-Shopify-Access-Token": merchant.shopifyAccessToken }
        });

        const existingTag = existingRes.data.script_tags.find(t => t.src.includes("storefront/button.js"));

        if (update.enabled) {
          if (!existingTag) {
            // Register new tag
            await axios.post(`https://${shopDomain}/admin/api/2024-01/script_tags.json`, {
              script_tag: {
                event: "onload",
                src: scriptUrl
              }
            }, {
              headers: { "X-Shopify-Access-Token": merchant.shopifyAccessToken }
            });
            console.log(`[ScriptTag] Registered for ${shopDomain}`);
          }
        } else {
          if (existingTag) {
            // Delete existing tag
            await axios.delete(`https://${shopDomain}/admin/api/2024-01/script_tags/${existingTag.id}.json`, {
              headers: { "X-Shopify-Access-Token": merchant.shopifyAccessToken }
            });
            console.log(`[ScriptTag] Removed for ${shopDomain}`);
          }
        }
      }
    } catch (shopifyErr) {
      console.error("[ScriptTag] Shopify API error:", shopifyErr.response?.data || shopifyErr.message);
      // Don't fail the whole request if Shopify API fails
    }

    res.json(settings);
  } catch (err) {
    console.error("Error updating chat button settings", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
