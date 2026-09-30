---
name: xlsx
description: Create, edit and analyse Excel spreadsheets (.xlsx, .csv) — tables, reports, budgets, calculations, charts, data cleanup. Use whenever a spreadsheet is the input or the result.
---

# Excel spreadsheets (.xlsx)

You work through `run_script` (Python) in the project folder. `read_file` shows a
workbook as CSV per sheet, with formulas as `value [=FORMULA]` — use it to look before
you change anything.

## Rules

- **Use formulas, not numbers you calculated.** Totals, differences, percentages and
  lookups must be Excel formulas (`=SUM(B2:B10)`, `=C2/B2-1`) so the file stays correct
  when the user edits it. Excel calculates them when the file is opened.
- Keep the user's original file: save changes under a new name unless they asked to
  overwrite it.
- One header row, one record per row, no merged cells in data tables.
- Format numbers (thousands separators, %, dates) instead of rounding values.

## Create a new workbook

```python
from owui_work.xlsx import write_workbook

rows = [
    ["Region", "Q2", "Q3", "Change"],
    ["North", 100, 140, "=C2/B2-1"],
    ["South", 90, 110, "=C3/B3-1"],
    ["Total", "=SUM(B2:B3)", "=SUM(C2:C3)", "=C4/B4-1"],
]
write_workbook("Sales Q3.xlsx", [
    {
        "name": "Sales",
        "rows": rows,
        "number_formats": {"B:C": "#,##0", "D": "0.0%"},
        "chart": {"type": "column", "title": "Revenue by region",
                  "data": "B1:C3", "categories": "A2:A3", "anchor": "F2"},
    },
    {"name": "Notes", "rows": [["Source: CRM export 2026-09-30"]], "header": False},
])
print("saved")
```

Sheet options: `rows` (first row = header: bold, frozen, filter), `number_formats`
(`{"B:D": "#,##0.00"}`), `widths` (`{"A": 30}`, default auto), `freeze`, `header`
(False for free-form sheets), `chart` / `charts` (`type`: column, bar, line, pie;
`data` includes the header row for series names).

## Analyse data

Load with pandas, compute, print a compact result, then write a summary sheet with
formulas where the numbers come from the workbook itself:

```python
import pandas as pd

df = pd.read_excel("Orders.xlsx", sheet_name=0)
print(df.shape)
print(df.head(10).to_string())
print(df.groupby("Region")["Amount"].sum().sort_values(ascending=False).to_string())
```

CSV files: `pd.read_csv("file.csv", sep=None, engine="python")` detects `;` or `,`;
for Russian exports try `encoding="cp1251"` if you see broken characters.

## Edit an existing workbook

```python
from owui_work.xlsx import update_cells, append_rows

update_cells("Budget.xlsx", {"C5": 1200, "C12": "=SUM(C2:C11)"}, sheet="2026",
             save_as="Budget (updated).xlsx")
append_rows("Budget (updated).xlsx", [["Travel", 500, 450]], sheet="2026")
```

For anything more complex use openpyxl directly:

```python
from openpyxl import load_workbook
wb = load_workbook("Budget.xlsx")          # formulas stay formulas
ws = wb["2026"]
for row in ws.iter_rows(min_row=2):
    if row[0].value == "Rent":
        row[2].value = 1500
wb.save("Budget (updated).xlsx")
```

Important: openpyxl drops charts, images and pivot tables of an existing file when it
saves. If the workbook has them, save a copy (`save_as`) and tell the user, or put your
results on a new sheet in a new file.

## Finish

1. `read_file` the result and check the formulas reference the right cells.
2. Call `display_file` so the user can see it.
3. Summarise the key numbers in your reply (from your pandas analysis) and name the file.

Reply in the user's language.
