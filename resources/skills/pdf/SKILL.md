---
name: pdf
description: Read, search, split, merge and extract tables from PDF files, and turn content into a shareable document. Use whenever a PDF is the input or the user wants a PDF.
---

# PDF files

## Read

`read_file` returns the text of a PDF with `## Page N` markers — start there. For long
PDFs read a page range with `start_line` / `end_line`, or search with a script.

Scanned PDFs (only images) have no text layer: `read_file` says so. OCR is not
available — tell the user.

## Tables

```python
from owui_work.pdf import extract_tables
import pandas as pd

for t in extract_tables("Invoice.pdf"):
    df = pd.DataFrame(t["rows"][1:], columns=t["rows"][0])
    print("page", t["page"])
    print(df.to_string())
```

To hand tables to the user, write them to Excel with the xlsx skill
(`owui_work.xlsx.write_workbook`).

## Search in a PDF

```python
from owui_work.pdf import extract_text
import re

text = extract_text("Contract.pdf")
for page in text.split("## Page ")[1:]:
    number, _, body = page.partition("\n")
    for m in re.finditer(r"(?i)penalt\w*", body):
        start = max(0, m.start() - 80)
        print(f"p.{number}: …{body[start:m.end() + 80]}…")
```

## Split, merge, rotate, extract pages

```python
from pypdf import PdfReader, PdfWriter

# pages 3–5 into a new file
reader = PdfReader("Report.pdf")
writer = PdfWriter()
for i in range(2, 5):
    writer.add_page(reader.pages[i])
writer.write("Report pages 3-5.pdf")

# merge
merged = PdfWriter()
for name in ["Part 1.pdf", "Part 2.pdf"]:
    for page in PdfReader(name).pages:
        merged.add_page(page)
merged.write("Combined.pdf")

# rotate every page 90°
writer = PdfWriter(clone_from="Scan.pdf")
for page in writer.pages:
    page.rotate(90)
writer.write("Scan (rotated).pdf")
```

## Create a PDF

There is no PDF text layout engine here. For documents, create a Word file with the
docx skill and tell the user they can export it to PDF from Word (File → Save as → PDF).
Charts and simple one-page visuals can be saved directly as PDF with matplotlib:
`plt.savefig("chart.pdf")`.

## Finish

Call `display_file` for files you created, and quote page numbers when you cite a PDF.
Reply in the user's language.
