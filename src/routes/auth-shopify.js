import { Router } from "express";
import axios from "axios";
import crypto from "crypto";
import dotenv from "dotenv";
import { Merchant } from "../models/Merchant.js";
import { Template } from "../models/Template.js";
import { AutomationSetting } from "../models/AutomationSetting.js";

dotenv.config();

const router = Router();

const SHOPIFY_API_KEY = process.env.SHOPIFY_API_KEY;
const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET;
const SHOPIFY_SCOPES = "read_orders,write_orders,read_billing,write_billing";
console.log(`[OAuth] Active Scopes: ${SHOPIFY_SCOPES}`);
const SHOPIFY_APP_URL = (process.env.SHOPIFY_APP_URL || "http://localhost:5000").replace(/\/$/, "");
const FRONTEND_APP_URL = process.env.FRONTEND_APP_URL || "http://localhost:5173/dashboard";

// Step 1: Redirect merchant to Shopify OAuth
// GET /api/auth/shopify?shop={shop}.myshopify.com
router.get("/", (req, res) => {
  const { shop } = req.query;

  if (!shop) {
    return res.status(400).send("Missing shop parameter");
  }

  if (!SHOPIFY_API_KEY || !SHOPIFY_API_SECRET) {
    return res.status(500).send("Shopify API credentials are not configured on the server");
  }

  const redirectUri = `${SHOPIFY_APP_URL}/api/auth/shopify/callback`;
  // Add grant_options[]=per-user to force re-prompt when scopes change
  const installUrl = `https://${shop}/admin/oauth/authorize?client_id=${SHOPIFY_API_KEY}&scope=${SHOPIFY_SCOPES}&redirect_uri=${encodeURIComponent(redirectUri)}&grant_options[]=per-user`;

  console.log(`[OAuth] Redirecting ${shop} to Shopify authorization...`);
  res.redirect(installUrl);
});

// Step 2: Handle OAuth callback - FULLY AUTOMATIC SETUP
// GET /api/auth/shopify/callback?shop=...&code=...&hmac=...
router.get("/callback", async (req, res) => {
  const { shop, code, hmac } = req.query;

  if (!shop || !code) {
    return res.status(400).send("Missing required parameters");
  }

  // Verify HMAC (if provided) for security
  if (hmac && SHOPIFY_API_SECRET) {
    const queryParams = { ...req.query };
    delete queryParams.hmac;
    delete queryParams.signature; // Also remove signature if present

    const message = Object.keys(queryParams)
      .sort()
      .map(key => `${key}=${queryParams[key]}`)
      .join("&");

    const generatedHmac = crypto
      .createHmac("sha256", SHOPIFY_API_SECRET)
      .update(message)
      .digest("hex");

    if (generatedHmac !== hmac) {
      console.error("[OAuth] HMAC validation failed");
      return res.status(401).send("HMAC validation failed");
    }
    console.log("[OAuth] HMAC validated successfully");
  }

  try {
    // Exchange code for access token
    const tokenResponse = await axios.post(`https://${shop}/admin/oauth/access_token`, {
      client_id: SHOPIFY_API_KEY,
      client_secret: SHOPIFY_API_SECRET,
      code
    });

    const accessToken = tokenResponse.data.access_token;
    console.log(`[OAuth] Got access token for ${shop}`);

    // ===== AUTOMATIC SETUP STARTS HERE =====

    // 1. Fetch Shop Details
    let shopData = null;
    try {
      const shopResponse = await axios.get(`https://${shop}/admin/api/2024-01/shop.json`, {
        headers: { "X-Shopify-Access-Token": accessToken }
      });
      shopData = shopResponse.data.shop;
      console.log(`[OAuth] Fetched shop details: ${shopData.name}`);
    } catch (shopError) {
      console.warn("[OAuth] Could not fetch shop details:", shopError.message);
    }

    // 2. Create or Update Merchant Record
    const merchantData = {
      shopDomain: shop,
      shopifyAccessToken: accessToken,
      storeName: shopData?.name || shop,
      email: shopData?.email || null,
      phone: shopData?.phone || null,
      currency: shopData?.currency || "USD",
      timezone: shopData?.iana_timezone || null,
      country: shopData?.country_name || null,
      // Default settings (merchant can customize later)
      pendingConfirmTag: "Pending Confirmation",
      orderConfirmTag: "Confirmed",
      orderCancelTag: "Cancelled",
      orderConfirmReply: "Thank you! Your order has been confirmed. ✅",
      orderCancelReply: "Your order has been cancelled. ❌",
      isActive: true,
      installedAt: new Date()
    };

    const existingMerchant = await Merchant.findOne({ shopDomain: shop });
    let merchant;
    let isNewMerchant = !existingMerchant;

    if (existingMerchant) {
      // Update existing - preserve custom settings, just update token and shop info
      existingMerchant.shopifyAccessToken = accessToken;
      existingMerchant.storeName = shopData?.name || existingMerchant.storeName;
      existingMerchant.email = shopData?.email || existingMerchant.email;
      existingMerchant.phone = shopData?.phone || existingMerchant.phone;
      existingMerchant.currency = shopData?.currency || existingMerchant.currency;
      existingMerchant.timezone = shopData?.iana_timezone || existingMerchant.timezone;
      existingMerchant.country = shopData?.country_name || existingMerchant.country;
      existingMerchant.isActive = true;
      await existingMerchant.save();
      merchant = existingMerchant;
      console.log(`[OAuth] Merchant RE-AUTHORIZED: ${shop}`);
    } else {
      merchant = await Merchant.create(merchantData);
      console.log(`[OAuth] NEW Merchant created: ${shop}`);
    }

    // 3. Register Webhooks Automatically
    const webhooksToRegister = [
      { topic: "orders/create", address: `${SHOPIFY_APP_URL}/api/webhooks/shopify` },
      { topic: "orders/cancelled", address: `${SHOPIFY_APP_URL}/api/webhooks/shopify` },
      { topic: "orders/updated", address: `${SHOPIFY_APP_URL}/api/webhooks/shopify` },
      { topic: "checkouts/create", address: `${SHOPIFY_APP_URL}/api/webhooks/shopify` },
      { topic: "fulfillments/create", address: `${SHOPIFY_APP_URL}/api/webhooks/shopify` },
      { topic: "fulfillments/update", address: `${SHOPIFY_APP_URL}/api/webhooks/shopify` },
      { topic: "app/uninstalled", address: `${SHOPIFY_APP_URL}/api/webhooks/shopify` }
    ];

    for (const webhook of webhooksToRegister) {
      try {
        await axios.post(
          `https://${shop}/admin/api/2024-01/webhooks.json`,
          { webhook: { ...webhook, format: "json" } },
          { headers: { "X-Shopify-Access-Token": accessToken } }
        );
        console.log(`[OAuth] Registered webhook: ${webhook.topic}`);
      } catch (webhookError) {
        // Webhook might already exist (422) or other error
        const errorMsg = webhookError.response?.data?.errors || webhookError.message;
        console.log(`[OAuth] Webhook ${webhook.topic}: ${JSON.stringify(errorMsg)}`);
      }
    }

    // 4. Seeding Default Data for a consistent merchant experience
    await seedMerchantData(merchant);

    console.log(`[OAuth] ✅ Automatic setup COMPLETE for ${shop}`);

    // Redirect to frontend dashboard (including host for App Bridge)
    const host = req.query.host;
    const redirectUrl = new URL(FRONTEND_APP_URL);
    redirectUrl.searchParams.append("shop", shop);
    if (host) redirectUrl.searchParams.append("host", host);
    redirectUrl.searchParams.append("installed", "true");

    res.redirect(redirectUrl.toString());

  } catch (error) {
    console.error("[OAuth] Error during setup:", error.response?.data || error.message);
    res.status(500).send("Installation failed. Please try again.");
  }
});

/**
 * Function to seed default templates and automation settings for a merchant.
 * Ensures data is available immediately after installation.
 */
async function seedMerchantData(merchant) {
  const shopDomain = merchant.shopDomain;

  // 1. Create Default Templates
  const defaultTemplates = [
    {
      merchant: merchant._id,
      name: "Order Confirmation",
      event: "orders/create",
      message: `Hi {{customer_name}}! 👋\n\nThank you for your order from {{store_name}}!\n\n📦 *Order:* {{order_number}}\n🛒 *Items:* {{items_list}}\n💰 *Total:* {{grand_total}}\n📍 *Address:* {{address}}, {{city}}\n\nPlease confirm if these details are correct.`,
      enabled: true,
      isPoll: true,
      pollOptions: ["✅ Yes, Confirm", "❌ No, Cancel"]
    },
    {
      merchant: merchant._id,
      name: "Order Cancelled",
      event: "orders/cancelled",
      message: `Hi {{customer_name}},\n\nYour order {{order_number}} has been cancelled.\n\nIf this was a mistake, please contact us.\n\nThank you for shopping with {{store_name}}!`,
      enabled: true,
      isPoll: false
    },
    {
      merchant: merchant._id,
      name: "Shipment Update",
      event: "fulfillments/update",
      message: `Hi {{customer_name}}! 🚚\n\nGreat news! Your order {{order_number}} has been shipped!\n\n📍 Track your package: {{tracking_link}}\n\nThank you for shopping with {{store_name}}!`,
      enabled: true,
      isPoll: false
    },
    {
      merchant: merchant._id,
      name: "Cart Recovery",
      event: "checkouts/create",
      message: `Hi {{customer_name}}, you left something in your cart! 🛒\n\nClick here to finish your purchase: {{cart_link}}\n\nThank you for visiting {{store_name}}!`,
      enabled: true,
      isPoll: false
    },
    {
      merchant: merchant._id,
      name: "Admin Order Alert",
      event: "admin-order-alert",
      message: `🔔 *New Order Alert!*\n\nOrder: {{order_number}}\nCustomer: {{customer_name}}\nTotal: {{grand_total}}\nItems: {{items_list}}\nAddress: {{address}}, {{city}}`,
      enabled: true,
      isPoll: false
    }
  ];

  for (const template of defaultTemplates) {
    await Template.updateOne(
      { merchant: merchant._id, event: template.event },
      { $setOnInsert: template },
      { upsert: true }
    );
  }

  // 2. Create Default Automation Settings
  const defaultAutomations = [
    { shopDomain: shopDomain, type: "order-confirmation", enabled: true },
    { shopDomain: shopDomain, type: "abandoned-cart", enabled: false },
    { shopDomain: shopDomain, type: "shipment-update", enabled: true }
  ];

  for (const automation of defaultAutomations) {
    await AutomationSetting.updateOne(
      { shopDomain: shopDomain, type: automation.type },
      { $setOnInsert: automation },
      { upsert: true }
    );
  }
}

// Handle app uninstall webhook
router.post("/uninstall", async (req, res) => {
  try {
    const shopDomain = req.get("x-shopify-shop-domain");
    if (shopDomain) {
      await Merchant.findOneAndUpdate(
        { shopDomain },
        { isActive: false, shopifyAccessToken: null }
      );
      console.log(`[OAuth] App uninstalled for ${shopDomain}`);
    }
    res.status(200).send("OK");
  } catch (error) {
    console.error("[OAuth] Uninstall error:", error);
    res.status(200).send("OK"); // Always return 200 for webhooks
  }
});

export default router;
