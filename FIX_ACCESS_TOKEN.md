# Fix: Invalid Shopify Access Token

## Problem
Backend logs show: `[API] Invalid API key or access token (unrecognized login or wrong password)`

This means the Shopify access token stored in the database is either:
- Expired
- Invalid
- Missing
- Revoked by the merchant

## 🆕 Automatic Detection System

The system now **automatically detects** invalid token errors and marks merchants for re-authorization.

### How it works:
1. When any Shopify API call fails with an authentication error, the system automatically:
   - Logs: `[ShopifyService] 🚨 AUTH ERROR DETECTED for {shop} - Marking for re-authorization`
   - Sets `needsReauth: true` in the merchant's database record
   - Stores the reason and timestamp

2. Frontend can check the auth status via:
   ```
   GET /api/settings/auth-status?shop={shop}.myshopify.com
   ```
   
   Response:
   ```json
   {
     "authenticated": false,
     "needsReauth": true,
     "reason": "Invalid or expired Shopify access token",
     "detectedAt": "2024-01-15T10:30:00Z",
     "reauthUrl": "https://api.whatomatic.com/api/auth/shopify?shop={shop}.myshopify.com"
   }
   ```

3. Frontend should redirect to `reauthUrl` to trigger re-authorization

## Manual Solutions

### Option 1: Ask Merchant to Click "Settings" → "Reconnect Shopify"
The frontend should have a "Reconnect" button that triggers the OAuth flow again.

### Option 2: Manual Re-authorization
1. Have the merchant go to this URL (replace `{shop}` with their actual shop domain):
   ```
   https://api.whatomatic.com/api/auth/shopify?shop={shop}.myshopify.com
   ```
   
   Example: `https://api.whatomatic.com/api/auth/shopify?shop=ezone-9374.myshopify.com`

2. This will redirect them to Shopify's authorization page
3. After they approve, the backend will automatically:
   - Get a new access token
   - Save it to the database
   - Clear the `needsReauth` flag
   - Register webhooks

### Option 3: Check Database Manually
Run this in your MongoDB to see if the token exists:

```javascript
db.merchants.findOne({ shopDomain: "ezone-9374.myshopify.com" }, { shopifyAccessToken: 1, needsReauth: 1, reauthReason: 1 })
```

If `shopifyAccessToken` is `null` or `needsReauth` is `true`, the merchant MUST re-authorize.

## Prevention
- Shopify access tokens don't expire automatically for embedded apps
- But they CAN be revoked if:
  - The app is uninstalled and reinstalled
  - The merchant revokes access manually
  - The app scopes are changed (requires re-auth)

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api/settings/auth-status?shop={shop}` | Check if re-auth is needed |
| `GET /api/diagnostics?shop={shop}` | Full diagnostic info including auth status |
| `GET /api/auth/shopify?shop={shop}` | Trigger OAuth re-authorization |

## Test After Fix
After re-authorization, test by creating a new order in Shopify. The backend should:
1. Receive the webhook
2. Successfully tag the order
3. Send WhatsApp message
