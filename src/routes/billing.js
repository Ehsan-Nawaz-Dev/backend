import { Router } from 'express';
import axios from 'axios';
import { Merchant } from '../models/Merchant.js';
import { plans } from '../config/plans.js';

const router = Router();
const SHOPIFY_APP_URL = (process.env.SHOPIFY_APP_URL || "http://localhost:5000").replace(/\/$/, "");

// Create Charge
router.post('/create', async (req, res) => {
    const { shop } = req.query;
    const { plan } = req.body; // 'beginner', 'intermediate', or 'pro'

    if (!plans[plan]) {
        return res.status(400).json({ message: 'Invalid plan' });
    }

    try {
        const merchant = await Merchant.findOne({ shopDomain: shop });
        if (!merchant) {
            return res.status(404).json({ message: 'Merchant not found' });
        }

        // Create Application Charge via Shopify API
        const chargeData = {
            recurring_application_charge: {
                name: `${plans[plan].name} Plan`,
                price: plans[plan].price,
                return_url: `${SHOPIFY_APP_URL}/api/billing/confirm?shop=${shop}&plan=${plan}`,
                test: true // Set to false for production
            }
        };

        const response = await axios.post(
            `https://${shop}/admin/api/2024-01/recurring_application_charges.json`,
            chargeData,
            { headers: { 'X-Shopify-Access-Token': merchant.shopifyAccessToken } }
        );

        res.json({ confirmationUrl: response.data.recurring_application_charge.confirmation_url });
    } catch (error) {
        console.error('Billing Error:', error.response?.data || error.message);
        res.status(500).json({ message: 'Failed to create charge' });
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
        await axios.post(
            `https://${shop}/admin/api/2024-01/recurring_application_charges/${charge_id}/activate.json`,
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
        res.json({
            plan: merchant?.plan || 'free',
            status: merchant?.billingStatus || 'inactive'
        });
    } catch (error) {
        res.status(500).json({ message: "Error fetching status" });
    }
});

export default router;
