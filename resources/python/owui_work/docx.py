"""Word documents from Markdown (python-docx).

    from owui_work.docx import markdown_to_docx
    markdown_to_docx(markdown_text, "report.docx", title="Q3 report")

Supported Markdown: headings (#..######), paragraphs, **bold**, *italic*,
`code`, [links](https://...), bullet and numbered lists (nested by
indentation), pipe tables, > quotes, ``` code blocks, ![images](file.png),
--- rules and <!-- pagebreak --> page breaks.
"""

import os
import re

from docx import Document
from docx.enum.text import WD_BREAK
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Inches, Pt, RGBColor

_INLINE = re.compile(
    r"(\*\*\*(?P<bi>.+?)\*\*\*"
    r"|\*\*(?P<b>.+?)\*\*"
    r"|__(?P<b2>.+?)__"
    r"|(?<![\w*])\*(?P<i>[^*\n]+?)\*(?![\w*])"
    r"|(?<![\w_])_(?P<i2>[^_\n]+?)_(?![\w_])"
    r"|`(?P<code>[^`\n]+)`"
    r"|\[(?P<ltext>[^\]]+)\]\((?P<lurl>[^)\s]+)\))"
)
_TABLE_SEP = re.compile(r"^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$")
_LIST = re.compile(r"^(?P<indent>\s*)(?P<marker>[-*+]|\d+[.)])\s+(?P<text>.*)$")


def _add_hyperlink(paragraph, text, url):
    part = paragraph.part
    rel_id = part.relate_to(
        url, "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink", is_external=True
    )
    link = OxmlElement("w:hyperlink")
    link.set(qn("r:id"), rel_id)
    run = OxmlElement("w:r")
    props = OxmlElement("w:rPr")
    color = OxmlElement("w:color")
    color.set(qn("w:val"), "0563C1")
    underline = OxmlElement("w:u")
    underline.set(qn("w:val"), "single")
    props.append(color)
    props.append(underline)
    run.append(props)
    t = OxmlElement("w:t")
    t.text = text
    t.set(qn("xml:space"), "preserve")
    run.append(t)
    link.append(run)
    paragraph._p.append(link)


def _add_inline(paragraph, text):
    pos = 0
    for m in _INLINE.finditer(text):
        if m.start() > pos:
            paragraph.add_run(text[pos : m.start()])
        if m.group("bi"):
            run = paragraph.add_run(m.group("bi"))
            run.bold = run.italic = True
        elif m.group("b") or m.group("b2"):
            paragraph.add_run(m.group("b") or m.group("b2")).bold = True
        elif m.group("i") or m.group("i2"):
            paragraph.add_run(m.group("i") or m.group("i2")).italic = True
        elif m.group("code"):
            run = paragraph.add_run(m.group("code"))
            run.font.name = "Consolas"
        elif m.group("ltext"):
            _add_hyperlink(paragraph, m.group("ltext"), m.group("lurl"))
        pos = m.end()
    if pos < len(text):
        paragraph.add_run(text[pos:])


def _split_row(line):
    line = line.strip()
    if line.startswith("|"):
        line = line[1:]
    if line.endswith("|"):
        line = line[:-1]
    return [cell.strip() for cell in re.split(r"(?<!\\)\|", line)]


def _add_table(doc, rows):
    header, body = rows[0], rows[1:]
    cols = max(len(r) for r in rows)
    table = doc.add_table(rows=1 + len(body), cols=cols)
    table.style = "Table Grid"
    for r, row in enumerate([header] + body):
        for c in range(cols):
            cell = table.cell(r, c)
            cell.text = ""
            _add_inline(cell.paragraphs[0], row[c] if c < len(row) else "")
            if r == 0:
                for run in cell.paragraphs[0].runs:
                    run.bold = True
    doc.add_paragraph()


def _list_style(doc, numbered, level):
    base = "List Number" if numbered else "List Bullet"
    name = base if level == 0 else f"{base} {min(level + 1, 3)}"
    try:
        doc.styles[name]
        return name
    except KeyError:
        return base


def _clear_body(doc):
    body = doc.element.body
    for child in list(body):
        if child.tag != qn("w:sectPr"):
            body.remove(child)


def markdown_to_docx(markdown, path, title=None, template=None, font="Calibri", font_size=11):
    """Write Markdown as a .docx file and return its path.

    template: an existing .docx whose styles, headers and footers are kept
    (its body text is replaced).
    """
    doc = Document(template) if template else Document()
    if template:
        _clear_body(doc)
    else:
        normal = doc.styles["Normal"]
        normal.font.name = font
        normal.font.size = Pt(font_size)
    if title:
        doc.core_properties.title = title

    lines = markdown.replace("\r\n", "\n").split("\n")
    paragraph_buf = []

    def flush():
        if paragraph_buf:
            _add_inline(doc.add_paragraph(), " ".join(s.strip() for s in paragraph_buf))
            paragraph_buf.clear()

    i = 0
    while i < len(lines):
        line = lines[i]
        stripped = line.strip()

        if not stripped:
            flush()
            i += 1
            continue

        if stripped.startswith("```"):
            flush()
            code = []
            i += 1
            while i < len(lines) and not lines[i].strip().startswith("```"):
                code.append(lines[i])
                i += 1
            p = doc.add_paragraph()
            run = p.add_run("\n".join(code))
            run.font.name = "Consolas"
            run.font.size = Pt(max(font_size - 1, 8))
            run.font.color.rgb = RGBColor(0x33, 0x33, 0x33)
            i += 1
            continue

        heading = re.match(r"^(#{1,6})\s+(.*)$", stripped)
        if heading:
            flush()
            level = len(heading.group(1))
            p = doc.add_heading(level=min(level, 9))
            _add_inline(p, heading.group(2).strip().rstrip("#").strip())
            i += 1
            continue

        if stripped in ("<!-- pagebreak -->", "\\pagebreak", "\\newpage"):
            flush()
            doc.add_paragraph().add_run().add_break(WD_BREAK.PAGE)
            i += 1
            continue

        if re.match(r"^(-{3,}|\*{3,}|_{3,})$", stripped):
            flush()
            doc.add_paragraph()
            i += 1
            continue

        if "|" in stripped and i + 1 < len(lines) and _TABLE_SEP.match(lines[i + 1]):
            flush()
            rows = [_split_row(stripped)]
            i += 2
            while i < len(lines) and "|" in lines[i] and lines[i].strip():
                rows.append(_split_row(lines[i]))
                i += 1
            _add_table(doc, rows)
            continue

        image = re.match(r"^!\[(?P<alt>[^\]]*)\]\((?P<src>[^)\s]+)\)$", stripped)
        if image:
            flush()
            src = image.group("src")
            if os.path.exists(src):
                doc.add_picture(src, width=Inches(6))
                if image.group("alt"):
                    cap = doc.add_paragraph(image.group("alt"))
                    cap.runs[0].italic = True
            else:
                doc.add_paragraph(f"[image not found: {src}]")
            i += 1
            continue

        if stripped.startswith(">"):
            flush()
            quote = []
            while i < len(lines) and lines[i].strip().startswith(">"):
                quote.append(lines[i].strip()[1:].strip())
                i += 1
            try:
                p = doc.add_paragraph(style="Quote")
            except KeyError:
                p = doc.add_paragraph()
            _add_inline(p, " ".join(quote))
            continue

        item = _LIST.match(line)
        if item:
            flush()
            indent = len(item.group("indent").replace("\t", "    "))
            level = min(indent // 2, 2) if indent < 4 else min(indent // 4, 2)
            numbered = item.group("marker")[0].isdigit()
            p = doc.add_paragraph(style=_list_style(doc, numbered, level))
            _add_inline(p, item.group("text"))
            i += 1
            continue

        paragraph_buf.append(line)
        i += 1

    flush()
    folder = os.path.dirname(os.path.abspath(path))
    os.makedirs(folder, exist_ok=True)
    doc.save(path)
    return path
