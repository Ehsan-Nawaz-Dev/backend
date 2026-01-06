import dotenv from "dotenv";
import { whatsappCloudService } from "./src/services/whatsappCloudService.js";

dotenv.config();

console.log("🧪 Testing WhatsApp Cloud API Configuration...\n");

// Check if credentials are set
console.log("📋 Checking environment variables:");
console.log("✓ WHATSAPP_ACCESS_TOKEN:", process.env.WHATSAPP_ACCESS_TOKEN ? "✅ Set" : "❌ Missing");
console.log("✓ WHATSAPP_PHONE_NUMBER_ID:", process.env.WHATSAPP_PHONE_NUMBER_ID ? "✅ Set" : "❌ Missing");
console.log("✓ WHATSAPP_BUSINESS_ACCOUNT_ID:", process.env.WHATSAPP_BUSINESS_ACCOUNT_ID ? "✅ Set" : "❌ Missing");
console.log("✓ WHATSAPP_VERIFY_TOKEN:", process.env.WHATSAPP_VERIFY_TOKEN ? "✅ Set" : "❌ Missing");
console.log();

// Test fetching templates
async function testConnection() {
    console.log("🔌 Testing connection to WhatsApp Cloud API...\n");

    try {
        const result = await whatsappCloudService.getMessageTemplates();

        if (result.success) {
            console.log("✅ SUCCESS! Connected to WhatsApp Cloud API");
            console.log(`📱 Found ${result.templates.length} message template(s)`);

            if (result.templates.length > 0) {
                console.log("\nAvailable templates:");
                result.templates.forEach((template, index) => {
                    console.log(`  ${index + 1}. ${template.name} (${template.language}) - Status: ${template.status}`);
                });
            }
        } else {
            console.log("❌ FAILED to connect to WhatsApp Cloud API");
            console.log("Error:", result.error);
            if (result.details) {
                console.log("Details:", JSON.stringify(result.details, null, 2));
            }
        }
    } catch (error) {
        console.log("❌ ERROR during test:", error.message);
    }
}

testConnection();
