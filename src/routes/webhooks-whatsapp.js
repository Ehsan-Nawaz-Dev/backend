import { Router } from "express";
import { ActivityLog } from "../models/ActivityLog.js";

const router = Router();

// This endpoint will receive incoming WhatsApp messages (from Twilio or WhatsApp Cloud API)
router.post("/", async (req, res) => {
  try {
    const payload = req.body;

    await ActivityLog.create({
      merchant: null, // map from phone number / integration config later
      type: "pending",
      orderId: undefined,
      customerName: payload?.from || payload?.contactName,
      message: payload?.body || "Incoming WhatsApp message",
      rawPayload: payload,
    });

    // TODO: parse message (e.g. CONFIRM/CANCEL) and update Shopify via Admin API

    res.status(200).json({ received: true });
  } catch (err) {
    console.error("Error handling WhatsApp webhook", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
