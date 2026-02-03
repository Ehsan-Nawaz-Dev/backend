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
      ],
      required: true,
    },
    message: { type: String, required: true },
    enabled: { type: Boolean, default: true },
    isPoll: { type: Boolean, default: false },
    pollOptions: { type: [String], default: ["✅Yes, Confirm✅", "❌No, Cancel❌"] },
  },
  { timestamps: true },
);

export const Template = mongoose.model("Template", TemplateSchema);
