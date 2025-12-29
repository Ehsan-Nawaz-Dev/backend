import { Router } from "express";
import { ActivityLog } from "../models/ActivityLog.js";

const router = Router();

// For now, shop filtering is TODO; we just return recent activity logs.
router.get("/", async (req, res) => {
  try {
    const logs = await ActivityLog.find()
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
