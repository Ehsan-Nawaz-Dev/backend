/**
 * Scope Migration Script
 * 
 * Run this script when you change SHOPIFY_SCOPES to mark ALL existing merchants
 * for re-authorization with the new scopes.
 * 
 * Usage:
 *   node scripts/migrate-scopes.js
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { Merchant } from '../src/models/Merchant.js';

dotenv.config();

const CURRENT_SCOPE_VERSION = parseInt(process.env.SHOPIFY_SCOPE_VERSION || '1');

async function migrateScopestoNewVersion() {
    try {
        console.log('🔧 Connecting to MongoDB...');
        await mongoose.connect(process.env.MONGODB_URI);
        console.log('✅ Connected to MongoDB\n');

        console.log(`📊 Current Scope Version: ${CURRENT_SCOPE_VERSION}`);
        console.log(`📝 Current Scopes: ${process.env.SHOPIFY_SCOPES}\n`);

        // Find all merchants with old scope version
        const outdatedMerchants = await Merchant.find({
            $or: [
                { scopeVersion: { $lt: CURRENT_SCOPE_VERSION } },
                { scopeVersion: { $exists: false } } // Old merchants without scopeVersion field
            ]
        });

        console.log(`🔍 Found ${outdatedMerchants.length} merchants needing re-authorization\n`);

        if (outdatedMerchants.length === 0) {
            console.log('✅ All merchants are up to date!');
            process.exit(0);
        }

        console.log('Merchants needing re-auth:');
        outdatedMerchants.forEach((merchant, index) => {
            console.log(`  ${index + 1}. ${merchant.shopDomain} (current version: ${merchant.scopeVersion || 'unknown'})`);
        });

        console.log('\n🚀 Marking merchants for re-authorization...');

        // Update all outdated merchants
        const result = await Merchant.updateMany(
            {
                $or: [
                    { scopeVersion: { $lt: CURRENT_SCOPE_VERSION } },
                    { scopeVersion: { $exists: false } }
                ]
            },
            {
                $set: {
                    needsReauth: true,
                    reauthReason: 'App scopes have been updated. Please reconnect to grant new permissions.',
                    reauthDetectedAt: new Date()
                }
            }
        );

        console.log(`\n✅ Migration Complete!`);
        console.log(`   - ${result.modifiedCount} merchants marked for re-authorization`);
        console.log(`   - Merchants will see a banner prompting them to reconnect`);
        console.log(`   - After re-auth, they will be upgraded to scope version ${CURRENT_SCOPE_VERSION}\n`);

        console.log('📧 Next Steps:');
        console.log('   1. Merchants will see a re-authorization banner in their dashboard');
        console.log('   2. They click "Reconnect Shopify Now"');
        console.log('   3. Shopify OAuth flow with new scopes');
        console.log('   4. scopeVersion automatically updated to', CURRENT_SCOPE_VERSION);
        console.log('   5. needsReauth cleared ✅\n');

    } catch (error) {
        console.error('❌ Migration Error:', error);
        process.exit(1);
    } finally {
        await mongoose.disconnect();
        console.log('👋 Disconnected from MongoDB');
        process.exit(0);
    }
}

// Run migration
migrateScopestoNewVersion();
