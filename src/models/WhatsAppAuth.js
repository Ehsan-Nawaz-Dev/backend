import mongoose from "mongoose";

const WhatsAppAuthSchema = new mongoose.Schema(
    {
        shopDomain: { type: String, required: true },
        dataType: { type: String, required: true }, // 'creds' or 'keys'
        id: { type: String, required: true },       // The specific key ID (e.g. 'pre-key-1')
        data: { type: mongoose.Schema.Types.Mixed }, // The actual JSON data from Baileys
    },
    { timestamps: true }
);

// Compound index for fast lookups
WhatsAppAuthSchema.index({ shopDomain: 1, dataType: 1, id: 1 }, { unique: true });

export const WhatsAppAuth = mongoose.model("WhatsAppAuth", WhatsAppAuthSchema);
