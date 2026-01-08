export const replacePlaceholders = (template, data) => {
    if (!template) return "";

    const { order, merchant } = data;

    const placeholders = {
        "{{store_name}}": merchant?.storeName || merchant?.shopDomain || "",
        "{{order_number}}": order.name || order.order_number || `#${order.id}`,
        "{{order_id}}": order.id?.toString() || "",
        "{{total_price}}": order.total_price || order.total_price_set?.shop_money?.amount || "0.00",
        "{{subtotal}}": order.subtotal_price || order.subtotal_price_set?.shop_money?.amount || "0.00",
        "{{shipping_address}}": order.shipping_address?.address1 || "",
        "{{city}}": order.shipping_address?.city || "",
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
