import mongoose from "mongoose";

const ActivityLogSchema = new mongoose.Schema(
  {
    merchant: { type: mongoose.Schema.Types.ObjectId, ref: "Merchant", required: false },
    type: {
      type: String,
      enum: ["confirmed", "cancelled", "recovered", "pending"],
      required: true,
    },
    orderId: { type: String },
    customerName: { type: String },
    message: { type: String },
    channel: { type: String, default: "whatsapp" },
    rawPayload: { type: Object },
  },
  { timestamps: true },
);

export const ActivityLog = mongoose.model("ActivityLog", ActivityLogSchema);
