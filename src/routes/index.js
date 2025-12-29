import { Router } from "express";
import settingsRouter from "./settings.js";
import templatesRouter from "./templates.js";
import shopifyWebhooksRouter from "./webhooks-shopify.js";
import whatsappWebhooksRouter from "./webhooks-whatsapp.js";
import activityRouter from "./activity.js";
import contactRouter from "./contact.js";
import notificationsRouter from "./notifications.js";
import analyticsRouter from "./analytics.js";
import shopifyAuthRouter from "./auth-shopify.js";
import whatsappRouter from "./whatsapp.js";
import whatsappCloudRouter from "./whatsapp-cloud.js";

const router = Router();

router.use("/settings", settingsRouter);
router.use("/templates", templatesRouter);
router.use("/webhooks/shopify", shopifyWebhooksRouter);
router.use("/webhooks/whatsapp", whatsappWebhooksRouter);
router.use("/activity", activityRouter);
router.use("/contact", contactRouter);
router.use("/notifications", notificationsRouter);
router.use("/analytics", analyticsRouter);
router.use("/auth/shopify", shopifyAuthRouter);
router.use("/whatsapp", whatsappRouter);
router.use("/whatsapp-cloud", whatsappCloudRouter);

export default router;
