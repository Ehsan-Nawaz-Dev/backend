import { Router } from "express";
import fetch from "node-fetch";
import crypto from "crypto";
import dotenv from "dotenv";
import { Merchant } from "../models/Merchant.js";
import { Template } from "../models/Template.js";
import { AutomationSetting } from "../models/AutomationSetting.js";
import { shopifyService } from "../services/shopifyService.js";

// Make sure env vars are loaded even if this module is imported before server.js runs dotenv.config()
dotenv.config();

const router = Router();

const SHOPIFY_API_KEY = process.env.SHOPIFY_API_KEY;
const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET;
const SHOPIFY_SCOPES = process.env.SHOPIFY_SCOPES || "read_orders,write_orders";
const SHOPIFY_APP_URL = (process.env.SHOPIFY_APP_URL || "http://localhost:5000").replace(/\/$/, "");
const FRONTEND_APP_URL = process.env.FRONTEND_APP_URL || "http://localhost:5173/dashboard";

// Start OAuth install / auth flow
// GET /api/auth/shopify?shop={shop}.myshopify.com
router.get("/", async (req, res) => {
  try {
    const shop = req.query.shop;
    if (!shop || typeof shop !== "string") {
      return res.status(400).send("Missing shop parameter");
    }

    if (!SHOPIFY_API_KEY || !SHOPIFY_API_SECRET) {
      return res.status(500).send("Shopify API credentials are not configured on the server");
    }

    const redirectUri = `${SHOPIFY_APP_URL}/api/auth/shopify/callback`;
    const scopes = SHOPIFY_SCOPES;

    const installUrl = `https://${shop}/admin/oauth/authorize?client_id=${encodeURIComponent(
      SHOPIFY_API_KEY,
    )}&scope=${encodeURIComponent(scopes)}&redirect_uri=${encodeURIComponent(redirectUri)}`;

    return res.redirect(installUrl);
  } catch (err) {
    console.error("Error starting Shopify OAuth", err);
    res.status(500).send("Internal server error");
  }
});

// OAuth callback to exchange code for access token
// GET /api/auth/shopify/callback?shop=...&code=...
router.get("/callback", async (req, res) => {
  try {
    const { shop, code, hmac } = req.query;
    if (!shop || !code || typeof shop !== "string" || typeof code !== "string") {
      return res.status(400).send("Missing shop or code parameter");
    }

    if (!SHOPIFY_API_KEY || !SHOPIFY_API_SECRET) {
      return res.status(500).send("Shopify API credentials are not configured on the server");
    }

    // HMAC Validation (security check)
    if (hmac) {
      const queryParams = { ...req.query };
      delete queryParams.hmac;
      const message = Object.keys(queryParams).sort().map(key => `${key}=${queryParams[key]}`).join('&');
      const generatedHmac = crypto.createHmac('sha256', SHOPIFY_API_SECRET).update(message).digest('hex');
      if (generatedHmac !== hmac) {
        console.error('[OAuth] HMAC validation failed');
        return res.status(401).send('HMAC validation failed');
      }
    }

    const tokenUrl = `https://${shop}/admin/oauth/access_token`;

    const tokenRes = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: SHOPIFY_API_KEY,
        client_secret: SHOPIFY_API_SECRET,
        code,
      }),
    });

    if (!tokenRes.ok) {
      const text = await tokenRes.text();
      console.error("Failed to exchange Shopify OAuth code", tokenRes.status, text);
      return res.status(500).send("Failed to complete Shopify OAuth");
    }

    const tokenJson = await tokenRes.json();
    const accessToken = tokenJson.access_token;

    if (!accessToken) {
      console.error("No access_token in Shopify OAuth response", tokenJson);
      return res.status(500).send("Invalid Shopify OAuth response");
    }

    console.log(`[OAuth] Starting auto-setup for ${shop}...`);

    // ========== 1. SAVE/UPDATE MERCHANT ==========
    let merchant = await Merchant.findOne({ shopDomain: shop });
    let isNewMerchant = !merchant;

    if (merchant) {
      // EXISTING merchant - update the token
      merchant.shopifyAccessToken = accessToken;
      if (!merchant.pendingConfirmTag) merchant.pendingConfirmTag = "Pending Confirmation";
      if (!merchant.orderConfirmTag) merchant.orderConfirmTag = "Confirmed";
      if (!merchant.orderCancelTag) merchant.orderCancelTag = "Cancelled";
      await merchant.save();
      console.log(`[OAuth] Merchant RE-AUTHORIZED: ${merchant.shopDomain}`);
    } else {
      // NEW merchant - create with all defaults
      merchant = await Merchant.create({
        shopDomain: shop,
        shopifyAccessToken: accessToken,
        pendingConfirmTag: "Pending Confirmation",
        orderConfirmTag: "Confirmed",
        orderCancelTag: "Cancelled",
        whatsappProvider: "device"
      });
      console.log(`[OAuth] NEW Merchant created: ${merchant.shopDomain}`);
    }

    // ========== 2. AUTO-REGISTER WEBHOOKS ==========
    const setupResult = await shopifyService.autoSetupMerchant(shop, accessToken, SHOPIFY_APP_URL);

    // Update merchant with store info
    if (setupResult.shopInfo) {
      merchant.storeName = setupResult.shopInfo.name;
      merchant.email = setupResult.shopInfo.email;
      merchant.phone = setupResult.shopInfo.phone;
      merchant.currency = setupResult.shopInfo.currency;
      merchant.timezone = setupResult.shopInfo.iana_timezone;
      merchant.country = setupResult.shopInfo.country_name;
      merchant.installedAt = merchant.installedAt || new Date();
      merchant.isActive = true;
      await merchant.save();
      console.log(`[OAuth] Store info saved: ${setupResult.shopInfo.name}`);
    }

    // ========== 3. CREATE DEFAULT TEMPLATES (if new merchant) ==========
    if (isNewMerchant) {
      const defaultTemplates = [
        {
          merchant: merchant._id,
          name: "Order Confirmation",
          event: "orders/create",
          message: `Hi {{customer_name}}! 👋

Thank you for your order from {{store_name}}!

📦 *Order:* {{order_number}}
🛒 *Items:* {{items_list}}
💰 *Total:* {{grand_total}}
📍 *Address:* {{address}}, {{city}}

Please confirm if these details are correct.`,
          enabled: true,
          isPoll: true,
          pollOptions: ["✅ Yes, Confirm", "❌ No, Cancel"]
        },
        {
          merchant: merchant._id,
          name: "Order Cancelled",
          event: "orders/cancelled",
          message: `Hi {{customer_name}},

Your order {{order_number}} has been cancelled as requested.

If this was a mistake, please contact us to place a new order.

Thank you for shopping with {{store_name}}!`,
          enabled: true,
          isPoll: false
        },
        {
          merchant: merchant._id,
          name: "Shipment Update",
          event: "fulfillments/update",
          message: `Hi {{customer_name}}! 🚚

Great news! Your order {{order_number}} has been shipped!

📍 Track your package: {{tracking_link}}

Thank you for shopping with {{store_name}}!`,
          enabled: true,
          isPoll: false
        },
        {
          merchant: merchant._id,
          name: "Admin Order Alert",
          event: "admin-order-alert",
          message: `🔔 *New Order Alert!*

Order: {{order_number}}
Customer: {{customer_name}}
Total: {{grand_total}}
Items: {{items_list}}
Address: {{address}}, {{city}}`,
          enabled: true,
          isPoll: false
        }
      ];

      for (const template of defaultTemplates) {
        await Template.findOneAndUpdate(
          { merchant: merchant._id, event: template.event },
          template,
          { upsert: true, new: true }
        );
      }
      console.log(`[OAuth] Default templates created for ${shop}`);
    }

    // ========== 4. CREATE DEFAULT AUTOMATION SETTINGS ==========
    const defaultAutomations = [
      { shopDomain: shop, type: "order-confirmation", enabled: true },
      { shopDomain: shop, type: "abandoned-cart", enabled: false },
      { shopDomain: shop, type: "shipment-update", enabled: true }
    ];

    for (const automation of defaultAutomations) {
      await AutomationSetting.findOneAndUpdate(
        { shopDomain: shop, type: automation.type },
        automation,
        { upsert: true }
      );
    }
    console.log(`[OAuth] Automation settings configured for ${shop}`);

    console.log(`[OAuth] ✅ Auto-setup COMPLETE for ${shop}`);

    // Redirect merchant to frontend dashboard (with shop param for auto-login)
    const redirectUrl = `${FRONTEND_APP_URL}?shop=${encodeURIComponent(shop)}&setup=complete`;
    return res.redirect(redirectUrl);
  } catch (err) {
    console.error("Error handling Shopify OAuth callback", err);
    res.status(500).send("Internal server error");
  }
});

export default router;
