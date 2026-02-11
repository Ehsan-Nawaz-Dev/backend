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
        const settings = await AutomationSetting.find({ shopDomain });

        const types = [
            { id: "admin-order-alert", name: "Admin Order Alert" },
            { id: "order-confirmation", name: "Order Confirmation" },
            { id: "order-confirmed-reply", name: "Post-Confirmation Reply" },
            { id: "abandoned_cart", name: "Abandoned Cart" },
            { id: "fulfillment_update", name: "Shipping Update" },
            { id: "cancellation", name: "Order Cancellation" }
        ];

        const formattedStats = types.map(t => {
            const stat = stats.find(s => s.type === t.id);
            const setting = settings.find(s => s.type === t.id);

            return {
                id: t.id,
                name: t.name,
                sent: stat ? stat.sent : 0,
                recovered: stat ? stat.recovered : 0,
                revenue: stat ? stat.revenue : 0,
                enabled: setting ? setting.enabled : false
            };
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
        const { id, enabled, type } = req.body;
        const automationType = id || type; // Support both for compatibility

        if (!shopDomain) return res.status(400).json({ error: "Missing shop parameter" });
        if (!automationType) return res.status(400).json({ error: "Missing automation identification (id or type)" });

        const setting = await AutomationSetting.findOneAndUpdate(
            { shopDomain, type: automationType },
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
