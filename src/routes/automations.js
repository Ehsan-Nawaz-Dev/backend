import { Router } from "express";
import { AutomationStat } from "../models/AutomationStat.js";
import { AutomationSetting } from "../models/AutomationSetting.js";

const router = Router();

const getShopDomain = (req) => req.query.shop || req.headers["x-shop-domain"];

// GET /api/automations/stats
router.get("/stats", async (req, res) => {
    try {
        const shopDomain = getShopDomain(req);
        if (!shopDomain) return res.status(400).json({ error: "Missing shop parameter" });

        const stats = await AutomationStat.find({ shopDomain });

        // Group stats by type for easier consumption
        const formattedStats = {
            abandoned_cart: { sent: 0, recovered: 0, revenue: 0 },
            order_confirmation: { sent: 0 },
            fulfillment_update: { sent: 0 }
        };

        stats.forEach(stat => {
            if (formattedStats[stat.type]) {
                formattedStats[stat.type].sent = stat.sent;
                if (stat.type === "abandoned_cart") {
                    formattedStats[stat.type].recovered = stat.recovered;
                    formattedStats[stat.type].revenue = stat.revenue;
                }
            }
        });

        res.json(formattedStats);
    } catch (err) {
        console.error("Error fetching automation stats", err);
        res.status(500).json({ error: "Internal server error" });
    }
});

// PUT /api/automations/toggle
router.put("/toggle", async (req, res) => {
    try {
        const shopDomain = getShopDomain(req);
        const { type, enabled } = req.body;

        if (!shopDomain) return res.status(400).json({ error: "Missing shop parameter" });
        if (!type) return res.status(400).json({ error: "Missing type parameter" });

        const setting = await AutomationSetting.findOneAndUpdate(
            { shopDomain, type },
            { enabled },
            { upsert: true, new: true }
        );

        res.json(setting);
    } catch (err) {
        console.error("Error toggling automation", err);
        res.status(500).json({ error: "Internal server error" });
    }
});

export default router;
