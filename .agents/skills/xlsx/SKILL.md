---
name: xlsx
description: Create, edit, and analyze Excel spreadsheets (.xlsx). Activates for "Excel", "spreadsheet", "xlsx", "financial model", "data analysis", "create workbook", "formulas".
allowed-tools: [Read, Write, Bash, Task]
---

# Excel Spreadsheet (XLSX) Skill

## When This Skill Activates
- "Create spreadsheet", "Excel file", "xlsx"
- "Financial model", "budget", "forecast"
- "Data analysis", "pivot table"
- "Add formulas", "calculations"
- "Format spreadsheet", "charts"

## Core Principles

### Formula-First Approach
**CRITICAL: Always use Excel formulas instead of calculating values in Python and hardcoding them.**

```python
# WRONG - Hardcoded calculation
cell.value = 100 * 0.15  # 15

# CORRECT - Excel formula
cell.value = "=A1*B1"  # Recalculates automatically
```

### Financial Modeling Standards

| Convention | Format | Example |
|------------|--------|---------|
| Inputs (assumptions) | Blue text | `font.color = "0000FF"` |
| Formulas | Black text | `font.color = "000000"` |
| Cross-sheet links | Green text | `font.color = "008000"` |
| External references | Red text | `font.color = "FF0000"` |

## Core Workflows

### 1. Reading Excel Files

**With pandas:**
```python
import pandas as pd

# Read specific sheet
df = pd.read_excel('data.xlsx', sheet_name='Sheet1')

# Read all sheets
all_sheets = pd.read_excel('data.xlsx', sheet_name=None)
for name, df in all_sheets.items():
    print(f"Sheet: {name}")
    print(df.head())
```

**With openpyxl (preserves formulas):**
```python
from openpyxl import load_workbook

wb = load_workbook('data.xlsx', data_only=False)  # Keep formulas
ws = wb.active

for row in ws.iter_rows(min_row=1, max_row=10):
    for cell in row:
        print(f"{cell.coordinate}: {cell.value}")
```

### 2. Creating Workbooks

```python
from openpyxl import Workbook
from openpyxl.styles import Font, Alignment, Border, Side, PatternFill
from openpyxl.utils import get_column_letter

wb = Workbook()
ws = wb.active
ws.title = "Data"

# Add headers
headers = ['Name', 'Quantity', 'Price', 'Total']
for col, header in enumerate(headers, 1):
    cell = ws.cell(row=1, column=col, value=header)
    cell.font = Font(bold=True)
    cell.alignment = Alignment(horizontal='center')

# Add data with formulas
data = [
    ('Widget A', 100, 10.50),
    ('Widget B', 50, 25.00),
    ('Widget C', 75, 15.75),
]

for row, (name, qty, price) in enumerate(data, 2):
    ws.cell(row=row, column=1, value=name)
    ws.cell(row=row, column=2, value=qty)
    ws.cell(row=row, column=3, value=price)
    ws.cell(row=row, column=4, value=f"=B{row}*C{row}")  # Formula!

# Add total row
last_row = len(data) + 2
ws.cell(row=last_row, column=3, value="Total:")
ws.cell(row=last_row, column=4, value=f"=SUM(D2:D{last_row-1})")

wb.save('output.xlsx')
```

### 3. Formatting

**Number formats:**
```python
from openpyxl.styles.numbers import FORMAT_CURRENCY_USD_SIMPLE

cell.number_format = '$#,##0.00'           # Currency
cell.number_format = '0.0%'                # Percentage
cell.number_format = '#,##0'               # Number with commas
cell.number_format = 'yyyy-mm-dd'          # Date
```

**Cell styling:**
```python
from openpyxl.styles import Font, PatternFill, Border, Side, Alignment

# Font
cell.font = Font(
    name='Arial',
    size=11,
    bold=True,
    color='000000'
)

# Background
cell.fill = PatternFill(
    start_color='FAF9F5',
    end_color='FAF9F5',
    fill_type='solid'
)

# Border
thin_border = Border(
    left=Side(style='thin'),
    right=Side(style='thin'),
    top=Side(style='thin'),
    bottom=Side(style='thin')
)
cell.border = thin_border

# Alignment
cell.alignment = Alignment(
    horizontal='center',
    vertical='center',
    wrap_text=True
)
```

### 4. Common Formulas

```python
# SUM
ws['D10'] = '=SUM(D2:D9)'

# AVERAGE
ws['E10'] = '=AVERAGE(E2:E9)'

# IF
ws['F2'] = '=IF(D2>100,"High","Low")'

# VLOOKUP
ws['G2'] = '=VLOOKUP(A2,Products!A:C,3,FALSE)'

# SUMIF
ws['H10'] = '=SUMIF(A:A,"Widget*",D:D)'

# INDEX/MATCH (better than VLOOKUP)
ws['I2'] = '=INDEX(C:C,MATCH(A2,A:A,0))'
```

### 5. Charts

```python
from openpyxl.chart import BarChart, Reference

chart = BarChart()
chart.title = "Sales by Product"
chart.x_axis.title = "Product"
chart.y_axis.title = "Revenue"

data = Reference(ws, min_col=4, min_row=1, max_col=4, max_row=5)
categories = Reference(ws, min_col=1, min_row=2, max_row=5)

chart.add_data(data, titles_from_data=True)
chart.set_categories(categories)
chart.shape = 4

ws.add_chart(chart, "F2")
```

### 6. Multiple Sheets

```python
# Create sheets
wb.create_sheet("Inputs")
wb.create_sheet("Calculations")
wb.create_sheet("Output")

# Access sheets
inputs = wb["Inputs"]
calcs = wb["Calculations"]

# Cross-sheet reference
calcs['A1'] = "=Inputs!B5*1.15"
```

### 7. Data Validation

```python
from openpyxl.worksheet.datavalidation import DataValidation

# Dropdown list
dv = DataValidation(
    type="list",
    formula1='"Option1,Option2,Option3"',
    allow_blank=True
)
dv.add('A2:A100')
ws.add_data_validation(dv)

# Number range
dv_num = DataValidation(
    type="whole",
    operator="between",
    formula1=0,
    formula2=100
)
dv_num.add('B2:B100')
ws.add_data_validation(dv_num)
```

## Dependencies

```bash
pip install openpyxl pandas xlsxwriter
```

## Zero Formula Errors

Before delivering, verify no errors exist:
```python
# Check for formula errors
ERROR_VALUES = ['#REF!', '#DIV/0!', '#VALUE!', '#N/A', '#NAME?', '#NULL!', '#NUM!']

for row in ws.iter_rows():
    for cell in row:
        if cell.value in ERROR_VALUES:
            print(f"Error at {cell.coordinate}: {cell.value}")
```

## Financial Model Template

```
Sheet: Inputs (Blue text)
├── Assumptions
│   ├── Growth Rate: 5%
│   ├── Tax Rate: 21%
│   └── Discount Rate: 10%

Sheet: Model (Black text, formulas)
├── Revenue = Prior Year * (1 + Growth Rate)
├── Expenses = Revenue * Expense Ratio
├── EBIT = Revenue - Expenses
├── Tax = EBIT * Tax Rate
└── Net Income = EBIT - Tax

Sheet: Output (Summary)
├── =Model!NetIncome
└── =NPV(Inputs!DiscountRate, Model!CashFlows)
```

## Output Format

```markdown
## XLSX Operation: [Create/Edit/Analyze]

### Structure
- Sheets: [List of sheets]
- Rows: [Count]
- Formulas: [Count]

### Key Formulas
| Cell | Formula | Purpose |
|------|---------|---------|
| D10 | =SUM(D2:D9) | Total revenue |

### Formatting Applied
- [Headers: Bold, centered]
- [Numbers: Currency format]
- [Totals: Double border]

### Validation
- [ ] No formula errors (#REF!, #DIV/0!, etc.)
- [ ] Formulas recalculate correctly
- [ ] Number formats applied

### Output
[File path, sheet count, row count]
```
