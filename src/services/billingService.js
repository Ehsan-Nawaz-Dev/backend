import axios from 'axios';
import { Merchant } from '../models/Merchant.js';

const API_VERSION = "2025-01";

export async function checkAndChargeUsage(merchant) {
    if (!merchant.shopifyUsageLineItemId || !merchant.shopifyAccessToken) return;

    const currentUsage = merchant.usage || 0;
    const currentTotal = merchant.usageChargeTotal || 0;
    
    let targetCharge = 0;
    let targetPlan = merchant.plan || 'free';

    if (currentUsage > 2500) {
        targetCharge = 14.99;
        targetPlan = 'pro';
    } else if (currentUsage > 1250) {
        targetCharge = 9.99;
        targetPlan = 'growth';
    } else if (currentUsage > 50) {
        targetCharge = 4.99;
        targetPlan = 'starter';
    }

    const diff = targetCharge - currentTotal;
    
    // If there is an unpaid difference (e.g. they crossed a tier)
    if (diff > 0) {
        console.log(`[Billing] Usage threshold crossed for ${merchant.shopDomain}. Usage: ${currentUsage}. Creating charge for $${diff}.`);
        
        const graphqlQuery = {
            query: `
                mutation appUsageRecordCreate($description: String!, $price: MoneyInput!, $subscriptionLineItemId: ID!) {
                    appUsageRecordCreate(description: $description, price: $price, subscriptionLineItemId: $subscriptionLineItemId) {
                        appUsageRecord {
                            id
                        }
                        userErrors {
                            field
                            message
                        }
                    }
                }
            `,
            variables: {
                description: `Auto-upgrade to ${targetPlan} plan`,
                price: {
                    amount: Number(diff.toFixed(2)),
                    currencyCode: "USD"
                },
                subscriptionLineItemId: merchant.shopifyUsageLineItemId
            }
        };

        try {
            const response = await axios.post(
                `https://${merchant.shopDomain}/admin/api/${API_VERSION}/graphql.json`,
                graphqlQuery,
                {
                    headers: {
                        'X-Shopify-Access-Token': merchant.shopifyAccessToken,
                        'Content-Type': 'application/json'
                    }
                }
            );

            const result = response.data?.data?.appUsageRecordCreate;
            if (result?.userErrors?.length > 0) {
                console.error(`[Billing] Usage record error:`, result.userErrors);
            } else if (result?.appUsageRecord) {
                console.log(`[Billing] ✅ Created usage charge of $${diff} for ${merchant.shopDomain}`);
                merchant.usageChargeTotal = targetCharge;
                merchant.plan = targetPlan;
                await merchant.save();
            }
        } catch (err) {
            console.error(`[Billing] Failed to create usage record:`, err.response?.data || err.message);
        }
    }
}
