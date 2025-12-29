import { Router } from "express";
import { Merchant } from "../models/Merchant.js";
import { Template } from "../models/Template.js";

const router = Router();

const getShopDomain = (req) => req.query.shop || req.headers["x-shop-domain"];

// GET /api/templates
router.get("/", async (req, res) => {
  try {
    const shopDomain = getShopDomain(req);
    if (!shopDomain) return res.status(400).json({ error: "Missing shop parameter" });

    const merchant = await Merchant.findOne({ shopDomain });
    if (!merchant) return res.json([]);

    const templates = await Template.find({ merchant: merchant._id }).sort({ createdAt: -1 });
    res.json(templates);
  } catch (err) {
    console.error("Error fetching templates", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/templates
router.post("/", async (req, res) => {
  try {
    const shopDomain = getShopDomain(req);
    if (!shopDomain) return res.status(400).json({ error: "Missing shop parameter" });

    let merchant = await Merchant.findOne({ shopDomain });
    if (!merchant) {
      merchant = await Merchant.create({ shopDomain });
    }

    const template = await Template.create({
      merchant: merchant._id,
      name: req.body.name,
      event: req.body.event,
      message: req.body.message,
      enabled: req.body.enabled ?? true,
    });

    res.status(201).json(template);
  } catch (err) {
    console.error("Error creating template", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PUT /api/templates/:id
router.put("/:id", async (req, res) => {
  try {
    const template = await Template.findByIdAndUpdate(
      req.params.id,
      {
        name: req.body.name,
        event: req.body.event,
        message: req.body.message,
        enabled: req.body.enabled,
      },
      { new: true },
    );

    if (!template) return res.status(404).json({ error: "Template not found" });

    res.json(template);
  } catch (err) {
    console.error("Error updating template", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /api/templates/:id
router.delete("/:id", async (req, res) => {
  try {
    const template = await Template.findByIdAndDelete(req.params.id);
    if (!template) return res.status(404).json({ error: "Template not found" });

    res.json({ success: true });
  } catch (err) {
    console.error("Error deleting template", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
