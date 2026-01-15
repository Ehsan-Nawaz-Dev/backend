import { Router } from 'express';
import axios from 'axios';
import { Merchant } from '../models/Merchant.js';
import { plans } from '../config/plans.js';

const router = Router();
const SHOPIFY_APP_URL = (process.env.SHOPIFY_APP_URL || "http://localhost:5000").replace(/\/$/, "");

// Create Charge
router.post('/create', async (req, res) => {
    const { shop } = req.query;
    const { plan } = req.body;
    console.log(`[Billing] Creating charge for shop: ${shop}, plan: ${plan}`);

    if (!plans[plan]) return res.status(400).json({ message: 'Invalid plan selected' });

    try {
        const merchant = await Merchant.findOne({ shopDomain: shop });

        // 2. Error if Merchant not found
        if (!merchant) {
            console.error(`[Billing] Merchant ${shop} not found in database`);
            return res.status(404).json({ message: 'Merchant not found. Please reinstall the app.' });
        }
        // 3. Error if Access Token is missing
        if (!merchant.shopifyAccessToken) {
            console.error(`[Billing] Access token missing for ${shop}`);
            return res.status(403).json({ message: 'Shopify token missing. Please reinstall the app.' });
        }

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
            console.error(`[Billing] Diagnostics verification FAILED for ${shop}:`, diagErr.response?.data || diagErr.message);
        }

        // 4. Create Charge
        const chargeData = {
            recurring_application_charge: {
                name: `${plans[plan].name} Plan`,
                price: plans[plan].price, // Reverting to Number
                return_url: `${SHOPIFY_APP_URL}/api/billing/confirm?shop=${shop}&plan=${plan}`,
                test: true
            }
        };

        const apiVersion = "2025-01"; // Updated to modern stable version
        const chargeUrl = `https://${shop}/admin/api/${apiVersion}/recurring_application_charges.json`;

        console.log(`[Billing] URL: ${chargeUrl}`);
        console.log(`[Billing] Request Payload:`, JSON.stringify(chargeData));
        console.log(`[Billing] Sending request to Shopify...`);

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
        console.error('Status:', error.response?.status);

        // Handle HTML responses (Shopify sometimes returns HTML on 403)
        let responseData = error.response?.data;
        if (typeof responseData === 'string' && responseData.includes('<!DOCTYPE html>')) {
            console.error('Data: [HTML Response Detected]');
            // Extract title or body text if possible for quick debugging
            const match = responseData.match(/<title>(.*?)<\/title>/);
            if (match) console.error('HTML Title:', match[1]);
        } else {
            console.error('Data:', JSON.stringify(responseData || 'NO_BODY'));
        }

        console.error('Headers:', JSON.stringify(error.response?.headers || 'NO_HEADERS'));
        console.error('Message:', error.message);

        const shopifyError = (typeof responseData === 'object' && responseData?.errors) || error.message;
        res.status(500).json({
            message: 'Failed to create charge',
            detail: shopifyError
        });
    }
});

// Confirm Charge (Return URL)
router.get('/confirm', async (req, res) => {
    const { shop, charge_id, plan } = req.query;

    try {
        const merchant = await Merchant.findOne({ shopDomain: shop });
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

        // Redirect to frontend dashboard (Adjust the path as needed for your UI)
        const frontendUrl = process.env.FRONTEND_APP_URL || "http://localhost:5173/dashboard";
        res.redirect(`${frontendUrl}?shop=${shop}&billing=success`);
    } catch (error) {
        console.error('Activation Error:', error.response?.data || error.message);
        res.status(500).send('Billing activation failed');
    }
});

router.get('/status', async (req, res) => {
    const { shop } = req.query;
    try {
        const merchant = await Merchant.findOne({ shopDomain: shop });

        // If no merchant yet, return none
        if (!merchant) return res.json({ plan: 'none', status: 'none' });
        // Return current plan and active status
        res.json({
            plan: merchant.plan || 'free',
            status: merchant.billingStatus || 'none'
        });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch status' });
    }
});

export default router;
