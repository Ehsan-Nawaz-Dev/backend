import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const WHATSAPP_API_URL = "https://graph.facebook.com/v21.0";
const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const BUSINESS_ACCOUNT_ID = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;

class WhatsAppCloudService {
    constructor() {
        this.apiUrl = WHATSAPP_API_URL;
        this.accessToken = ACCESS_TOKEN;
        this.phoneNumberId = PHONE_NUMBER_ID;
        this.businessAccountId = BUSINESS_ACCOUNT_ID;
    }

    /**
     * Send a text message to a WhatsApp user
     * @param {string} to - Recipient phone number (with country code, e.g., "+1234567890")
     * @param {string} message - Text message to send
     * @returns {Promise<object>} Response from WhatsApp API
     */
    async sendTextMessage(to, message) {
        try {
            // Remove any spaces, dashes, or parentheses from phone number
            const formattedNumber = to.replace(/[^0-9+]/g, "");

            const response = await axios.post(
                `${this.apiUrl}/${this.phoneNumberId}/messages`,
                {
                    messaging_product: "whatsapp",
                    recipient_type: "individual",
                    to: formattedNumber,
                    type: "text",
                    text: {
                        preview_url: false,
                        body: message,
                    },
                },
                {
                    headers: {
                        Authorization: `Bearer ${this.accessToken}`,
                        "Content-Type": "application/json",
                    },
                }
            );

            console.log("Message sent successfully:", response.data);
            return {
                success: true,
                messageId: response.data.messages[0].id,
                data: response.data,
            };
        } catch (error) {
            console.error("Error sending WhatsApp message:", error.response?.data || error.message);
            return {
                success: false,
                error: error.response?.data?.error?.message || error.message,
                details: error.response?.data,
            };
        }
    }

    /**
     * Send a template message
     * @param {string} to - Recipient phone number
     * @param {string} templateName - Name of the approved template
     * @param {string} languageCode - Template language code (e.g., "en_US")
     * @param {Array} components - Template components (optional parameters)
     * @returns {Promise<object>} Response from WhatsApp API
     */
    async sendTemplateMessage(to, templateName, languageCode = "en", components = []) {
        try {
            const formattedNumber = to.replace(/[^0-9+]/g, "");

            const payload = {
                messaging_product: "whatsapp",
                recipient_type: "individual",
                to: formattedNumber,
                type: "template",
                template: {
                    name: templateName,
                    language: {
                        code: languageCode,
                    },
                },
            };

            // Add components if provided (for parameterized templates)
            if (components.length > 0) {
                payload.template.components = components;
            }

            const response = await axios.post(
                `${this.apiUrl}/${this.phoneNumberId}/messages`,
                payload,
                {
                    headers: {
                        Authorization: `Bearer ${this.accessToken}`,
                        "Content-Type": "application/json",
                    },
                }
            );

            console.log("Template message sent successfully:", response.data);
            return {
                success: true,
                messageId: response.data.messages[0].id,
                data: response.data,
            };
        } catch (error) {
            console.error("Error sending template message:", error.response?.data || error.message);
            return {
                success: false,
                error: error.response?.data?.error?.message || error.message,
                details: error.response?.data,
            };
        }
    }

    /**
     * Send an image message
     * @param {string} to - Recipient phone number
     * @param {string} imageUrl - URL of the image or media ID
     * @param {string} caption - Optional caption for the image
     * @returns {Promise<object>} Response from WhatsApp API
     */
    async sendImageMessage(to, imageUrl, caption = "") {
        try {
            const formattedNumber = to.replace(/[^0-9+]/g, "");

            const payload = {
                messaging_product: "whatsapp",
                recipient_type: "individual",
                to: formattedNumber,
                type: "image",
                image: {
                    link: imageUrl,
                },
            };

            if (caption) {
                payload.image.caption = caption;
            }

            const response = await axios.post(
                `${this.apiUrl}/${this.phoneNumberId}/messages`,
                payload,
                {
                    headers: {
                        Authorization: `Bearer ${this.accessToken}`,
                        "Content-Type": "application/json",
                    },
                }
            );

            console.log("Image message sent successfully:", response.data);
            return {
                success: true,
                messageId: response.data.messages[0].id,
                data: response.data,
            };
        } catch (error) {
            console.error("Error sending image message:", error.response?.data || error.message);
            return {
                success: false,
                error: error.response?.data?.error?.message || error.message,
                details: error.response?.data,
            };
        }
    }

    /**
     * Get message templates
     * @returns {Promise<object>} List of approved message templates
     */
    async getMessageTemplates() {
        try {
            const response = await axios.get(
                `${this.apiUrl}/${this.businessAccountId}/message_templates`,
                {
                    headers: {
                        Authorization: `Bearer ${this.accessToken}`,
                    },
                    params: {
                        limit: 100,
                    },
                }
            );

            return {
                success: true,
                templates: response.data.data,
                paging: response.data.paging,
            };
        } catch (error) {
            console.error("Error fetching templates:", error.response?.data || error.message);
            return {
                success: false,
                error: error.response?.data?.error?.message || error.message,
                details: error.response?.data,
            };
        }
    }

    /**
     * Mark a message as read
     * @param {string} messageId - ID of the message to mark as read
     * @returns {Promise<object>} Response from WhatsApp API
     */
    async markMessageAsRead(messageId) {
        try {
            const response = await axios.post(
                `${this.apiUrl}/${this.phoneNumberId}/messages`,
                {
                    messaging_product: "whatsapp",
                    status: "read",
                    message_id: messageId,
                },
                {
                    headers: {
                        Authorization: `Bearer ${this.accessToken}`,
                        "Content-Type": "application/json",
                    },
                }
            );

            return {
                success: true,
                data: response.data,
            };
        } catch (error) {
            console.error("Error marking message as read:", error.response?.data || error.message);
            return {
                success: false,
                error: error.response?.data?.error?.message || error.message,
            };
        }
    }

    /**
     * Verify webhook subscription
     * @param {string} mode - Webhook mode
     * @param {string} token - Verify token
     * @param {string} challenge - Challenge string
     * @returns {string|null} Challenge string if verification succeeds, null otherwise
     */
    verifyWebhook(mode, token, challenge) {
        const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;

        if (mode === "subscribe" && token === VERIFY_TOKEN) {
            console.log("Webhook verified successfully");
            return challenge;
        }

        console.error("Webhook verification failed");
        return null;
    }

    /**
     * Process incoming webhook message
     * @param {object} webhookBody - Webhook request body
     * @returns {object} Processed message data
     */
    processIncomingMessage(webhookBody) {
        try {
            const entry = webhookBody.entry?.[0];
            const changes = entry?.changes?.[0];
            const value = changes?.value;

            if (!value?.messages) {
                return { success: false, reason: "No messages in webhook" };
            }

            const message = value.messages[0];
            const contact = value.contacts?.[0];

            const processedData = {
                messageId: message.id,
                from: message.from,
                timestamp: message.timestamp,
                type: message.type,
                contactName: contact?.profile?.name,
            };

            // Extract message content based on type
            switch (message.type) {
                case "text":
                    processedData.text = message.text.body;
                    break;
                case "image":
                    processedData.image = {
                        id: message.image.id,
                        mimeType: message.image.mime_type,
                        caption: message.image.caption,
                    };
                    break;
                case "document":
                    processedData.document = {
                        id: message.document.id,
                        filename: message.document.filename,
                        mimeType: message.document.mime_type,
                    };
                    break;
                case "audio":
                    processedData.audio = {
                        id: message.audio.id,
                        mimeType: message.audio.mime_type,
                    };
                    break;
                case "video":
                    processedData.video = {
                        id: message.video.id,
                        mimeType: message.video.mime_type,
                    };
                    break;
                default:
                    processedData.unsupported = true;
            }

            return {
                success: true,
                data: processedData,
            };
        } catch (error) {
            console.error("Error processing incoming message:", error);
            return {
                success: false,
                error: error.message,
            };
        }
    }
}

// Export singleton instance
export const whatsappCloudService = new WhatsAppCloudService();
