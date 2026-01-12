export const replacePlaceholders = (template, data) => {
    if (!template) return "";
    const { order, merchant } = data;
    const findValue = (values) => values.find(v => v !== null && v !== undefined && v !== "") || "";

    // Robust Extraction
    const address = findValue([
        order.shipping_address?.address1,
        order.shipping_address?.address2,
        order.billing_address?.address1,
        order.customer?.default_address?.address1,
        order.order?.shipping_address?.address1,
        order.order?.billing_address?.address1
    ]) || "Address not provided";

    const city = findValue([
        order.shipping_address?.city,
        order.billing_address?.city,
        order.customer?.default_address?.city,
        order.order?.shipping_address?.city,
        order.order?.billing_address?.city
    ]) || "City not provided";

    // DEBUG: Log the actual address objects to see what's available
    console.log(`[PlaceholderHelper] DEBUG - shipping_address:`, JSON.stringify(order.shipping_address || null));
    console.log(`[PlaceholderHelper] DEBUG - billing_address:`, JSON.stringify(order.billing_address || null));
    console.log(`[PlaceholderHelper] DEBUG - customer.default_address:`, JSON.stringify(order.customer?.default_address || null));

    const rawPrice = findValue([
        order.total_price,
        order.current_total_price,
        order.total_price_set?.shop_money?.amount,
        order.order?.total_price,
        order.order?.current_total_price
    ]) || "0.00";

    const price = typeof rawPrice === 'number' ? rawPrice.toFixed(2) : rawPrice;
    const currency = order.currency || order.presentment_currency || order.order?.currency || "";
    const customerPhone = order.customer?.phone || order.shipping_address?.phone || order.billing_address?.phone || order.phone || "";

    console.log(`[PlaceholderHelper] Extracted values:`, {
        address,
        city,
        price,
        currency,
        customerName: order.customer?.first_name ? `${order.customer.first_name} ${order.customer.last_name || ""}`.trim() : (order.shipping_address?.name || order.billing_address?.name || "Customer")
    });

    const placeholders = {
        "{{store_name}}": merchant?.storeName || merchant?.shopDomain || "",
        "{{order_number}}": order.name || order.order_number || `#${order.id || order.order_id}`,
        "{{customer_name}}": (order.customer?.first_name ? `${order.customer.first_name} ${order.customer.last_name || ""}`.trim() : (order.shipping_address?.name || order.billing_address?.name || "Customer")),
        "{{order_id}}": (order.id || order.order_id)?.toString() || "",
        "{{total_price}}": `${currency} ${price}`.trim(),
        "{{price}}": price,
        "{{address}}": address,
        "{{shipping_address}}": address,
        "{{city}}": city,
        "{{phone}}": customerPhone,
        "{{customer_phone}}": customerPhone,
        "{{items_list}}": (order.line_items || order.order?.line_items || []).map(item => `${item.title} x ${item.quantity}`).join(", "),
    };

    let message = template;
    for (const [placeholder, value] of Object.entries(placeholders)) {
        // Safe replacement for all occurrences
        message = message.split(placeholder).join(String(value || ""));
    }
    return message;
};
