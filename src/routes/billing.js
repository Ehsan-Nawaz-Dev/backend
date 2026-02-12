import { Router } from 'express';
import axios from 'axios';
import { Merchant } from '../models/Merchant.js';
import { Plan } from '../models/Plan.js'; // Import Model

const router = Router();
const SHOPIFY_APP_URL = (process.env.SHOPIFY_APP_URL || "http://localhost:5000").replace(/\/$/, "");

// Create Charge
router.post('/create', async (req, res) => {
    const { shop } = req.query;
    const { plan: planId } = req.body; // planId e.g. 'starter'
    console.log(`[Billing] Creating charge for shop: ${shop}, plan: ${planId}`);

    // Fetch Plan from DB
    const planConfig = await Plan.findOne({ id: planId });
    if (!planConfig) return res.status(400).json({ message: 'Invalid plan selected' });

    try {
        const merchant = await Merchant.findOne({
            shopDomain: { $regex: new RegExp(`^${shop}$`, "i") }
        });

        if (!merchant) {
            console.error(`[Billing] Merchant ${shop} not found in database. Looking for shop: ${shop}`);
            // Let's also log a few merchants to see what's in there
            const someMerchants = await Merchant.find().limit(3);
            console.log(`[Billing] Sample merchants in DB:`, someMerchants.map(m => m.shopDomain));

            return res.status(404).json({ message: 'Merchant not found. Please logout and login again.' });
        }

        // --- SPECIAL HANDLING FOR FREE PLAN ---
        if (planConfig.price === 0) {
            console.log(`[Billing] Free plan selected. Skipping Shopify Charge.`);
            merchant.plan = planId;
            merchant.billingStatus = 'active';
            await merchant.save();

            // Redirect to billing success page
            const apiKey = process.env.SHOPIFY_API_KEY;
            const shopName = shop.replace(".myshopify.com", "");
            if (apiKey) {
                return res.json({ confirmationUrl: `https://admin.shopify.com/store/${shopName}/apps/${apiKey}/billing-success?shop=${shop}` });
            }
            const frontendUrl = process.env.FRONTEND_APP_URL || "https://whatomatic.vercel.app";
            return res.json({ confirmationUrl: `${frontendUrl}/billing-success?shop=${shop}` });
        }

        // 3. Error if Access Token is missing
        if (!merchant.shopifyAccessToken) {
            console.error(`[Billing] Access token missing for ${shop}`);
            return res.status(403).json({ message: 'Shopify token missing. Please reinstall the app.' });
        }

        // ... existing diagnostics and charge creation code ...
        // ... (Since I am editing a chunk, I need to include the rest of the file logic that follows or careful replacement)

        // Diagnostics: Verify token works and check scopes
        try {
            const scopeResponse = await axios.get(`https://${shop}/admin/oauth/access_scopes.json`, {
                headers: { 'X-Shopify-Access-Token': merchant.shopifyAccessToken }
            });
            const scopes = scopeResponse.data.access_scopes.map(s => s.handle);
            console.log(`[Billing] Diagnostics: Active Scopes for ${shop}:`, scopes.join(", "));

            if (scopes.includes('write_billing')) {
                console.log(`[Billing] SUCCESS: 'write_billing' scope is present for ${shop}`);
            } else {
                console.warn(`[Billing] CRITICAL: 'write_billing' scope is MISSING for ${shop}. 403 Forbidden is expected until merchant re-authorizes.`);
            }
        } catch (diagErr) {
            // Ignore diagnostics error
        }

        // 4. Create Charge
        const chargeData = {
            recurring_application_charge: {
                name: `${planConfig.name} Plan`,
                price: planConfig.price,
                return_url: `${SHOPIFY_APP_URL}/api/billing/confirm?shop=${shop}&plan=${planId}`,
                test: true
            }
        };

        const apiVersion = "2025-01";
        const chargeUrl = `https://${shop}/admin/api/${apiVersion}/recurring_application_charges.json`;

        const response = await axios.post(
            chargeUrl,
            chargeData,
            {
                headers: {
                    'X-Shopify-Access-Token': merchant.shopifyAccessToken,
                    'Content-Type': 'application/json'
                }
            }
        );
        res.json({ confirmationUrl: response.data.recurring_application_charge.confirmation_url });
    } catch (error) {
        console.error('--- BILLING ERROR DETAIL ---');
        console.error(error.message);
        res.status(500).json({
            message: 'Failed to create charge',
            detail: error.response?.data || error.message
        });
    }
});

// Confirm Charge (Return URL)
router.get('/confirm', async (req, res) => {
    const { shop, charge_id, plan } = req.query;

    try {
        const merchant = await Merchant.findOne({
            shopDomain: { $regex: new RegExp(`^${shop}$`, "i") }
        });
        if (!merchant || !merchant.shopifyAccessToken) {
            return res.status(404).send('Merchant or access token not found');
        }

        // Activate the charge
        const apiVersion = "2025-01";
        await axios.post(
            `https://${shop}/admin/api/${apiVersion}/recurring_application_charges/${charge_id}/activate.json`,
            {},
            { headers: { 'X-Shopify-Access-Token': merchant.shopifyAccessToken } }
        );

        // Update DB
        merchant.plan = plan;
        merchant.billingStatus = 'active';
        await merchant.save();

        // Redirect to billing success page
        const apiKey = process.env.SHOPIFY_API_KEY;
        const shopName = shop.replace(".myshopify.com", "");
        if (apiKey) {
            res.redirect(`https://admin.shopify.com/store/${shopName}/apps/${apiKey}/billing-success?shop=${shop}`);
        } else {
            const frontendUrl = process.env.FRONTEND_APP_URL || "https://whatomatic.vercel.app";
            res.redirect(`${frontendUrl}/billing-success?shop=${shop}`);
        }
    } catch (error) {
        console.error('Activation Error:', error.response?.data || error.message);
        res.status(500).send('Billing activation failed');
    }
});

router.get('/status', async (req, res) => {
    const { shop } = req.query;
    try {
        const merchant = await Merchant.findOne({
            shopDomain: { $regex: new RegExp(`^${shop}$`, "i") }
        });

        // If no merchant yet, return none
        if (!merchant) {
            console.log(`[Billing] Status requested for unknown shop: ${shop}`);
            return res.json({ plan: 'none', status: 'none', usage: 0, limit: 10 });
        }

        const planConfig = await Plan.findOne({ id: merchant.plan || 'free' });
        const limit = planConfig ? planConfig.messageLimit : (merchant.trialLimit || 10);

        // Return current plan, active status, usage and limit
        res.json({
            plan: merchant.plan || 'free',
            status: merchant.billingStatus || 'none',
            usage: merchant.usage || 0,
            limit: limit
        });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch status' });
    }
});

export default router;
