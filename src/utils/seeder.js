import { Plan } from '../models/Plan.js';

/**
 * Seeds default subscription plans if the collection is empty.
 * This ensures the billing system works on fresh installations.
 */
export const seedPlans = async () => {
    try {
        const count = await Plan.countDocuments();
        if (count > 0) {
            console.log('[Seeder] Plans already exist, skipping seed.');
            return;
        }

        console.log('[Seeder] Seeding default plans...');
        const defaultPlans = [
            {
                id: 'free',
                name: 'Free',
                price: 0,
                messageLimit: 10,
                features: [
                    '10 messages per month',
                    'Basic templates',
                    'Standard support'
                ],
                isActive: true,
                isPopular: false
            },
            {
                id: 'starter',
                name: 'Starter',
                price: 19,
                messageLimit: 500,
                features: [
                    '500 messages per month',
                    'Advanced templates',
                    'Cart recovery',
                    'Standard support'
                ],
                isActive: true,
                isPopular: false
            },
            {
                id: 'growth',
                name: 'Growth',
                price: 49,
                messageLimit: 2000,
                features: [
                    '2000 messages per month',
                    'Advanced analytics',
                    'Everything in Starter',
                    'Priority support'
                ],
                isActive: true,
                isPopular: true
            },
            {
                id: 'pro',
                name: 'Pro',
                price: 99,
                messageLimit: 5000,
                features: [
                    '5,000 messages per month',
                    'Multi-number support',
                    'Dedicated manager',
                    'Everything in Growth'
                ],
                isActive: true,
                isPopular: false
            }
        ];

        await Plan.insertMany(defaultPlans);
        console.log('[Seeder] ✅ Default plans seeded successfully.');
    } catch (err) {
        console.error('[Seeder] ❌ Error seeding plans:', err);
    }
};
