import dotenv from "dotenv";
import axios from "axios";

dotenv.config();

console.log("🔍 Finding your WhatsApp Business Account and Phone Number IDs...\n");

const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;

if (!accessToken) {
    console.log("❌ WHATSAPP_ACCESS_TOKEN not found in .env file");
    process.exit(1);
}

async function findAccountInfo() {
    try {
        console.log("📡 Querying Facebook Graph API...\n");

        // Get user info and WhatsApp Business Accounts
        const response = await axios.get(
            "https://graph.facebook.com/v21.0/me",
            {
                params: {
                    fields: "id,name,whatsapp_business_accounts{id,name,phone_numbers}"
                },
                headers: {
                    Authorization: `Bearer ${accessToken}`
                }
            }
        );

        console.log("✅ Successfully connected!\n");
        console.log("📋 Your Account Information:");
        console.log("─".repeat(60));

        if (response.data.whatsapp_business_accounts) {
            const accounts = response.data.whatsapp_business_accounts.data;

            if (accounts.length === 0) {
                console.log("⚠️  No WhatsApp Business Accounts found.");
                console.log("   Make sure you've set up WhatsApp in your Meta app.");
            } else {
                accounts.forEach((account, index) => {
                    console.log(`\n🏢 Business Account ${index + 1}:`);
                    console.log(`   Name: ${account.name}`);
                    console.log(`   📌 Business Account ID: ${account.id}`);

                    if (account.phone_numbers && account.phone_numbers.data.length > 0) {
                        console.log(`\n   📱 Phone Numbers:`);
                        account.phone_numbers.data.forEach((phone, pIndex) => {
                            console.log(`      ${pIndex + 1}. ${phone.display_phone_number}`);
                            console.log(`         📌 Phone Number ID: ${phone.id}`);
                        });
                    }
                });

                console.log("\n" + "─".repeat(60));
                console.log("\n✏️  Update your .env file with:");
                console.log(`WHATSAPP_BUSINESS_ACCOUNT_ID=${accounts[0].id}`);
                if (accounts[0].phone_numbers?.data[0]) {
                    console.log(`WHATSAPP_PHONE_NUMBER_ID=${accounts[0].phone_numbers.data[0].id}`);
                }
            }
        } else {
            console.log("⚠️  No WhatsApp Business Accounts found in response.");
        }

    } catch (error) {
        console.log("❌ Error:", error.response?.data?.error?.message || error.message);
        if (error.response?.data) {
            console.log("\nDetails:", JSON.stringify(error.response.data, null, 2));
        }
    }
}

findAccountInfo();
