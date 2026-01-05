import { Router } from "express";
import { ActivityLog } from "../models/ActivityLog.js";
import { automationService } from "../services/automationService.js";
import { Merchant } from "../models/Merchant.js";

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
  const shopDomain = req.headers["x-shop-domain"];
  await logEvent("pending", req);
  if (shopDomain) await automationService.trackSent(shopDomain, "order_confirmation");
  res.status(200).send("ok");
});

router.post("/checkouts/abandoned", async (req, res) => {
  const shopDomain = req.headers["x-shop-domain"];
  await logEvent("pending", req);
  if (shopDomain) await automationService.trackSent(shopDomain, "abandoned_cart");
  res.status(200).send("ok");
});

router.post("/fulfillments/update", async (req, res) => {
  const shopDomain = req.headers["x-shop-domain"];
  await logEvent("confirmed", req);
  if (shopDomain) await automationService.trackSent(shopDomain, "fulfillment_update");
  res.status(200).send("ok");
});

router.post("/orders/cancelled", async (req, res) => {
  await logEvent("cancelled", req);
  res.status(200).send("ok");
});

// For recovery tracking (e.g. when an order is paid after being abandoned)
router.post("/orders/paid", async (req, res) => {
  const shopDomain = req.headers["x-shop-domain"];
  const revenue = parseFloat(req.body?.total_price || 0);
  if (shopDomain) await automationService.trackRecovered(shopDomain, revenue);
  res.status(200).send("ok");
});

export default router;
