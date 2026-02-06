import { Router } from "express";
import { ChatButtonSettings } from "../models/ChatButtonSettings.js";

const router = Router();

// GET /api/storefront/button.js?shop=your-shop.myshopify.com
router.get("/button.js", async (req, res) => {
    const { shop } = req.query;
    if (!shop) return res.status(400).send("// Missing shop parameter");

    try {
        console.log(`[Storefront] Serving button script for: ${shop}`);
        const settings = await ChatButtonSettings.findOne({ shopDomain: shop });

        if (!settings) {
            console.log(`[Storefront] No settings found for ${shop}`);
            return res.type("application/javascript").send("// WhatsApp button settings not found");
        }

        if (!settings.enabled) {
            console.log(`[Storefront] Button is disabled for ${shop}`);
            return res.type("application/javascript").send("// WhatsApp button is disabled");
        }

        const { phoneNumber, buttonText, position, color } = settings;
        const normalizedPhone = phoneNumber ? phoneNumber.replace(/[^\d]/g, "") : "";

        const script = `
(function() {
    function initWhatsAppButton() {
        if (document.getElementById('whatflow-whatsapp-button')) return;

        const container = document.createElement('div');
        container.id = 'whatflow-whatsapp-button';
        container.style.position = 'fixed';
        container.style.bottom = '20px';
        container.style.${position === 'left' ? 'left' : 'right'} = '20px';
        container.style.zIndex = '999999';
        container.style.display = 'flex';
        container.style.alignItems = 'center';
        container.style.gap = '10px';
        container.style.cursor = 'pointer';
        container.style.transition = 'all 0.3s ease';

        const link = document.createElement('a');
        link.href = 'https://wa.me/${normalizedPhone}?text=' + encodeURIComponent('Hi, I have a question about my order.');
        link.target = '_blank';
        link.style.textDecoration = 'none';
        link.style.display = 'flex';
        link.style.alignItems = 'center';
        link.style.backgroundColor = '${color || "#25D366"}';
        link.style.color = '#ffffff';
        link.style.padding = '12px 20px';
        link.style.borderRadius = '50px';
        link.style.boxShadow = '0 4px 12px rgba(0,0,0,0.15)';
        link.style.fontWeight = 'bold';
        link.style.fontSize = '14px';
        link.style.fontFamily = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

        const icon = document.createElement('span');
        icon.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-message-circle"><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/></svg>';
        icon.style.marginRight = '8px';
        icon.style.display = 'flex';
        icon.style.alignItems = 'center';

        const text = document.createElement('span');
        text.innerText = '${buttonText || "Chat with us"}';

        link.appendChild(icon);
        link.appendChild(text);
        container.appendChild(link);
        document.body.appendChild(container);

        // Hover effect
        container.onmouseenter = () => { container.style.transform = 'scale(1.05)'; };
        container.onmouseleave = () => { container.style.transform = 'scale(1)'; };
    }

    if (document.readyState === 'complete') {
        initWhatsAppButton();
    } else {
        window.addEventListener('load', initWhatsAppButton);
    }
})();
        `;

        res.type("application/javascript").send(script);
    } catch (err) {
        console.error("Error serving storefront script:", err);
        res.status(500).send("// Internal server error");
    }
});

export default router;
