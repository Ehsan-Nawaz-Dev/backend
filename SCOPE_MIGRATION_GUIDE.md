# Automatic Scope Migration System

## 🎯 Problem Solved

**The Issue**: When you change Shopify app scopes (permissions), ALL existing merchant access tokens become invalid immediately.

**The Solution**: Automatic detection, notification, and smooth re-authorization for all merchants.

---

## 🔧 How It Works

### 1. **Scope Version Tracking**

**Environment Variable**:
```bash
SHOPIFY_SCOPE_VERSION=2  # Increment when you change scopes
```

**Database Field** (in `Merchant` model):
```javascript
scopeVersion: Number  // Tracks which scope version merchant authorized
```

### 2. **When You Change Scopes**

#### Step 1: Update `.env`
```bash
# Update your scopes
SHOPIFY_SCOPES=read_orders,write_orders,read_billing,write_billing,...

# Increment version number
SHOPIFY_SCOPE_VERSION=2  # Was 1, now 2
```

#### Step 2: Run Migration Script
```bash
cd C:\Users\Ehsan Nawaz\Downloads\backend
node scripts/migrate-scopes.js
```

**What the script does**:
- Finds all merchants with `scopeVersion < 2` (old version)
- Marks them: `needsReauth: true`
- Sets reason: "App scopes have been updated. Please reconnect to grant new permissions."
- All merchants now see the re-auth banner

### 3. **Merchant Experience**

1. **Merchant visits dashboard** → Sees banner:
   ```
   ⚠️ Shopify Connection Needs Update
   We've updated our app permissions. Please reconnect to continue using WhatFlow.
   
   Auto-redirecting in 15 seconds... [Cancel] [Reconnect Now]
   ```

2. **Auto-redirect countdown** (15 seconds)
   - Gives merchant time to read the message
   - Can cancel if they're busy
   - Or click "Reconnect Now" immediately

3. **OAuth Flow Starts**
   - Redirected to Shopify authorization page
   - Shows NEW permissions
   - Merchant clicks "Install" or "Update"

4. **Backend Updates**
   ```javascript
   {
     shopifyAccessToken: "new_token_with_new_scopes",
     scopeVersion: 2,  // Updated to current version
     needsReauth: false,
     reauthReason: null
   }
   ```

5. **Banner Disappears** ✅
   - System resumes normal operation
   - All features work with new scopes

---

## 📊 System Components

### Backend

#### 1. **Environment** (`.env`)
```bash
SHOPIFY_SCOPES=read_orders,write_orders,read_billing,write_billing,...
SHOPIFY_SCOPE_VERSION=2
```

#### 2. **Merchant Model** (`src/models/Merchant.js`)
```javascript
{
  scopeVersion: Number,        // Current scope version
  needsReauth: Boolean,        // Needs re-authorization?
  reauthReason: String,        // Why re-auth needed
  reauthDetectedAt: Date       // When detected
}
```

#### 3. **OAuth Callback** (`src/routes/auth-shopify.js`)
- Automatically sets `scopeVersion` when merchant authorizes
- Clears `needsReauth` flag on successful auth

#### 4. **Migration Script** (`scripts/migrate-scopes.js`)
- Marks all merchants with old scope version
- One-time run after changing scopes

### Frontend

#### **ReAuthBanner Component** (`src/components/dashboard/ReAuthBanner.tsx`)
- Checks auth status dynamically
- Shows countdown (15 seconds)
- Auto-redirects to OAuth
- User can cancel or manually trigger

---

## 🚀 Usage Guide

### Scenario: Adding New Scopes

**Current state**:
```bash
SHOPIFY_SCOPES=read_orders,write_orders
SHOPIFY_SCOPE_VERSION=1
```

**Step 1**: Update scopes in `.env`
```bash
SHOPIFY_SCOPES=read_orders,write_orders,read_billing,write_billing
SHOPIFY_SCOPE_VERSION=2  # Increment!
```

**Step 2**: Update Shopify App Settings
1. Go to Shopify Partners Dashboard
2. Your App → Configuration → App scopes
3. Add new scopes
4. Save

**Step 3**: Run migration
```bash
node scripts/migrate-scopes.js
```

**Output**:
```
🔧 Connecting to MongoDB...
✅ Connected to MongoDB

📊 Current Scope Version: 2
📝 Current Scopes: read_orders,write_orders,read_billing,write_billing

🔍 Found 25 merchants needing re-authorization

Merchants needing re-auth:
  1. shop-a.myshopify.com (current version: 1)
  2. shop-b.myshopify.com (current version: 1)
  3. shop-c.myshopify.com (current version: 1)
  ...

🚀 Marking merchants for re-authorization...

✅ Migration Complete!
   - 25 merchants marked for re-authorization
   - Merchants will see a banner prompting them to reconnect
   - After re-auth, they will be upgraded to scope version 2
```

**Step 4**: Merchants see banner and reconnect
- Each merchant visits their dashboard
- Sees auto-redirect banner
- Completes OAuth with new scopes
- System automatically updates their `scopeVersion` to 2

**Step 5**: Verify completion
```bash
# Check MongoDB
db.merchants.find({ scopeVersion: { $lt: 2 } }).count()  // Should be 0
```

---

## 🎨 Merchant Experience

### Before Scope Change
✅ Everything working normally
✅ `scopeVersion: 1`

### After Scope Change (Your Side)
1. Update `.env`: `SHOPIFY_SCOPE_VERSION=2`
2. Run migration: `node scripts/migrate-scopes.js`

### Merchant's Dashboard
```
┌────────────────────────────────────────────────────────────┐
│ ⚠️  Shopify Connection Needs Update                        │
│                                                            │
│ We've updated our app permissions. Please reconnect to    │
│ continue using WhatFlow.                                   │
│                                                            │
│ Auto-redirecting in 12 seconds...                         │
│                                                            │
│ [Cancel Auto-Redirect]  [Reconnect Now]                   │
└────────────────────────────────────────────────────────────┘
```

### After Reconnect
✅ Banner disappears
✅ `scopeVersion: 2`
✅ All features working with new scopes

---

## 🔒 Security & Best Practices

### Scope Version Management
- **Always increment** `SHOPIFY_SCOPE_VERSION` when changing scopes
- **Never decrement** the version number
- **Test on development store** before production migration

### Migration Timing
- **Off-peak hours**: Run migration when fewer merchants are active
- **Email notification**: Send advance notice to merchants
- **Grace period**: Give merchants 24-48 hours to reconnect before disabling features

### Rollback Plan
If migration fails:
```bash
# Reset all merchants
db.merchants.updateMany(
  {},
  {
    $set: {
      needsReauth: false,
      reauthReason: null,
      reauthDetectedAt: null
    }
  }
)
```

---

## 📝 Changelog Format

Keep a log of scope changes:

```markdown
## Scope Version 2 (2026-02-10)
**Added Scopes**:
- `read_billing` - Required for subscription management
- `write_billing` - Required for creating charges

**Reason**: Implementing Shopify billing integration

**Migration**: 25 merchants migrated successfully
```

---

## 🎯 Summary

This system **automatically handles** scope changes across your entire SaaS platform:

✅ **Detects** outdated scope versions
✅ **Notifies** merchants with friendly banner
✅ **Auto-redirects** after countdown (15s)
✅ **Tracks** migration progress
✅ **Updates** scope version on successful re-auth
✅ **Works** for unlimited merchants independently

**Zero manual intervention required after running the migration script!** 🚀
