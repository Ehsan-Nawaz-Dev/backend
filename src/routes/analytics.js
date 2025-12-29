import { Router } from "express";
import { ActivityLog } from "../models/ActivityLog.js";

const router = Router();

// Basic analytics summary derived from ActivityLog
// NOTE: For now this is global (no shop filter) and time range is last 30 days.
router.get("/", async (req, res) => {
  try {
    const since = new Date();
    since.setDate(since.getDate() - 30);

    const logs = await ActivityLog.find({ createdAt: { $gte: since } }).lean();

    const totalMessages = logs.length;
    const confirmed = logs.filter((l) => l.type === "confirmed").length;
    const recovered = logs.filter((l) => l.type === "recovered").length;
    const cancelled = logs.filter((l) => l.type === "cancelled").length;

    const abandonedCheckouts = recovered + cancelled; // rough proxy
    const delivered = totalMessages; // until we track delivery explicitly
    const replies = confirmed + recovered; // any positive engagement

    const responseRate = delivered > 0 ? Math.round((replies / delivered) * 100) : 0;
    const recoveryRate = abandonedCheckouts > 0 ? Math.round((recovered / abandonedCheckouts) * 100) : 0;

    res.json({
      messagesSent: totalMessages,
      recoveredCarts: recovered,
      confirmedOrders: confirmed,
      responseRate,
      abandonedCheckouts,
      delivered,
      replies,
      recoveryRate,
      cancelled,
      periodDays: 30,
    });
  } catch (err) {
    console.error("Error building analytics summary", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
