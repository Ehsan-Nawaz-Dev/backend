import mongoose from "mongoose";

const FeedbackSchema = new mongoose.Schema(
    {
        merchant: { type: mongoose.Schema.Types.ObjectId, ref: "Merchant", required: true },
        orderId: { type: String, required: true },
        customerName: { type: String },
        customerPhone: { type: String },
        rating: { type: Number, min: 1, max: 5 },
        comment: { type: String },
        sentiment: { type: String, enum: ["positive", "neutral", "negative"] },
        source: { type: String, default: "whatsapp" },
    },
    { timestamps: true }
);

export const Feedback = mongoose.model("Feedback", FeedbackSchema);
