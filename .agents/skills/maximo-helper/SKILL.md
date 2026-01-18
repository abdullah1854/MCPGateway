---
name: maximo-helper
description: Maximo database queries with mandatory site filtering. Activates for "Maximo", "work order", "WONUM", "asset", "SITEID", "labor", "LABTRANS", "WORKORDER" queries.
allowed-tools: [Read, Grep, Bash, Task]
---

# Maximo Query Helper Protocol

## When This Skill Activates
- Any mention of "Maximo", "IBM Maximo"
- "Work order", "WONUM", "asset", "equipment"
- "Labor", "LABTRANS", "time entry"
- "Inventory", "parts", "storeroom"
- Queries against Maximo database

## CRITICAL RULE: Mandatory SITEID Filter

**EVERY Maximo query MUST include SITEID = 'YOUR_SITE' (replace with your site ID)**

Without site filtering:
- Queries return cross-site data (privacy/security issue)
- Results are polluted with irrelevant records
- Performance suffers on large datasets

## Core Tables & Relationships

### Work Management
```
WORKORDER (WONUM, SITEID)
    ├── WOSTATUS (Status history)
    ├── LABTRANS (Labor transactions)
    ├── MATUSETRANS (Material usage)
    ├── TOOLTRANS (Tool usage)
    └── WOACTIVITY (Activities)
```

### Asset Management
```
ASSET (ASSETNUM, SITEID)
    ├── ASSETMETER (Meter readings)
    ├── ASSETSPEC (Specifications)
    └── ASSETLOCHISTORY (Location history)
```

### Inventory
```
INVENTORY (ITEMNUM, LOCATION, SITEID)
    ├── INVBALANCES (Balances by bin)
    ├── MATRECTRANS (Receipts)
    └── MATUSETRANS (Issues)
```

## Query Templates

### Work Order Queries
```sql
-- Find work order by WONUM
SELECT WONUM, DESCRIPTION, STATUS, WORKTYPE, ASSETNUM,
       LOCATION, REPORTDATE, SCHEDSTART, ACTSTART, ACTFINISH
FROM WORKORDER
WHERE WONUM = 'WO_NUMBER'
  AND SITEID = 'GBE';  -- MANDATORY

-- Work orders for an asset
SELECT WONUM, DESCRIPTION, STATUS, REPORTDATE
FROM WORKORDER
WHERE ASSETNUM = 'ASSET_NUMBER'
  AND SITEID = 'GBE'
ORDER BY REPORTDATE DESC;

-- Open work orders by type
SELECT WORKTYPE, COUNT(*) AS Count
FROM WORKORDER
WHERE STATUS NOT IN ('CLOSE', 'COMP', 'CAN')
  AND SITEID = 'GBE'
GROUP BY WORKTYPE;
```

### Labor Queries
```sql
-- Labor hours for work order
SELECT L.LABORCODE, L.STARTDATE, L.STARTTIME,
       L.FINISHDATE, L.FINISHTIME, L.REGULARHRS
FROM LABTRANS L
WHERE L.REFWO = 'WO_NUMBER'
  AND L.SITEID = 'GBE';

-- Labor summary by craft
SELECT P.CRAFT, SUM(L.REGULARHRS) AS TotalHours
FROM LABTRANS L
JOIN LABOR P ON L.LABORCODE = P.LABORCODE
WHERE L.TRANSDATE BETWEEN 'START_DATE' AND 'END_DATE'
  AND L.SITEID = 'GBE'
GROUP BY P.CRAFT;
```

### Asset Queries
```sql
-- Asset details
SELECT ASSETNUM, DESCRIPTION, STATUS, LOCATION,
       SERIALNUM, MANUFACTURER, VENDOR
FROM ASSET
WHERE ASSETNUM = 'ASSET_NUMBER'
  AND SITEID = 'GBE';

-- Assets at location
SELECT ASSETNUM, DESCRIPTION, STATUS
FROM ASSET
WHERE LOCATION = 'LOCATION_CODE'
  AND SITEID = 'GBE'
  AND STATUS = 'OPERATING';

-- Asset hierarchy (parent/child)
SELECT ASSETNUM, DESCRIPTION, PARENT, CHILDREN
FROM ASSET
WHERE PARENT = 'PARENT_ASSET'
  AND SITEID = 'GBE';
```

### Inventory Queries
```sql
-- Current balance
SELECT I.ITEMNUM, I.CURBAL, I.AVGCOST,
       IT.DESCRIPTION, I.LOCATION
FROM INVENTORY I
JOIN ITEM IT ON I.ITEMNUM = IT.ITEMNUM
WHERE I.ITEMNUM = 'ITEM_NUMBER'
  AND I.SITEID = 'GBE';

-- Low stock items
SELECT I.ITEMNUM, IT.DESCRIPTION, I.CURBAL, I.MINLEVEL
FROM INVENTORY I
JOIN ITEM IT ON I.ITEMNUM = IT.ITEMNUM
WHERE I.CURBAL < I.MINLEVEL
  AND I.SITEID = 'GBE'
  AND I.MINLEVEL > 0;
```

## Status Codes Reference

### Work Order Status
| Status | Meaning |
|--------|---------|
| WAPPR | Waiting Approval |
| APPR | Approved |
| WSCH | Waiting Schedule |
| WMATL | Waiting Material |
| INPRG | In Progress |
| COMP | Completed |
| CLOSE | Closed |
| CAN | Cancelled |

### Asset Status
| Status | Meaning |
|--------|---------|
| NOT READY | Not commissioned |
| OPERATING | In service |
| DECOMMISSIONED | Out of service |
| BROKEN | Broken/failed |

## Common Debugging Patterns

### Work Order Not Found
```sql
-- Check if exists (without site filter for discovery)
SELECT SITEID, WONUM, STATUS FROM WORKORDER
WHERE WONUM = 'WO_NUMBER';
-- If found with different SITEID, that's your answer
```

### Labor Not Appearing
```sql
-- Check LABTRANS for the work order
SELECT * FROM LABTRANS
WHERE REFWO = 'WO_NUMBER'
  AND SITEID = 'GBE';

-- Check if posted to different WO
SELECT REFWO, REGULARHRS FROM LABTRANS
WHERE LABORCODE = 'LABOR_CODE'
  AND TRANSDATE = 'DATE'
  AND SITEID = 'GBE';
```

### Integration to D365
When tracing from Maximo to D365:
```sql
-- Find Maximo source data
SELECT * FROM INVOICE
WHERE INVOICENUM = 'INVOICE_NUMBER'
  AND SITEID = 'GBE';

-- In D365, look for voucher with DDE prefix (Maximo indicator)
-- Cross-reference using invoice number or external reference
```

## Query Best Practices

1. **Always include SITEID** - No exceptions
2. **Use TOP/LIMIT for discovery** - Don't pull full tables
3. **Index columns in WHERE** - WONUM, ASSETNUM, ITEMNUM are indexed
4. **Date ranges** - Always bound date queries
5. **Status filters** - Exclude CLOSE/CAN when looking for active records

## Output Format
```markdown
## Maximo Query: [Purpose]

### Query
```sql
[The SQL query]
```

### Results
[Key findings]

### Notes
[Any caveats or related information]
```
