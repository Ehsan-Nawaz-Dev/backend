import mongoose from "mongoose";

const MerchantSchema = new mongoose.Schema(
  {
    shopDomain: { type: String, required: true, unique: true },
    shopifyAccessToken: { type: String },

    // Auto-fetched from Shopify
    storeName: { type: String },
    contactName: { type: String },
    email: { type: String },
    phone: { type: String },
    currency: { type: String, default: 'USD' },
    timezone: { type: String },
    country: { type: String },

    // WhatsApp Settings
    whatsappNumber: { type: String },
    adminPhoneNumber: { type: String },
    whatsappProvider: { type: String, enum: ["twilio", "cloud", "device"], default: "device" },

    // Tag Settings
    pendingConfirmTag: { type: String, default: 'Pending Confirmation' },
    orderConfirmTag: { type: String, default: 'Order Confirmed' },
    orderCancelTag: { type: String, default: 'Order Cancel By customer' },

    // Reply Messages
    orderConfirmReply: { type: String, default: 'Thank you! Your order has been confirmed. ✅' },
    orderCancelReply: { type: String, default: 'Your order has been cancelled. ❌' },

    // Legacy fields (kept for backward compatibility)
    defaultCountry: { type: String },
    language: { type: String },

    // Billing Status
    plan: { type: String, default: 'free' },
    billingStatus: { type: String, default: 'inactive' },

    // Trial & Usage System
    trialActivated: { type: Boolean, default: false },
    trialStartedAt: { type: Date },
    usage: { type: Number, default: 0 },
    trialUsage: { type: Number, default: 0 },
    trialLimit: { type: Number, default: 10 },

    // Status
    isActive: { type: Boolean, default: true },
    installedAt: { type: Date },
  },
  { timestamps: true }
);

export const Merchant = mongoose.model("Merchant", MerchantSchema);
