import { Router } from "express";
import { Feedback } from "../models/Feedback.js";
import { Merchant } from "../models/Merchant.js";

const router = Router();

// Helper to resolve merchant
const getMerchant = async (req) => {
    const shop = req.query.shop || req.headers["x-shop-domain"];
    if (!shop) return null;
    return await Merchant.findOne({
        shopDomain: { $regex: new RegExp(`^${shop}$`, "i") }
    });
};

// GET /api/feedback - List feedback for a merchant
router.get("/", async (req, res) => {
    try {
        const merchant = await getMerchant(req);
        if (!merchant) return res.status(400).json({ error: "Invalid shop" });

        const feedbacks = await Feedback.find({ merchant: merchant._id })
            .sort({ createdAt: -1 })
            .limit(100);

        res.json(feedbacks);
    } catch (err) {
        console.error("Error fetching feedback", err);
        res.status(500).json({ error: "Internal server error" });
    }
});

// GET /api/feedback/stats - Feedback summary
router.get("/stats", async (req, res) => {
    try {
        const merchant = await getMerchant(req);
        if (!merchant) return res.status(400).json({ error: "Invalid shop" });

        const stats = await Feedback.aggregate([
            { $match: { merchant: merchant._id } },
            {
                $group: {
                    _id: null,
                    averageRating: { $avg: "$rating" },
                    totalFeedback: { $sum: 1 },
                    positiveCount: {
                        $sum: { $cond: [{ $gte: ["$rating", 4] }, 1, 0] }
                    }
                }
            }
        ]);

        res.json(stats[0] || { averageRating: 0, totalFeedback: 0, positiveCount: 0 });
    } catch (err) {
        res.status(500).json({ error: "Internal server error" });
    }
});

export default router;
