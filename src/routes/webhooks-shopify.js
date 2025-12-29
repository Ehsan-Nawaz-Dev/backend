import { Router } from "express";
import { ActivityLog } from "../models/ActivityLog.js";

const router = Router();

// NOTE: In production you must verify Shopify webhook signatures.

const logEvent = async (type, req) => {
  try {
    await ActivityLog.create({
      merchant: null, // to be linked via shopDomain -> Merchant lookup
      type,
      orderId: req.body?.id?.toString?.() || req.body?.order_id?.toString?.(),
      customerName: req.body?.customer?.first_name,
      message: `Shopify webhook: ${type}`,
      rawPayload: req.body,
    });
  } catch (err) {
    console.error("Error logging activity", err);
  }
};

router.post("/orders/create", async (req, res) => {
  await logEvent("pending", req);
  res.status(200).send("ok");
});

router.post("/checkouts/abandoned", async (req, res) => {
  await logEvent("pending", req);
  res.status(200).send("ok");
});

router.post("/fulfillments/update", async (req, res) => {
  await logEvent("confirmed", req);
  res.status(200).send("ok");
});

router.post("/orders/cancelled", async (req, res) => {
  await logEvent("cancelled", req);
  res.status(200).send("ok");
});

export default router;
