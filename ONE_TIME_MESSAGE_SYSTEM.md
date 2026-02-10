# One-Time Message Guarantee System

## Overview
This system ensures customers receive **exactly ONE confirmation message** and **exactly ONE cancellation message** per order, even if Shopify sends multiple webhooks.

## How It Works

### 1. **Deduplication Logic**
Every time a webhook is received, the system checks if a message was already sent for that specific order:

```javascript
// For Order Confirmation
const existingConfirmation = await ActivityLog.findOne({
    orderId: orderId,
    eventType: "order_confirmation",
    messageSent: true
});

// If already sent, skip processing
if (existingConfirmation) {
    console.log(`⚠️ Order confirmation already sent. Skipping duplicate.`);
    return;
}
```

### 2. **Tracking Fields**
Added to `ActivityLog` model:
- **`eventType`**: Identifies the type of message (`order_confirmation`, `order_cancellation`)
- **`messageSent`**: Boolean flag marking if the message was successfully delivered

### 3. **Process Flow**

#### Order Confirmation (`orders/create`)
1. Webhook received from Shopify
2. Check if confirmation already sent for this `orderId`
3. If yes → Skip and return `200 OK`
4. If no → Create activity log with `messageSent: false`
5. Send WhatsApp message
6. On success → Update `messageSent: true`

#### Order Cancellation (`orders/cancelled`)
1. Webhook received from Shopify
2. Check if cancellation already sent for this `orderId`
3. If yes → Skip and return `200 OK`
4. If no → Create activity log with `messageSent: false`
5. Send WhatsApp message
6. On success → Update `messageSent: true`

## Database Schema

### ActivityLog Model
```javascript
{
  orderId: String,              // Shopify order ID
  eventType: String,            // "order_confirmation" or "order_cancellation"
  messageSent: Boolean,         // true = message delivered successfully
  type: String,                 // "confirmed", "cancelled", "pending", "failed"
  customerPhone: String,
  customerName: String,
  message: String,
  createdAt: Date
}
```

## Benefits

✅ **Prevents Duplicate Messages**
- Even if Shopify sends multiple `orders/create` webhooks, only ONE message is sent
- Even if Shopify sends multiple `orders/cancelled` webhooks, only ONE message is sent

✅ **Reliable Tracking**
- Database tracks exactly which orders have had messages sent
- Clear audit trail in activity logs

✅ **Idempotent**
- Safe to retry webhook processing
- Multiple webhook deliveries handled gracefully

## Example Scenarios

### Scenario 1: Normal Order Flow
1. Order created → Confirmation sent ✅
2. Shopify resends webhook → Skipped (already sent) ⏭️
3. Order cancelled → Cancellation sent ✅
4. Shopify resends webhook → Skipped (already sent) ⏭️

**Result**: Customer receives exactly 2 messages (1 confirmation, 1 cancellation)

### Scenario 2: Order Created and Updated
1. Order created → Confirmation sent ✅
2. Order updated (changed address) → Skipped (already sent) ⏭️
3. Order updated (added item) → Skipped (already sent) ⏭️

**Result**: Customer receives exactly 1 message (initial confirmation)

### Scenario 3: Failed Then Successful
1. Order created → Message fails (no phone) ❌
2. Order updated (phone added) → Sends now ✅ (because messageSent is still false)

**Result**: Customer receives 1 message when phone becomes available

## Monitoring

Check if messages were sent:
```javascript
// Find all orders with confirmation sent
db.activitylogs.find({
  eventType: "order_confirmation",
  messageSent: true
})

// Find pending confirmations (not yet sent)
db.activitylogs.find({
  eventType: "order_confirmation",
  messageSent: false
})
```

## Notes

- The system is **event-specific**: A confirmation and cancellation for the same order are tracked separately
- Messages are marked as sent **only after successful WhatsApp delivery**
- If message delivery fails, `messageSent` remains `false`, allowing retry
- Shopify webhook retries are handled gracefully without sending duplicate messages
