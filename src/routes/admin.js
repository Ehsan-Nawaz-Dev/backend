import { Router } from "express";
import { Merchant } from "../models/Merchant.js";
import { ActivityLog } from "../models/ActivityLog.js";
import { WhatsAppSession } from "../models/WhatsAppSession.js";
import { Plan } from "../models/Plan.js";

const router = Router();

// GET /api/admin/merchants - List all merchants with connection status
router.get("/merchants", async (req, res) => {
    try {
        const merchants = await Merchant.find().sort({ createdAt: -1 }).lean();
        const sessions = await WhatsAppSession.find().lean();
        const plans = await Plan.find().lean();

        const planMap = plans.reduce((acc, p) => {
            acc[p.id] = p.messageLimit;
            return acc;
        }, {});

        // Map sessions to merchants
        const enrichedMerchants = merchants.map(merchant => {
            const session = sessions.find(s => s.shopDomain === merchant.shopDomain);
            // Limit is either trialLimit (for trial/new) or plan.messageLimit
            const limit = merchant.plan === 'trial' || !merchant.plan || merchant.plan === 'none' || merchant.plan === 'free'
                ? (merchant.trialLimit || 10)
                : (planMap[merchant.plan] || 0);

            return {
                ...merchant,
                limit,
                isConnected: session?.isConnected || false,
                lastConnected: session?.lastConnected,
                status: session?.status || 'disconnected'
            };
        });

        res.json(enrichedMerchants);
    } catch (err) {
        console.error("Admin: Error fetching merchants", err);
        res.status(500).json({ error: "Failed to fetch merchants" });
    }
});

// GET /api/admin/activity - Global activity log (Last 50 entries)
router.get("/activity", async (req, res) => {
    try {
        const logs = await ActivityLog.find()
            .sort({ createdAt: -1 })
            .limit(50)
            .lean();
        res.json(logs);
    } catch (err) {
        console.error("Admin: Error fetching activity", err);
        res.status(500).json({ error: "Failed to fetch activity logs" });
    }
});

// POST /api/admin/login - Simple admin login
router.post("/login", async (req, res) => {
    const { username, password } = req.body;
    // Hardcoded for simplicity as requested by user
    if (username === "admin" && password === "admin123") {
        res.json({ success: true, token: "admin-secret-token" });
    } else {
        res.status(401).json({ success: false, error: "Invalid credentials" });
    }
});

// POST /api/admin/merchants/plan - Manually adjust a merchant's plan
router.post("/merchants/plan", async (req, res) => {
    try {
        const { shopDomain, plan, trialLimit } = req.body;

        if (!shopDomain) return res.status(400).json({ error: "shopDomain is required" });

        const updateData = {};
        if (plan) updateData.plan = plan;
        if (trialLimit !== undefined) updateData.trialLimit = trialLimit;

        const merchant = await Merchant.findOneAndUpdate(
            { shopDomain },
            updateData,
            { new: true }
        );

        if (!merchant) return res.status(404).json({ error: "Merchant not found" });

        res.json({ success: true, merchant });
    } catch (err) {
        console.error("Admin: Error updating merchant plan", err);
        res.status(500).json({ error: "Failed to update merchant plan" });
    }
});

// POST /api/admin/merchants/block - Toggle block status
router.post("/merchants/block", async (req, res) => {
    try {
        const { shopDomain, isActive } = req.body;
        const merchant = await Merchant.findOneAndUpdate(
            { shopDomain },
            { isActive },
            { new: true }
        );
        res.json({ success: true, isActive: merchant.isActive });
    } catch (err) {
        res.status(500).json({ error: "Failed to block" });
    }
});

// POST /api/admin/merchants/extend-trial - Add messages to trial
router.post("/merchants/extend-trial", async (req, res) => {
    try {
        const { shopDomain, extraMessages } = req.body;
        const merchant = await Merchant.findOne({ shopDomain });
        if (!merchant) return res.status(404).json({ error: "Not found" });

        merchant.trialLimit = (merchant.trialLimit || 10) + parseInt(extraMessages);
        await merchant.save();

        res.json({ success: true, newLimit: merchant.trialLimit });
    } catch (err) {
        res.status(500).json({ error: "Failed to extend trial" });
    }
});

// GET /api/admin/stats - Get subscription analytics
router.get("/stats", async (req, res) => {
    try {
        const merchants = await Merchant.find({ billingStatus: 'active' }).lean();
        const plans = await Plan.find().lean();

        const planMap = plans.reduce((acc, p) => {
            acc[p.id] = p.price;
            return acc;
        }, {});

        let totalEarnings = 0;
        const planCounts = {};

        merchants.forEach(m => {
            const price = planMap[m.plan] || 0;
            totalEarnings += price;
            planCounts[m.plan] = (planCounts[m.plan] || 0) + 1;
        });

        res.json({
            totalSubscribers: merchants.length,
            totalMonthlyEarnings: totalEarnings,
            planBreakdown: planCounts
        });
    } catch (err) {
        console.error("Admin: Error fetching stats", err);
        res.status(500).json({ error: "Failed to fetch stats" });
    }
});

// POST /api/admin/merchants/cancel-subscription - Force cancel subscription
router.post("/merchants/cancel-subscription", async (req, res) => {
    try {
        const { shopDomain } = req.body;
        if (!shopDomain) return res.status(400).json({ error: "shopDomain is required" });

        const merchant = await Merchant.findOneAndUpdate(
            { shopDomain },
            { billingStatus: 'inactive', plan: 'none' },
            { new: true }
        );

        if (!merchant) return res.status(404).json({ error: "Merchant not found" });

        res.json({ success: true, merchant });
    } catch (err) {
        console.error("Admin: Error canceling subscription", err);
        res.status(500).json({ error: "Failed to cancel subscription" });
    }
});

export default router;
