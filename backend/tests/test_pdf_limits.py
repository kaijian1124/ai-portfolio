from io import BytesIO
from types import SimpleNamespace as NS

import pytest
from pypdf import PdfWriter

from app import ingestion
from app.files import validate_upload


@pytest.mark.parametrize("pages,allowed", [(100, True), (108, True), (300, True), (301, False)])
def test_resume_pdf_page_boundaries(pages, allowed):
    pdf = PdfWriter()
    for _ in range(pages):
        pdf.add_blank_page(width=72, height=72)
    stream = BytesIO()
    pdf.write(stream)
    if allowed:
        assert validate_upload(stream.getvalue(), "resume", "test.pdf")[0] == ".pdf"
    else:
        with pytest.raises(ValueError):
            validate_upload(stream.getvalue(), "resume", "test.pdf")


@pytest.mark.parametrize("pages,allowed", [(108, True), (300, True), (301, False)])
def test_knowledge_page_boundaries(monkeypatch, pages, allowed):
    monkeypatch.setattr(
        ingestion,
        "PdfReader",
        lambda *a, **k: NS(
            is_encrypted=False, pages=[NS(extract_text=lambda: "TEST evidence")] * pages
        ),
    )
    if allowed:
        assert len(ingestion.extract_document(b"%PDF-test", ".pdf")) == pages
    else:
        with pytest.raises(ValueError, match="300"):
            ingestion.extract_document(b"%PDF-test", ".pdf")
