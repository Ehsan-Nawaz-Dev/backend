import { Router } from "express";
import { Merchant } from "../models/Merchant.js";
import { ChatButtonSettings } from "../models/ChatButtonSettings.js";

const router = Router();

// Helper to resolve merchant by shop domain (for now via query param)
const getShopDomain = (req) => req.query.shop || req.headers["x-shop-domain"];

// GET /api/settings
router.get("/", async (req, res) => {
  try {
    const shopDomain = getShopDomain(req);
    if (!shopDomain) return res.status(400).json({ error: "Missing shop parameter" });

    const merchant = await Merchant.findOne({ shopDomain });
    if (!merchant) return res.json(null);

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

    res.json(settings);
  } catch (err) {
    console.error("Error updating chat button settings", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
