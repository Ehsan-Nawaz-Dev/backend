import { Router } from "express";
import { ActivityLog } from "../models/ActivityLog.js";

const router = Router();

// This endpoint will receive incoming WhatsApp messages (from Twilio or WhatsApp Cloud API)
router.post("/", async (req, res) => {
  try {
    const payload = req.body;

    // When poll response is received
    const { pollResponse, shop, customerPhone } = payload;

    if (pollResponse && pollResponse.selectedOptions && pollResponse.selectedOptions.length > 0) {
      const { Merchant } = await import("../models/Merchant.js");
      const { whatsappService } = await import("../services/whatsappService.js");
      const { ActivityLog } = await import("../models/ActivityLog.js");
      const { shopifyService } = await import("../services/shopifyService.js");

      const selectedOption = pollResponse.selectedOptions[0];
      const merchant = await Merchant.findOne({ shopDomain: shop });

      if (merchant) {
        let replyText = "";
        let tagToAdd = "";

        if (selectedOption === "✅Yes, Confirm✅") {
          replyText = merchant.orderConfirmReply || "Your order is confirmed, thank you! ✅";
          tagToAdd = merchant.orderConfirmTag || "Order Confirmed";
        } else if (selectedOption === "❌No, Cancel❌") {
          replyText = merchant.orderCancelReply || "Your order has been cancelled. ❌";
          tagToAdd = merchant.orderCancelTag || "Order Cancelled";
        }

        if (replyText) {
          await whatsappService.sendMessage(shop, customerPhone, replyText);

          // Also handle Shopify tagging if we can find the order
          const log = await ActivityLog.findOne({
            merchant: merchant._id,
            customerPhone: new RegExp(customerPhone.slice(-10)),
            type: "confirmed"
          }).sort({ createdAt: -1 });

          if (log && log.orderId && tagToAdd) {
            await shopifyService.addOrderTag(shop, merchant.shopifyAccessToken, log.orderId, tagToAdd);
            log.message = `Customer voted ${selectedOption} 📊`;
            await log.save();
          }
        }
      }
    }

    res.status(200).json({ received: true });
  } catch (err) {
    console.error("Error handling WhatsApp webhook", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
