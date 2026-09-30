"""Text and tables from PDF files (pdfplumber, with pypdf as fallback).

    from owui_work.pdf import extract_text, extract_tables
    print(extract_text("contract.pdf"))                 # all pages
    print(extract_text("contract.pdf", pages=[1, 2]))   # 1-based page numbers
    tables = extract_tables("invoice.pdf")              # [{page, rows}]

Scanned PDFs (images only) have no text layer — extract_text returns
little or nothing for them; OCR is not available.
"""


def _pages(total, pages):
    if not pages:
        return list(range(total))
    return [p - 1 for p in pages if 1 <= p <= total]


def extract_text(path, pages=None):
    """Return the text with a "## Page N" heading before each page."""
    out = []
    try:
        import pdfplumber

        with pdfplumber.open(path) as pdf:
            for index in _pages(len(pdf.pages), pages):
                text = pdf.pages[index].extract_text() or ""
                out.append(f"## Page {index + 1}\n{text.strip()}")
    except Exception:
        from pypdf import PdfReader

        reader = PdfReader(path)
        out = []
        for index in _pages(len(reader.pages), pages):
            text = reader.pages[index].extract_text() or ""
            out.append(f"## Page {index + 1}\n{text.strip()}")
    return "\n\n".join(out)


def extract_tables(path, pages=None):
    """Return [{"page": n, "rows": [[...], ...]}] for tables pdfplumber detects."""
    try:
        import pdfplumber
    except ImportError:
        raise RuntimeError(
            "Table extraction needs pdfplumber, which is not available on this computer. "
            "Use extract_text() and read the table from the text instead."
        ) from None

    tables = []
    with pdfplumber.open(path) as pdf:
        for index in _pages(len(pdf.pages), pages):
            for table in pdf.pages[index].extract_tables():
                tables.append({"page": index + 1, "rows": table})
    return tables


def page_count(path):
    from pypdf import PdfReader

    return len(PdfReader(path).pages)


if __name__ == "__main__":
    # Used by the desktop's read_file for .pdf files
    import sys

    sys.stdout.reconfigure(encoding="utf-8")
    sys.stdout.write(extract_text(sys.argv[1]))
