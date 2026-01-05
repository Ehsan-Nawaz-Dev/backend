import { Router } from "express";
import { Campaign } from "../models/Campaign.js";
import { campaignService } from "../services/campaignService.js";

const router = Router();

const getShopDomain = (req) => req.query.shop || req.headers["x-shop-domain"];

// POST /api/campaigns/send
router.post("/send", async (req, res) => {
    try {
        const shopDomain = getShopDomain(req);
        const { contacts, message, type } = req.body;

        if (!shopDomain) return res.status(400).json({ error: "Missing shop parameter" });
        if (!contacts || !Array.isArray(contacts)) return res.status(400).json({ error: "Missing or invalid contacts" });
        if (!message) return res.status(400).json({ error: "Missing message" });

        const campaign = new Campaign({
            shopDomain,
            contacts,
            message,
            type: type || "text",
            totalCount: contacts.length,
            status: "pending"
        });

        await campaign.save();

        // Start sending in background
        campaignService.sendCampaign(campaign._id).catch(err => {
            console.error(`Campaign ${campaign._id} failed in background:`, err);
        });

        res.json({
            success: true,
            message: "Campaign initiated",
            campaignId: campaign._id
        });
    } catch (err) {
        console.error("Error initiating campaign", err);
        res.status(500).json({ error: "Internal server error" });
    }
});

// GET /api/campaigns/status/:id
router.get("/status/:id", async (req, res) => {
    try {
        const campaign = await Campaign.findById(req.params.id);
        if (!campaign) return res.status(404).json({ error: "Campaign not found" });

        res.json({
            id: campaign._id,
            status: campaign.status,
            sentCount: campaign.sentCount,
            totalCount: campaign.totalCount,
            createdAt: campaign.createdAt
        });
    } catch (err) {
        console.error("Error fetching campaign status", err);
        res.status(500).json({ error: "Internal server error" });
    }
});

export default router;
