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
            // Wait reduced for demo
            if (i > 0) {
                await WhatsAppService.delay(1000); // 1 second between messages for demo
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
