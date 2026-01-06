import dotenv from "dotenv";
import { whatsappCloudService } from "./src/services/whatsappCloudService.js";
import fs from "fs";

dotenv.config();

const TEST_PHONE_NUMBER = "+923048799087"; // User's personal number

console.log("📱 Testing WhatsApp Cloud API - Detailed Error Logging\n");

async function sendSimpleTest() {
    console.log(`Sending test message to: ${TEST_PHONE_NUMBER}\n`);

    const result = await whatsappCloudService.sendTextMessage(
        TEST_PHONE_NUMBER,
        "✅ WhatsApp Cloud API is working! No more Vercel pairing errors!"
    );

    // Log to file for full details
    fs.writeFileSync('test-result.json', JSON.stringify(result, null, 2));

    console.log("\n" + "=".repeat(70));
    if (result.success) {
        console.log("🎉 SUCCESS! Message sent!");
        console.log("📬 Message ID:", result.messageId);
        console.log("\n✨ Check your WhatsApp now at +923048799087");
        console.log("📝 Your Cloud API is ready to use on Vercel!");
    } else {
        console.log("❌ FAILED to send message\n");
        console.log("Error Message:", result.error);
        console.log("\nFull error details saved to: test-result.json");
        console.log("\n" + "=".repeat(70));

        // Check for common errors
        const errorMsg = JSON.stringify(result.details || result.error || "");

        if (errorMsg.includes("recipient phone number not in allowed list")) {
            console.log("\n💡 SOLUTION:");
            console.log("   Your phone number needs to be added as a test recipient.");
            console.log("\n   Steps:");
            console.log("   1. Go to: https://developers.facebook.com/apps");
            console.log("   2. Select your app");
            console.log("   3. Click 'WhatsApp' → 'Getting Started' in left sidebar");
            console.log("   4. Under 'To', click 'Add phone number'");
            console.log("   5. Enter: +923048799087");
            console.log("   6. Verify with the code sent to your WhatsApp");
            console.log("   7. Run this test again");
        } else if (errorMsg.includes("does not exist") || errorMsg.includes("missing permissions")) {
            console.log("\n💡 SOLUTION:");
            console.log("   Your PHONE_NUMBER_ID might be incorrect.");
            console.log("\n   Steps:");
            console.log("   1. Go to: https://developers.facebook.com/apps");
            console.log("   2. Select your app");
            console.log("   3. Click 'WhatsApp' → 'API Setup' in left sidebar");
            console.log("   4. Copy the 'Phone number ID' (not Business Account ID!)");
            console.log("   5. Update WHATSAPP_PHONE_NUMBER_ID in your .env file");
        } else if (errorMsg.includes("Invalid OAuth")) {
            console.log("\n💡 SOLUTION:");
            console.log("   Your access token might have expired.");
            console.log("\n   Steps:");
            console.log("   1. Go to: https://developers.facebook.com/apps");
            console.log("   2. Select your app");
            console.log("   3. Click 'WhatsApp' → 'Getting Started'");
            console.log("   4. Copy the new 'Temporary access token'");
            console.log("   5. Update WHATSAPP_ACCESS_TOKEN in your .env file");
        }
    }
    console.log("=".repeat(70) + "\n");
}

sendSimpleTest();
