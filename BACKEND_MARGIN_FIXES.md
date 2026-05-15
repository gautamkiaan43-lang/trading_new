# 🔴 BACKEND MARGIN FIXES REQUIRED

## Root Cause: Wrong Exposure Type Detection

**Problem:** The backend is looking for `exposureType` in the WRONG place, so it always defaults to `'per_lot'`.

---

## 🔧 CRITICAL FIXES NEEDED

### FIX 1: tradeController.js Line 561
**File:** `src/controllers/tradeController.js`

**Current (WRONG):**
```javascript
const marginConfig = MarginService.getMarginConfig(sym, marketType, clientConfig);
marginRequired = MarginService.calculateRequiredMargin({
    qty: qtyNum,
    price: executionPrice,
    marginConfig: marginConfig,
    tradeType: 'INTRADAY',  // ❌ HARDCODED!
    lotSize: lotSize
});
```

**Problem:**
- `tradeType: 'INTRADAY'` is HARDCODED
- Should come from request body: `req.body.tradeType`
- Not sending `mcxExposureType` to MarginService

**Fix:**
```javascript
// Add to line 30-37 destructuring:
const { 
    mcxExposureType = 'PER_LOT_BASIS',  // ✅ ADD THIS!
    tradeType = 'INTRADAY'              // ✅ ADD THIS!
} = req.body;

// Then at line 556-563:
const marginConfig = MarginService.getMarginConfig(
    sym, 
    marketType, 
    clientConfig, 
    mcxExposureType  // ✅ PASS THIS!
);
marginRequired = MarginService.calculateRequiredMargin({
    qty: qtyNum,
    price: executionPrice,
    marginConfig: marginConfig,
    tradeType: tradeType,  // ✅ USE REQUEST VALUE!
    lotSize: lotSize
});
```

---

### FIX 2: MarginService.js Line 12 - getMarginConfig()
**File:** `src/services/MarginService.js`

**Current (WRONG):**
```javascript
static getMarginConfig(symbol, marketType, clientConfig) {
    // ... code ...
    // Line 49:
    const normalized = {
        exposureType: (config.exposureType || 'per_lot').toLowerCase(),  // ❌ WRONG!
```

**Problem:**
- Looking for `config.exposureType` (in margin config object) ❌
- Should look in `clientConfig.mcxExposureType` (at root level) ✅
- Using 'per_lot' instead of 'PER_LOT_BASIS' ❌
- Using 'per_crore' instead of 'PER_TURNOVER_BASIS' ❌

**Fix:**
```javascript
static getMarginConfig(symbol, marketType, clientConfig, exposureTypeFromRequest) {
    if (!clientConfig) {
      throw new Error('Client configuration not found');
    }

    let config = {};
    const baseScrip = getMcxBaseScrip(symbol);
    const upperSym = symbol.toUpperCase();

    // Market type specific config extraction
    if (marketType === 'MCX') {
      const mcxMargins = clientConfig.mcxLotMargins || {};
      config = mcxMargins[upperSym] || mcxMargins[baseScrip] || {};

      if (!config || Object.keys(config).length === 0) {
        throw new Error(`No MCX margin configuration found for ${symbol}`);
      }
    }
    // ... rest of code ...

    // ✅ FIX: Get exposure type from REQUEST BODY, not from config!
    const normalizedExposureType = exposureTypeFromRequest 
        || clientConfig.mcxExposureType  // ← FROM ROOT LEVEL!
        || 'PER_LOT_BASIS';  // Default

    const normalized = {
        exposureType: normalizedExposureType,  // ✅ USE REQUEST/ROOT VALUE!
        // Per Lot fields
        INTRADAY: parseFloat(config.INTRADAY || config.intraday_margin || 0),
        HOLDING: parseFloat(config.HOLDING || config.holding_margin || 0),
        // Per Turnover fields (global)
        intradayExposure: parseFloat(clientConfig.mcxIntradayMargin || 500),
        holdingExposure: parseFloat(clientConfig.mcxHoldingMargin || 100),
        // Lot size
        LOT: parseFloat(config.LOT || config.lot || 1)
    };

    return normalized;
}
```

---

### FIX 3: MarginService.js Line 75 - calculateRequiredMargin()
**File:** `src/services/MarginService.js`

**Current (WRONG):**
```javascript
static calculateRequiredMargin(params) {
    // Line 88:
    const exposureType = (marginConfig.exposureType || 'per_lot').toLowerCase();

    // Lines 91-120: Using 'per_lot' and 'per_crore' (OLD NAMES!)
    if (exposureType === 'per_lot') {
        // ...
    } else if (exposureType === 'per_crore') {
        // ...
    }
```

**Problem:**
- Using OLD terminology: 'per_lot' and 'per_crore'
- Should use NEW: 'PER_LOT_BASIS' and 'PER_TURNOVER_BASIS'

**Fix:**
```javascript
static calculateRequiredMargin(params) {
    const { qty, price, marginConfig, tradeType = 'INTRADAY', lotSize = 1 } = params;

    const qtyNum = parseFloat(qty) || 0;
    const priceNum = parseFloat(price) || 0;

    if (qtyNum <= 0) {
      throw new Error('Quantity must be positive');
    }
    if (priceNum <= 0) {
      throw new Error('Price must be positive');
    }

    // ✅ USE NEW TERMINOLOGY!
    const exposureType = marginConfig.exposureType || 'PER_LOT_BASIS';

    // TYPE 1: PER LOT BASIS (Fixed Margin)
    if (exposureType === 'PER_LOT_BASIS') {
        const marginField = tradeType === 'HOLDING' ? 'HOLDING' : 'INTRADAY';
        const marginPerLot = marginConfig[marginField] || 0;

        if (marginPerLot <= 0) {
            throw new Error(`Invalid ${marginField} margin for PER_LOT_BASIS`);
        }

        return qtyNum * marginPerLot;
    }
    // TYPE 2: PER TURNOVER BASIS (Exposure-based)
    else if (exposureType === 'PER_TURNOVER_BASIS') {
        const exposureField = tradeType === 'HOLDING' ? 'holdingExposure' : 'intradayExposure';
        const exposure = marginConfig[exposureField] || 500;

        if (exposure <= 0) {
            throw new Error(`Invalid ${exposureField} for PER_TURNOVER_BASIS`);
        }

        const turnover = priceNum * qtyNum * lotSize;
        return turnover / exposure;
    }
    else {
        throw new Error(`Invalid exposureType: ${exposureType}`);
    }
}
```

---

## 📋 SUMMARY OF BACKEND FIXES

| File | Line | Issue | Fix |
|------|------|-------|-----|
| **tradeController.js** | 30-37 | Missing `mcxExposureType` and `tradeType` in destructuring | Add both to request body destructuring |
| **tradeController.js** | 556 | Not passing `mcxExposureType` to MarginService | Add 4th parameter: `mcxExposureType` |
| **tradeController.js** | 561 | `tradeType` hardcoded to 'INTRADAY' | Use request value: `tradeType` |
| **MarginService.js** | 12 | Function signature missing exposure type | Add `exposureTypeFromRequest` parameter |
| **MarginService.js** | 49 | Looking in wrong place for exposureType | Read from request or root level |
| **MarginService.js** | 88 | Using old 'per_lot'/'per_crore' terminology | Use 'PER_LOT_BASIS'/'PER_TURNOVER_BASIS' |
| **MarginService.js** | 91-120 | Wrong terminology in conditionals | Update all to new terminology |

---

## 🧪 TESTING AFTER FIX

### Backend Console Logs Should Show:

**Per Lot Basis:**
```
✅ Margin calculated via MarginService (PER_LOT_BASIS): ₹50,000.00
[Calculation: 1 × 50000]
```

**Per Turnover Basis:**
```
✅ Margin calculated via MarginService (PER_TURNOVER_BASIS): ₹120.00
[Calculation: (60000 × 1) / 500]
```

### Database Check:

```javascript
// Check trades table:
SELECT symbol, margin_used, created_at FROM trades WHERE user_id = 'YOUR_ID';
// Should show: GOLD26JUNFUT | 120.00 (for per_turnover) or 50000 (for per_lot)

// Check if marginType is stored:
SELECT marginType FROM trades WHERE user_id = 'YOUR_ID';
// Should show: PER_TURNOVER_BASIS or PER_LOT_BASIS
```

---

## ✅ IMPLEMENTATION CHECKLIST

- [ ] tradeController.js: Add `mcxExposureType` and `tradeType` to destructuring (line 30-37)
- [ ] tradeController.js: Pass `mcxExposureType` to MarginService.getMarginConfig() (line 556)
- [ ] tradeController.js: Use request `tradeType` instead of hardcoded (line 561)
- [ ] MarginService.js: Add `exposureTypeFromRequest` parameter to getMarginConfig()
- [ ] MarginService.js: Read exposure type from request or root level clientConfig
- [ ] MarginService.js: Update all terminology from 'per_lot'/'per_crore' to 'PER_LOT_BASIS'/'PER_TURNOVER_BASIS'
- [ ] Test with both exposure types
- [ ] Verify console logs show correct calculation
- [ ] Verify database stores correct margin amount

---

## 🚀 EXPECTED FLOW AFTER FIXES

```
Frontend sends: {symbol, qty, price, mcxExposureType: "PER_TURNOVER_BASIS"}
        ↓
tradeController receives and destructures both values ✅
        ↓
Passes mcxExposureType to MarginService.getMarginConfig() ✅
        ↓
MarginService reads exposureType from request parameter ✅
        ↓
Returns config with exposureType: "PER_TURNOVER_BASIS" ✅
        ↓
calculateRequiredMargin() checks exposureType === 'PER_TURNOVER_BASIS' ✅
        ↓
Calculates: (60000 × 1) / 500 = ₹120 ✅
        ↓
Stores margin_used: 120.00 in database ✅
```

---

**Status: READY FOR BACKEND IMPLEMENTATION** ✅

Apply frontend + backend fixes together for end-to-end solution!
