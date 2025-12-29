import mongoose from "mongoose";

const MerchantSchema = new mongoose.Schema(
  {
    shopDomain: { type: String, required: true, unique: true },
    storeName: { type: String },
    whatsappNumber: { type: String },
    defaultCountry: { type: String },
    language: { type: String },
    orderConfirmTag: { type: String, default: "Confirmed" },
    orderCancelTag: { type: String, default: "Cancelled" },
    // OAuth / tokens for Shopify & WhatsApp providers (to be filled later)
    shopifyAccessToken: { type: String },
    whatsappProvider: { type: String, enum: ["twilio", "cloud", "device"], default: "device" },
  },
  { timestamps: true },
);

export const Merchant = mongoose.model("Merchant", MerchantSchema);
