import { Router } from "express";
import { Merchant } from "../models/Merchant.js";

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
      defaultCountry: req.body.defaultCountry,
      language: req.body.language,
      orderConfirmTag: req.body.orderConfirmTag,
      orderCancelTag: req.body.orderCancelTag,
    };

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

export default router;
