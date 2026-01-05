import { whatsappService } from "./whatsappService.js";
import { Campaign } from "../models/Campaign.js";

class CampaignService {
    async sendCampaign(campaignId) {
        const campaign = await Campaign.findById(campaignId);
        if (!campaign) return;

        campaign.status = "sending";
        await campaign.save();

        const { shopDomain, contacts, message } = campaign;
        const batchSize = 5;
        const waitTime = 2000; // 2 seconds

        for (let i = 0; i < contacts.length; i += batchSize) {
            const batch = contacts.slice(i, i + batchSize);

            const promises = batch.map(async (contact) => {
                try {
                    // Replace placeholders
                    let personalizedMessage = message.replace(/{{name}}/g, contact.name || "");

                    const result = await whatsappService.sendMessage(shopDomain, contact.phone, personalizedMessage);

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
            });

            await Promise.all(promises);
            await campaign.save();

            // Wait if not the last batch
            if (i + batchSize < contacts.length) {
                await new Promise(resolve => setTimeout(resolve, waitTime));
            }
        }

        campaign.status = "completed";
        await campaign.save();
    }
}

export const campaignService = new CampaignService();
