import mongoose from "mongoose";

const MerchantSchema = new mongoose.Schema(
  {
    shopDomain: { type: String, required: true, unique: true },
    shopifyAccessToken: { type: String },

    // Auto-fetched from Shopify
    storeName: { type: String },
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
    pendingConfirmTag: { type: String, default: 'Order Pending' },
    orderConfirmTag: { type: String, default: 'Confirmed Order' },
    orderCancelTag: { type: String, default: 'Cancelled Order' },

    // Reply Messages
    orderConfirmReply: { type: String, default: 'Thank you! Your order has been confirmed. ✅' },
    orderCancelReply: { type: String, default: 'Your order has been cancelled. ❌' },

    // Legacy fields (kept for backward compatibility)
    defaultCountry: { type: String },
    language: { type: String },

    // Status
    isActive: { type: Boolean, default: true },
    installedAt: { type: Date },
  },
  { timestamps: true }
);

export const Merchant = mongoose.model("Merchant", MerchantSchema);
