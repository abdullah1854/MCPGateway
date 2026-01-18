---
name: gbcr-commission
description: Debug GBCR commission calculation issues. Activates for "GBCR", "commission", "agreement", "settlement", "FTCNV", "rebate", "vendor commission", "commission not calculating", "wrong commission".
allowed-tools: [Read, Grep, Bash, Task]
---

# GBCR Commission Debugging Protocol

## When This Skill Activates
- "GBCR", "commission", "rebate"
- "Agreement not calculating", "commission wrong"
- "Settlement", "FTCNV offset"
- "Vendor commission", "rebate claim"
- Commission-related debugging

## GBCR System Overview

```
Agreement Setup
    ├── Commission Agreement Header
    │   ├── Agreement Lines (Products/Categories)
    │   ├── Calculation Rules
    │   └── Settlement Configuration
    │
    ├── Transaction Flow
    │   ├── Invoice Posted → Triggers Commission Calc
    │   ├── Commission Calculated → Creates Accrual
    │   └── Settlement Run → Creates Voucher
    │
    └── Integration Points
        ├── D365 Sales/Purchase
        ├── Voucher Posting (FTCNV)
        └── GL Settlement
```

## Common Issues & Diagnosis

### Issue 1: Commission Not Calculating

**Check Sequence:**
```sql
-- 1. Verify agreement is active
SELECT AgreementNo, Status, ValidFrom, ValidTo
FROM CommissionAgreement
WHERE AgreementNo = 'AGREEMENT_NO'
  AND DATAAREAID = 'GBE';

-- 2. Check if product/category matches agreement line
SELECT * FROM CommissionAgreementLine
WHERE AgreementNo = 'AGREEMENT_NO'
  AND DATAAREAID = 'GBE';

-- 3. Verify invoice matches criteria
SELECT InvoiceId, InvoiceDate, VendorAccount, Amount
FROM VendInvoiceJour
WHERE InvoiceId = 'INVOICE_NO'
  AND DATAAREAID = 'GBE';

-- 4. Check commission calculation log
SELECT * FROM CommissionCalculationLog
WHERE SourceDocument = 'INVOICE_NO'
  AND DATAAREAID = 'GBE';
```

### Issue 2: Wrong Commission Amount

**Comparative Analysis (Platinum Rule):**
```sql
-- Find a correctly calculated commission
SELECT TOP 5 * FROM CommissionTrans
WHERE AgreementNo = 'AGREEMENT_NO'
  AND Status = 'Calculated'
  AND DATAAREAID = 'GBE'
ORDER BY TransDate DESC;

-- Compare with the wrong one
SELECT * FROM CommissionTrans
WHERE SourceInvoice = 'WRONG_INVOICE'
  AND DATAAREAID = 'GBE';

-- DIFF the two: Look at Rate, Base, Quantity fields
```

### Issue 3: FTCNV Offset Problems

FTCNV vouchers indicate settlement transactions:

```sql
-- Find FTCNV settlements
SELECT Voucher, TransDate, AmountCur, AccountNum
FROM GeneralJournalEntry
WHERE Voucher LIKE 'FTCNV%'
  AND TransDate BETWEEN 'START' AND 'END'
  AND DATAAREAID = 'GBE';

-- Trace to source settlement
SELECT * FROM CommissionSettlement
WHERE SettlementVoucher LIKE 'FTCNV%'
  AND DATAAREAID = 'GBE';
```

### Issue 4: Script Skipping Records

When batch job skips records:
```sql
-- Check processing log
SELECT * FROM CommissionProcessLog
WHERE ProcessDate = 'DATE'
  AND DATAAREAID = 'GBE'
  AND Status = 'Skipped';

-- Common skip reasons:
-- - Agreement expired
-- - Product not in scope
-- - Minimum threshold not met
-- - Duplicate detection
```

## Debugging Workflow

### Step 1: Agreement Verification
```sql
SELECT
    H.AgreementNo,
    H.VendorAccount,
    H.Status,
    H.ValidFrom,
    H.ValidTo,
    H.CalculationType,
    L.ProductCode,
    L.CategoryId,
    L.CommissionRate
FROM CommissionAgreement H
JOIN CommissionAgreementLine L ON H.AgreementNo = L.AgreementNo
WHERE H.AgreementNo = 'CPVL2508201'
  AND H.DATAAREAID = 'GBE';
```

### Step 2: Transaction Matching
```sql
-- Check if invoice matches agreement criteria
SELECT
    I.InvoiceId,
    I.VendorAccount,
    IL.ItemId,
    IL.LineAmount,
    A.AgreementNo,
    AL.CommissionRate
FROM VendInvoiceJour I
JOIN VendInvoiceTrans IL ON I.InvoiceId = IL.InvoiceId
LEFT JOIN CommissionAgreement A ON I.VendorAccount = A.VendorAccount
LEFT JOIN CommissionAgreementLine AL ON A.AgreementNo = AL.AgreementNo
    AND (IL.ItemId = AL.ProductCode OR IL.CategoryId = AL.CategoryId)
WHERE I.InvoiceId = 'INVOICE_NO'
  AND I.DATAAREAID = 'GBE';
```

### Step 3: Calculation Trace
```sql
-- Trace the calculation
SELECT
    SourceDocument,
    AgreementNo,
    CalculatedAmount,
    BaseAmount,
    Rate,
    CalculationDate,
    Status,
    ErrorMessage
FROM CommissionCalculationLog
WHERE SourceDocument = 'INVOICE_NO'
  AND DATAAREAID = 'GBE'
ORDER BY CalculationDate;
```

### Step 4: Settlement Verification
```sql
-- Check settlement status
SELECT
    SettlementId,
    AgreementNo,
    PeriodFrom,
    PeriodTo,
    TotalAmount,
    Status,
    Voucher
FROM CommissionSettlement
WHERE AgreementNo = 'AGREEMENT_NO'
  AND DATAAREAID = 'GBE'
ORDER BY PeriodTo DESC;
```

## Root Cause Categories

| Symptom | Likely Cause | Check |
|---------|--------------|-------|
| No commission at all | Agreement inactive or expired | Agreement Status & Dates |
| Wrong amount | Rate or base misconfigured | Agreement Line setup |
| Partial calculation | Product not in scope | Agreement Line products |
| FTCNV offset wrong | Settlement config issue | GL account mapping |
| Skipped invoices | Filter criteria | Processing log |

## Resolution Patterns

### Fix 1: Reprocess Invoice
```sql
-- Mark for reprocessing
UPDATE CommissionProcessQueue
SET Status = 'Pending'
WHERE SourceDocument = 'INVOICE_NO'
  AND DATAAREAID = 'GBE';
```

### Fix 2: Adjust Agreement Line
If product was missing from scope:
1. Add product/category to agreement line
2. Rerun calculation for affected period

### Fix 3: Settlement Reversal
If settlement was wrong:
1. Reverse the FTCNV voucher
2. Recalculate commission
3. Re-run settlement

## Output Format
```markdown
## GBCR Commission Debug: [Agreement/Invoice]

### Agreement Status
[Active/Inactive, dates, vendor]

### Transaction Match
[Does invoice match agreement criteria?]

### Calculation Result
[What was calculated vs expected]

### Root Cause
[Why the issue occurred]

### Resolution
[How to fix it]
```

## Key Principle
Commission issues are almost always: (1) Agreement not matching, (2) Product not in scope, or (3) Settlement timing. Check these three first.
