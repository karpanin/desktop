"""Helpers for Open WebUI Desktop Work mode scripts.

    from owui_work.docx import markdown_to_docx
    from owui_work.xlsx import write_workbook, update_cells, append_rows
    from owui_work.pptx import build_presentation
    from owui_work.pdf import extract_text, extract_tables

Each module only imports its library when used, so a script that needs
one format doesn't pay for the others.
"""
