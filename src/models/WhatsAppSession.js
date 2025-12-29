import mongoose from "mongoose";

const WhatsAppSessionSchema = new mongoose.Schema(
    {
        shopDomain: { type: String, required: true, unique: true },
        sessionId: { type: String, required: true },
        isConnected: { type: Boolean, default: false },
        qrCode: { type: String }, // Base64 QR code
        phoneNumber: { type: String }, // Connected WhatsApp number
        status: {
            type: String,
            enum: ["disconnected", "connecting", "qr_ready", "connected", "error"],
            default: "disconnected"
        },
        lastConnected: { type: Date },
        errorMessage: { type: String },
    },
    { timestamps: true }
);

export const WhatsAppSession = mongoose.model("WhatsAppSession", WhatsAppSessionSchema);
