import { Router } from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";
import { Merchant } from "../models/Merchant.js";

// Make sure env vars are loaded even if this module is imported before server.js runs dotenv.config()
dotenv.config();

const router = Router();

const SHOPIFY_API_KEY = process.env.SHOPIFY_API_KEY;
const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET;
const SHOPIFY_SCOPES = process.env.SHOPIFY_SCOPES || "read_orders";
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
    const { shop, code } = req.query;
    if (!shop || !code || typeof shop !== "string" || typeof code !== "string") {
      return res.status(400).send("Missing shop or code parameter");
    }

    if (!SHOPIFY_API_KEY || !SHOPIFY_API_SECRET) {
      return res.status(500).send("Shopify API credentials are not configured on the server");
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

    // Store or update merchant record with access token and default tags
    const merchant = await Merchant.findOneAndUpdate(
      { shopDomain: shop },
      {
        $set: {
          shopDomain: shop,
          shopifyAccessToken: accessToken,
        },
        $setOnInsert: {
          // Only set these defaults for NEW merchants
          pendingConfirmTag: "Pending Confirmation",
          orderConfirmTag: "Confirmed",
          orderCancelTag: "Cancelled"
        }
      },
      { new: true, upsert: true },
    );

    console.log(`Shopify merchant authorized: ${merchant.shopDomain} (Token Length: ${accessToken.length})`);

    // Redirect merchant to frontend dashboard (with shop param for auto-login)
    const redirectUrl = `${FRONTEND_APP_URL}?shop=${encodeURIComponent(shop)}`;
    return res.redirect(redirectUrl);
  } catch (err) {
    console.error("Error handling Shopify OAuth callback", err);
    res.status(500).send("Internal server error");
  }
});

export default router;
