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
      ],
      required: true,
    },
    message: { type: String, required: true },
    enabled: { type: Boolean, default: true },
  },
  { timestamps: true },
);

export const Template = mongoose.model("Template", TemplateSchema);
