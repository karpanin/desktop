---
name: docx
description: Create, edit and review Word documents (.docx) — reports, letters, memos, contracts, minutes. Use whenever the user wants a Word file produced or changed.
---

# Word documents (.docx)

You work through `run_script` (Python) in the project folder. Read files with `read_file`
first — it already turns .docx into text with headings (`#`) and tables (`| a | b |`).

## Create a new document

Write the content as Markdown and convert it with the helper. This gives real Word
headings, lists and tables that the user can restyle in Word.

```python
from owui_work.docx import markdown_to_docx

md = """# Quarterly report

**Period:** July–September 2026

## Summary

Revenue grew by 12% compared to Q2.

## Results by region

| Region | Q2 | Q3 | Change |
|---|---:|---:|---:|
| North | 100 | 140 | +40% |
| South | 90 | 110 | +22% |

## Next steps

1. Hire two account managers
2. Launch the partner programme
   - pilot in the North region
"""

markdown_to_docx(md, "Quarterly report Q3.docx", title="Quarterly report Q3")
print("saved")
```

Supported Markdown: `#`–`######` headings, paragraphs, `**bold**`, `*italic*`, `` `code` ``,
`[links](https://…)`, bullet / numbered lists (indent 2 spaces per level), pipe tables,
`> quotes`, fenced code blocks, `![caption](image.png)` (file in the project),
`---` and `<!-- pagebreak -->`.

Keep the company look: pass an existing document as a template — its styles, headers
and footers are kept, the body is replaced:

```python
markdown_to_docx(md, "Letter to client.docx", template="templates/letterhead.docx")
```

Charts: draw them with matplotlib into a PNG in the project, then reference the image
in the Markdown.

```python
import matplotlib.pyplot as plt
plt.figure(figsize=(7, 3.5))
plt.bar(["North", "South"], [140, 110])
plt.title("Q3 revenue")
plt.tight_layout()
plt.savefig("chart_q3.png", dpi=150)
```

## Edit an existing document

Never rebuild a document the user gave you from Markdown — you would lose its
formatting. Edit it in place with python-docx and save under a new name unless the
user asked to overwrite:

```python
from docx import Document

doc = Document("Contract.docx")

def replace_in_paragraph(p, old, new):
    # Text can be split across runs; join, replace, keep the first run's formatting
    if old not in p.text:
        return False
    full = p.text.replace(old, new)
    for run in p.runs[1:]:
        run.text = ""
    p.runs[0].text = full
    return True

count = 0
for p in doc.paragraphs:
    count += replace_in_paragraph(p, "ООО «Старое»", "ООО «Новое»")
for table in doc.tables:
    for row in table.rows:
        for cell in row.cells:
            for p in cell.paragraphs:
                count += replace_in_paragraph(p, "ООО «Старое»", "ООО «Новое»")

doc.save("Contract (edited).docx")
print("replacements:", count)
```

Other common edits:
- add a paragraph after a heading: find the paragraph, then
  `new = p.insert_paragraph_before("text")` on the next paragraph
- add a table: `doc.add_table(rows=1, cols=3, style="Table Grid")`
- headers/footers: `doc.sections[0].header.paragraphs[0].text = "…"`
- page orientation: `from docx.enum.section import WD_ORIENT` and set
  `section.orientation`, then swap `page_width` / `page_height`

Tracked changes and comments are not supported by python-docx — tell the user and
offer to write the changes as a separate list instead.

## Finish

1. `read_file` the new document and check the text, headings and numbers.
2. Call `display_file` so the user can see it.
3. In your reply say what you created or changed and where it is.

Reply in the user's language; write the document in the language the user asked for
(by default — the language of the conversation).
