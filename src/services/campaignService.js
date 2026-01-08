import { whatsappService } from "./whatsappService.js";
import { Campaign } from "../models/Campaign.js";

class CampaignService {
    async sendCampaign(campaignId) {
        const campaign = await Campaign.findById(campaignId);
        if (!campaign) return;

        campaign.status = "sending";
        await campaign.save();

        const { shopDomain, contacts, message } = campaign;

        for (let i = 0; i < contacts.length; i++) {
            const contact = contacts[i];

            // Wait before sending if not the first message
            if (i > 0) {
                // Determine base delay: 2nd message ~60s, 3rd message ~90s, then randomized
                // User requested: 1 min for 2nd, 1.5 min for 3rd, and random [1m, 1.5m]
                let baseDelay;
                if (i === 1) {
                    baseDelay = 60000; // 1 minute for the 2nd message
                } else if (i === 2) {
                    baseDelay = 90000; // 1.5 minutes for the 3rd message
                } else {
                    // Randomize between 60s and 90s for subsequent messages
                    baseDelay = Math.floor(Math.random() * (90000 - 60000 + 1)) + 60000;
                }

                // Add a small random jitter (+/- 5 seconds) to avoid exact timing detection
                const jitter = (Math.random() * 10000) - 5000;
                const finalDelay = Math.max(60000, Math.min(90000, baseDelay + jitter));

                console.log(`Campaign ${campaignId}: Waiting ${Math.round(finalDelay / 1000)} seconds before sending to ${contact.phone} (Message ${i + 1}/${contacts.length})`);
                await WhatsAppService.delay(finalDelay);
            }

            try {
                // Replace placeholders
                let personalizedMessage = message.replace(/{{name}}/g, contact.name || "");

                let result;
                if (campaign.isPoll && campaign.pollOptions?.length > 0) {
                    result = await whatsappService.sendPoll(shopDomain, contact.phone, personalizedMessage, campaign.pollOptions);
                } else {
                    result = await whatsappService.sendMessage(shopDomain, contact.phone, personalizedMessage);
                }

                if (result.success) {
                    contact.status = "sent";
                    campaign.sentCount += 1;
                } else {
                    contact.status = "failed";
                    contact.error = result.error;
                }
            } catch (err) {
                contact.status = "failed";
                contact.error = err.message;
            }

            // Save progress after each message send
            await campaign.save();
        }

        campaign.status = "completed";
        await campaign.save();
    }
}

export const campaignService = new CampaignService();
