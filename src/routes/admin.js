import { Router } from "express";
import { Merchant } from "../models/Merchant.js";
import { ActivityLog } from "../models/ActivityLog.js";
import { WhatsAppSession } from "../models/WhatsAppSession.js";

const router = Router();

// GET /api/admin/merchants - List all merchants with connection status
router.get("/merchants", async (req, res) => {
    try {
        const merchants = await Merchant.find().sort({ createdAt: -1 }).lean();
        const sessions = await WhatsAppSession.find().lean();

        // Map sessions to merchants
        const enrichedMerchants = merchants.map(merchant => {
            const session = sessions.find(s => s.shopDomain === merchant.shopDomain);
            return {
                ...merchant,
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

export default router;
