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

    // Daily Aggregation for Bar Graph (Last 7 days)
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const dailyAggregation = await ActivityLog.aggregate([
      {
        $match: {
          createdAt: { $gte: sevenDaysAgo }
        }
      },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
          count: { $sum: 1 }
        }
      },
      { $sort: { "_id": 1 } }
    ]);

    // Format for frontend (fill in zeros if needed)
    const dailyStats = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().split('T')[0];
      const stat = dailyAggregation.find(a => a._id === dateStr);
      dailyStats.push({
        date: dateStr,
        count: stat ? stat.count : 0
      });
    }

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
      dailyStats
    });
  } catch (err) {
    console.error("Error building analytics summary", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
