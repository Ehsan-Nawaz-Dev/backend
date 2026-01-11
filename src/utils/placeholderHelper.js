export const replacePlaceholders = (template, data) => {
    if (!template) return "";

    const { order, merchant } = data;

    // Helper function to find first non-empty value
    const findValue = (values) => values.find(v => v && v !== "") || "";

    // Enhanced data extraction with fallbacks
    const address = findValue([
        order.shipping_address?.address1,
        order.shipping_address?.address2,
        order.customer?.default_address?.address1,
        order.billing_address?.address1
    ]) || "Address not provided";

    const city = findValue([
        order.shipping_address?.city,
        order.customer?.default_address?.city,
        order.billing_address?.city
    ]) || "City not provided";

    const price = findValue([
        order.current_total_price,
        order.total_price,
        order.total_price_set?.shop_money?.amount,
        order.current_subtotal_price
    ]) || "0.00";

    // Log for debugging (can be removed in production)
    if (!order.shipping_address?.address1 || !order.shipping_address?.city || !order.total_price) {
        console.log('[PlaceholderHelper] Missing order data:', {
            hasAddress: !!order.shipping_address?.address1,
            hasCity: !!order.shipping_address?.city,
            hasPrice: !!order.total_price,
            orderId: order.id
        });
    }

    const placeholders = {
        "{{store_name}}": merchant?.storeName || merchant?.shopDomain || "",
        "{{order_number}}": order.name || order.order_number || `#${order.id}`,
        "{{customer_name}}": order.customer?.first_name ? `${order.customer.first_name} ${order.customer.last_name || ""}`.trim() : (order.shipping_address?.name || ""),
        "{{order_id}}": order.id?.toString() || "",
        "{{total_price}}": price,
        "{{price}}": price,
        "{{subtotal}}": order.subtotal_price || order.subtotal_price_set?.shop_money?.amount || "0.00",
        "{{shipping_address}}": address,
        "{{address}}": address,
        "{{city}}": city,
        "{{shipping_price}}": (order.shipping_lines || []).reduce((sum, line) => sum + parseFloat(line.price || 0), 0).toFixed(2),
        "{{payment_status}}": (order.financial_status || "PENDING").toUpperCase(),
        "{{items_list}}": (order.line_items || []).map(item => `${item.title} x ${item.quantity}`).join(", ")
    };

    let message = template;
    for (const [placeholder, value] of Object.entries(placeholders)) {
        const regex = new RegExp(placeholder, "g");
        message = message.replace(regex, value);
    }

    return message;
};
