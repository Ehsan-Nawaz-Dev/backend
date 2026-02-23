import mongoose from "mongoose";

const TemplateSchema = new mongoose.Schema(
  {
    merchant: { type: mongoose.Schema.Types.ObjectId, ref: "Merchant", required: true },
    name: { type: String, required: true },
    event: {
      type: String,
      enum: [
        "orders/create",
        "checkouts/abandoned",
        "fulfillments/update",
        "orders/cancelled",
        "admin-order-alert",
        "orders/confirmed",
        "orders/cancel_verify",
      ],
      required: true,
    },
    message: { type: String, required: true },
    enabled: { type: Boolean, default: true },
    isPoll: { type: Boolean, default: false },
    pollOptions: { type: [String], default: ["✅Yes, Confirm✅", "❌No, Cancel❌"] },
    sendingDelay: { type: Number, default: 0 }, // Sending delay in minutes. 0 = default safe guard
  },
  { timestamps: true },
);

export const Template = mongoose.model("Template", TemplateSchema);
