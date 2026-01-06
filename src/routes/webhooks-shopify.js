import { Router } from "express";
import { ActivityLog } from "../models/ActivityLog.js";
import { automationService } from "../services/automationService.js";
import { Merchant } from "../models/Merchant.js";
import { AutomationSetting } from "../models/AutomationSetting.js";
import { whatsappService } from "../services/whatsappService.js";
import { Template } from "../models/Template.js";
import crypto from "crypto";

const router = Router();

// NOTE: In production you must verify Shopify webhook signatures.

const logEvent = async (type, req) => {
  try {
    await ActivityLog.create({
      merchant: null, // to be linked via shopDomain -> Merchant lookup
      type,
      orderId: req.body?.id?.toString?.() || req.body?.order_id?.toString?.(),
      customerName: req.body?.customer?.first_name || req.body?.shipping_address?.first_name,
      message: `Shopify webhook: ${type}`,
      rawPayload: req.body,
    });
  } catch (err) {
    console.error("Error logging activity", err);
  }
};

// Middleware to verify Shopify Webhook HMAC
const verifyShopifyWebhook = (req, res, next) => {
  const hmac = req.headers["x-shopify-hmac-sha256"];
  const secret = process.env.SHOPIFY_API_SECRET;

  if (!secret) {
    console.warn("SHOPIFY_API_SECRET not set, skipping HMAC validation for development");
    return next();
  }

  if (!hmac) return res.status(401).send("No HMAC header");

  const body = JSON.stringify(req.body);
  const hash = crypto
    .createHmac("sha256", secret)
    .update(body, "utf8")
    .digest("base64");

  if (hash === hmac) {
    next();
  } else {
    res.status(401).send("HMAC validation failed");
  }
};

router.post("/orders/create", verifyShopifyWebhook, async (req, res) => {
  const shopDomain = req.headers["x-shop-domain"] || req.query.shop;
  await logEvent("pending", req);

  if (!shopDomain) {
    console.warn("Webhook received without shop domain");
    return res.status(200).send("ok");
  }

  const merchant = await Merchant.findOne({ shopDomain });
  if (!merchant) {
    console.warn(`No merchant found for shop: ${shopDomain}`);
    return res.status(200).send("ok");
  }

  const orderNumber = req.body?.name || req.body?.order_number || `#${req.body?.id}`;
  const customerName = req.body?.customer?.first_name || req.body?.shipping_address?.first_name || "Customer";

  // Trigger 1: Admin Alert
  const adminSetting = await AutomationSetting.findOne({ shopDomain, type: "admin-order-alert" });
  if (adminSetting?.enabled && merchant.adminPhoneNumber) {
    const adminTemplate = await Template.findOne({ merchant: merchant._id, event: "admin-order-alert" });
    let adminMsg = adminTemplate?.message || `New Order Alert: Order {{order_number}} received from {{customer_name}}`;
    adminMsg = adminMsg.replace(/{{customer_name}}/g, customerName).replace(/{{order_number}}/g, orderNumber);

    await whatsappService.sendMessage(shopDomain, merchant.adminPhoneNumber, adminMsg);
    await automationService.trackSent(shopDomain, "admin-order-alert");
  }

  // Trigger 2: Customer Confirmation
  const customerSetting = await AutomationSetting.findOne({ shopDomain, type: "order-confirmation" });
  if (customerSetting?.enabled) {
    const customerPhone = req.body?.customer?.phone || req.body?.shipping_address?.phone || req.body?.billing_address?.phone;
    if (customerPhone) {
      const customerTemplate = await Template.findOne({ merchant: merchant._id, event: "orders/create" });
      let customerMsg = customerTemplate?.message || `Hi {{customer_name}}, your order {{order_number}} has been received! We'll notify you when it ships.`;
      customerMsg = customerMsg.replace(/{{customer_name}}/g, customerName).replace(/{{order_number}}/g, orderNumber);

      const result = await whatsappService.sendMessage(shopDomain, customerPhone, customerMsg);
      if (result.success) {
        await automationService.trackSent(shopDomain, "order-confirmation");
      }
    }
  }

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
