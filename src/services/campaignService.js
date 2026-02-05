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

            // Safer delay for unofficial WhatsApp connection (10-25 seconds)
            if (i > 0) {
                // Mandatory batch break every 15 messages (3 minutes)
                if (i % 15 === 0) {
                    console.log(`[Campaign] Batch limit reached (${i}). Taking a 3-minute safety break...`);
                    await new Promise(resolve => setTimeout(resolve, 180000));
                }

                const safeDelay = Math.floor(Math.random() * (25000 - 10000 + 1)) + 10000;
                console.log(`[Campaign] Waiting ${safeDelay}ms before next message to avoid ban.`);
                await new Promise(resolve => setTimeout(resolve, safeDelay));
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
