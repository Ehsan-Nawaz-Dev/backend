import dotenv from "dotenv";
import { whatsappCloudService } from "./src/services/whatsappCloudService.js";

dotenv.config();

// ⚠️ IMPORTANT: Replace this with YOUR phone number (with country code)
// Example: "+923001234567" for Pakistan
const YOUR_PHONE_NUMBER = "+923001234567"; // 👈 CHANGE THIS!

console.log("📱 Sending test message via WhatsApp Cloud API...\n");

async function sendTestMessage() {
    // Test 1: Send a simple text message
    console.log(`Sending text message to ${YOUR_PHONE_NUMBER}...`);
    const result = await whatsappCloudService.sendTextMessage(
        YOUR_PHONE_NUMBER,
        "🎉 Success! Your WhatsApp Cloud API is working on Vercel!"
    );

    if (result.success) {
        console.log("✅ Message sent successfully!");
        console.log("📬 Message ID:", result.messageId);
        console.log("\n✨ Check your WhatsApp now!");
    } else {
        console.log("❌ Failed to send message");
        console.log("Error:", result.error);
        if (result.details) {
            console.log("Details:", JSON.stringify(result.details, null, 2));
        }
    }
}

sendTestMessage();
