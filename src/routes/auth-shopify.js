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
const SHOPIFY_SCOPES = process.env.SHOPIFY_SCOPES || "read_checkouts,read_customers,read_fulfillments,read_orders,write_orders,read_billing,write_billing,write_script_tags,read_script_tags";
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

  // Determine if we should use /Api or /api based on the current request path
  const apiPrefix = req.originalUrl.includes("/Api") ? "/Api" : "/api";
  const redirectUri = `${SHOPIFY_APP_URL}${apiPrefix}/auth/shopify/callback`;
  // Request OFFLINE access token (permanent) by removing per-user grant options
  const installUrl = `https://${shop}/admin/oauth/authorize?client_id=${SHOPIFY_API_KEY}&scope=${SHOPIFY_SCOPES}&redirect_uri=${encodeURIComponent(redirectUri)}`;

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

  let accessToken;
  try {
    // Exchange code for access token
    const tokenResponse = await axios.post(`https://${shop}/admin/oauth/access_token`, {
      client_id: SHOPIFY_API_KEY,
      client_secret: SHOPIFY_API_SECRET,
      code
    });
    accessToken = tokenResponse.data.access_token;
    console.log(`[OAuth] Got access token for ${shop}`);
  } catch (tokenError) {
    // Handle "authorization code was not found or was already used"
    console.warn(`[OAuth] Failed to exchange token: ${tokenError.response?.data?.error_description || tokenError.message}`);

    // Check if we already have a valid merchant token from the FIRST request
    const existing = await Merchant.findOne({
      shopDomain: { $regex: new RegExp(`^${shop}$`, "i") }
    });

    if (existing && existing.shopifyAccessToken) {
      console.log(`[OAuth] RECOVERY: Merchant ${shop} already has a token. Treating simply as re-auth/duplicate request.`);
      accessToken = existing.shopifyAccessToken;
    } else {
      // Genuine error - no token exists
      console.error("[OAuth] FATAL: Code invalid and no existing token.");
      return res.status(500).send("Authentication failed. Please try installing again via the App Store.");
    }
  }

  // Proceed with setup (now using accessToken, whether new or recovered)

  // ===== AUTOMATIC SETUP STARTS HERE =====

  try {
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
      shopDomain: shop.toLowerCase(),
      shopifyAccessToken: accessToken,
      storeName: shopData?.name || shop,
      contactName: shopData?.shop_owner || null,
      email: shopData?.email || null,
      phone: shopData?.phone || null,
      currency: shopData?.currency || "USD",
      timezone: shopData?.iana_timezone || null,
      country: shopData?.country_name || null,
      pendingConfirmTag: "Pending Confirmation",
      orderConfirmTag: "Order Confirmed",
      orderCancelTag: "Order Cancel By customer",
      orderConfirmReply: "Thank you! Your order has been confirmed. ✅",
      orderCancelReply: "Your order has been cancelled. ❌",
      plan: "free",
      billingStatus: "active",
      isActive: true,
      installedAt: new Date()
    };

    const existingMerchant = await Merchant.findOne({
      shopDomain: { $regex: new RegExp(`^${shop}$`, "i") }
    });
    let merchant;
    let isNewMerchant = !existingMerchant;

    if (existingMerchant) {
      // Update existing - preserve custom settings, just update token and shop info
      console.log(`[OAuth] Updating existing merchant ${shop}. New Token Length: ${accessToken?.length}`);
      existingMerchant.shopifyAccessToken = accessToken;
      existingMerchant.storeName = shopData?.name || existingMerchant.storeName;
      existingMerchant.email = shopData?.email || existingMerchant.email;
      existingMerchant.phone = shopData?.phone || existingMerchant.phone;
      existingMerchant.currency = shopData?.currency || existingMerchant.currency;
      existingMerchant.timezone = shopData?.iana_timezone || existingMerchant.timezone;
      existingMerchant.country = shopData?.country_name || existingMerchant.country;
      existingMerchant.isActive = true;
      const saved = await existingMerchant.save();
      console.log(`[OAuth] Save result: ${!!saved}`);
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

    // Redirect to Shopify Admin Embedded App
    // We redirect to the /dashboard route within the embedded app context to avoid 404s at root
    const host = req.query.host;
    const shopName = shop.replace(".myshopify.com", "");
    const adminUrl = `https://admin.shopify.com/store/${shopName}/apps/${SHOPIFY_API_KEY}/dashboard?shop=${shop}&host=${host}&installed=true`;

    console.log(`[OAuth] Redirecting to: ${adminUrl}`);
    res.redirect(adminUrl);

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
    },
    {
      merchant: merchant._id,
      name: "Cancellation Verification",
      event: "orders/cancel_verify",
      message: `Are you sure you want to cancel your order? ❌\n\nThis will stop your order from being processed immediately.`,
      enabled: true,
      isPoll: true,
      pollOptions: ["🗑️ Yes, Cancel Order", "✅ No, Keep Order"]
    },
    {
      merchant: merchant._id,
      name: "Customer Feedback",
      event: "orders/feedback",
      message: `Hi {{customer_name}}! 👋\n\nHow was your experience with {{store_name}}?\n\nWe would love to get your feedback on your recent order {{order_number}}. Please rate us below:`,
      enabled: true,
      isPoll: true,
      pollOptions: ["⭐⭐⭐⭐⭐", "⭐⭐⭐⭐", "⭐⭐⭐", "⭐⭐", "⭐"]
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
