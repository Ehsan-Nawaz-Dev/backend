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
          tagToAdd = "Order Confirmed";
        } else if (selectedOption === "❌No, Cancel❌") {
          replyText = merchant.orderCancelReply || "Your order has been cancelled. ❌";
          tagToAdd = "Order Cancelled";
        }

        if (tagToAdd) {
          // 1. Tag in Shopify
          const log = await ActivityLog.findOne({
            merchant: merchant._id,
            customerPhone: new RegExp(customerPhone.slice(-10)),
            type: "confirmed"
          }).sort({ createdAt: -1 });

          if (log && log.orderId) {
            await shopifyService.addOrderTag(shop, merchant.shopifyAccessToken, log.orderId, tagToAdd);

            // 2. TRIGGER ADMIN ALERT (ONLY IF CONFIRMED)
            if (selectedOption === "✅Yes, Confirm✅") {
              // Wait 60s before Admin Alert
              await (await import("../services/whatsappService.js")).whatsappService.constructor.delay(60000);

              try {
                const { AutomationSetting } = await import("../models/AutomationSetting.js");
                const { Template } = await import("../models/Template.js");
                const adminSetting = await AutomationSetting.findOne({ shopDomain: merchant.shopDomain, type: "admin-order-alert" });

                if (adminSetting?.enabled && merchant.adminPhoneNumber) {
                  const adminTemplate = await Template.findOne({ merchant: merchant._id, event: "admin-order-alert" });
                  if (adminTemplate) {
                    const orderData = await shopifyService.getOrder(merchant.shopDomain, merchant.shopifyAccessToken, log.orderId);
                    if (orderData) {
                      const { replacePlaceholders } = await import("../utils/placeholderHelper.js");
                      const { automationService } = await import("../services/automationService.js");
                      let adminMsg = replacePlaceholders(adminTemplate.message, { order: orderData, merchant });
                      await whatsappService.sendMessage(shop, merchant.adminPhoneNumber, adminMsg);
                      await automationService.trackSent(merchant.shopDomain, "admin-order-alert");
                    }
                  }
                }
              } catch (adminErr) {
                console.error("Error triggering admin alert from webhook:", adminErr);
              }

              // 80s delay for Customer Reply (As requested: 80s after admin)
              await (await import("../services/whatsappService.js")).whatsappService.constructor.delay(80000);
            }

            log.message = `Customer voted ${selectedOption} 📊`;
            await log.save();
          }
        }

        if (replyText) {
          // If already waited (confirmed), the delay happened above. 
          // If cancelled, send immediately or with small delay (user only specified delays for confirmation).
          await whatsappService.sendMessage(shop, customerPhone, replyText);
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
