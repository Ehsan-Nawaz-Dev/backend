# Manual OAuth Setup Guide

Since the automatic OAuth flow is having redirect issues, here's how to manually set up your Shopify access token.

## Option 1: Fix Shopify Partner Dashboard URLs (Recommended)

1. Go to: https://partners.shopify.com
2. Navigate to: **Apps** → **[Your App Name]** → **Configuration**
3. Find the **URLs** section
4. Set these values:
   - **App URL**: `https://backend-wfmy.onrender.com/api/auth/shopify`
   - **Allowed redirection URL(s)**: Add this URL:
     ```
     https://backend-wfmy.onrender.com/api/auth/shopify/callback
     ```
5. Click **Save**
6. Wait 2 minutes, then visit:
   ```
   https://backend-wfmy.onrender.com/api/auth/shopify?shop=ezone-9374.myshopify.com
   ```

## Option 2: Use Shopify Admin to Install App

1. Go to your Shopify Admin: https://ezone-9374.myshopify.com/admin
2. Navigate to: **Settings** → **Apps and sales channels**
3. Click **Develop apps**
4. Find your app or click **Create an app**
5. Configure API access with these scopes:
   - `read_orders`
   - `write_orders`
   - `read_customers`
6. Install the app
7. Copy the **Admin API access token**
8. Use the token in Option 3 below

## Option 3: Manually Save Access Token (If you have it)

If you already have an access token from Shopify Admin, you can save it directly:

1. Get your access token from Shopify Admin (Settings → Apps and sales channels → Develop apps → [Your App] → API credentials → Admin API access token)

2. Use this curl command (replace `YOUR_TOKEN_HERE` with your actual token):

```bash
curl -X POST https://backend-wfmy.onrender.com/api/debug/save-token \
  -H "Content-Type: application/json" \
  -d '{
    "shop": "ezone-9374.myshopify.com",
    "accessToken": "YOUR_TOKEN_HERE"
  }'
```

## Verification

After completing any option above, verify the setup:

```
https://backend-wfmy.onrender.com/api/debug/merchant?shop=ezone-9374.myshopify.com
```

You should see:
```json
{
  "hasAccessToken": true,
  "accessTokenLength": 32
}
```

## Next Steps

Once the access token is saved:
1. Create a test order in Shopify
2. Check if "Order Pending" tag appears
3. "Subscription Required" should be removed automatically
