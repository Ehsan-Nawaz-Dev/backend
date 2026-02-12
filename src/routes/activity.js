import { Router } from "express";
import { ActivityLog } from "../models/ActivityLog.js";
import { Merchant } from "../models/Merchant.js";

const router = Router();

// GET /activity — Returns recent activity logs filtered by shop
router.get("/", async (req, res) => {
  try {
    const { shop } = req.query;

    let filter = {};

    // If shop is provided, find the merchant and filter by their ID
    if (shop) {
      const merchant = await Merchant.findOne({
        shopDomain: { $regex: new RegExp(`^${shop}$`, "i") }
      });

      if (merchant) {
        filter.merchant = merchant._id;
      } else {
        // No merchant found for this shop — return empty
        return res.json([]);
      }
    }

    const logs = await ActivityLog.find(filter)
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();

    res.json(logs);
  } catch (err) {
    console.error("Error fetching activity logs", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
