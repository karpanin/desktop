---
name: pptx
description: Create and edit PowerPoint presentations (.pptx) — decks, slides from a report or table, speaker notes, charts. Use whenever the user wants slides.
---

# PowerPoint presentations (.pptx)

You work through `run_script` (Python) in the project folder. `read_file` shows a
presentation as text per slide (`## Slide N`, with speaker notes).

## Plan first

Before writing code, outline the deck: one message per slide, 3–5 short bullets
(max ~12 words each), details go into speaker notes. A typical deck: title slide,
agenda or summary, 3–8 content slides, conclusion / next steps.

## Create a presentation

```python
from owui_work.pptx import build_presentation

build_presentation("Q3 results.pptx", [
    {"layout": "title", "title": "Q3 results", "subtitle": "Sales department · October 2026"},
    {"title": "Summary", "bullets": [
        "Revenue +12% vs Q2",
        "North region grew fastest",
        {"text": "+40% thanks to the new contract", "level": 1},
        "Costs stayed flat",
    ], "notes": "Start with the headline number."},
    {"title": "Revenue by region", "table": {
        "columns": ["Region", "Q2", "Q3", "Change"],
        "rows": [["North", "100", "140", "+40%"], ["South", "90", "110", "+22%"]],
    }},
    {"title": "Monthly trend", "chart": {
        "type": "line", "categories": ["Jul", "Aug", "Sep"],
        "series": [{"name": "North", "values": [42, 46, 52]},
                   {"name": "South", "values": [35, 36, 39]}],
    }},
    {"title": "Plan vs actual", "left": ["Plan: 230", "Hiring: 2"],
                                "right": ["Actual: 250", "Hiring: 1"]},
    {"title": "Next steps", "bullets": ["Partner programme pilot", "Two new account managers"]},
])
print("saved")
```

Slide types: `layout: "title"` (title + subtitle), `bullets` (levels 0–4),
`left` / `right` (two columns), `table` (`columns` + `rows`), `chart` (`type`: column,
bar, line, pie; `categories`; `series` with `name` and `values`), `image` (a PNG/JPG in
the project — e.g. a matplotlib chart), `text` (free text). Every slide may have
`notes`.

Company design: pass the user's deck or template — its theme and layouts are used:
`build_presentation("Deck.pptx", slides, template="templates/company.pptx")`.

## Edit an existing presentation

```python
from pptx import Presentation

prs = Presentation("Deck.pptx")
for number, slide in enumerate(prs.slides, start=1):
    for shape in slide.shapes:
        if shape.has_text_frame and "2025" in shape.text_frame.text:
            for p in shape.text_frame.paragraphs:
                for run in p.runs:
                    run.text = run.text.replace("2025", "2026")
prs.save("Deck (updated).pptx")
```

- speaker notes: `slide.notes_slide.notes_text_frame.text = "…"`
- delete a slide: `xml_slides = prs.slides._sldIdLst; xml_slides.remove(list(xml_slides)[index])`
- reorder: move the element inside `prs.slides._sldIdLst`

Save under a new name unless the user asked to overwrite.

## Finish

1. `read_file` the presentation and check every slide has a title and fits the plan.
2. Call `display_file` so the user can see it.
3. List the slides briefly in your reply.

Reply in the user's language; write slides in the language the user asked for.
