import json
from io import BytesIO
from types import SimpleNamespace
from unittest.mock import AsyncMock
from zipfile import ZipFile

import httpx
import pytest
from openai import APITimeoutError

from app.chat_engine import UsageLedger, resolve_vague_query, vague_query
from app.ingestion import clean, extract_document, pdf_layout_tables, pdf_sections
from app.rerank import rerank_candidates, validate_ranking


def test_pdf_contents_is_removed_but_contents_mentioned_in_prose_is_kept():
    pages = [
        "Contents\nIntroduction .......... 4\nFindings .......... 12\nAppendix .......... 20",
        "Contents of the sample remain part of the evidence.\nThe legal word DRAFT appears here.",
    ]
    report = {}
    assert [s["page"] for s in pdf_sections(pages, report)] == [2]
    assert report["toc_pages_removed"] == 1


def test_legacy_text_is_repaired_without_changing_native_chinese():
    assert clean("CafÃ© and 中文") == "Café and 中文"
    assert clean("Broken glyph � remains visible") == "Broken glyph � remains visible"


def test_docx_preserves_table_cell_boundaries_and_skips_review_text():
    stream = BytesIO()
    with ZipFile(stream, "w") as archive:
        archive.writestr(
            "word/document.xml",
            """<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
            <w:body>
            <w:p><w:r><w:t>Keep me</w:t></w:r><w:del><w:r><w:t>Deleted text</w:t></w:r></w:del></w:p>
            <w:p><w:pPr><w:pStyle w:val="TOC1"/></w:pPr><w:r><w:t>Generated contents</w:t></w:r></w:p>
            <w:tbl><w:tr><w:trPr><w:tblHeader/></w:trPr>
            <w:tc><w:p><w:r><w:t>Metric</w:t></w:r></w:p></w:tc>
            <w:tc><w:p><w:r><w:t>Result</w:t></w:r></w:p></w:tc></w:tr>
            <w:tr><w:tc><w:p><w:r><w:t>Accuracy</w:t></w:r></w:p></w:tc>
            <w:tc><w:p><w:r><w:t>92%</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
            </w:body></w:document>""",
        )
    text = "\n".join(s["text"] for s in extract_document(stream.getvalue(), ".docx"))
    assert "| Accuracy | 92% |" in text
    assert "| Metric | Result |" in text
    assert "Keep me" in text and "Generated contents" not in text and "Deleted text" not in text


@pytest.mark.parametrize("question", ["Tell me more", "Any room for improvement?", "展开说说"])
def test_open_followups_need_context(question):
    assert vague_query(question)
    assert not vague_query("List Kai Jian's published projects")


def test_pdf_table_alignment_requires_same_plain_text():
    layout = "Metric       Result\nAccuracy     92%\nLatency      42 ms"
    text, count = pdf_layout_tables(
        "Lead.\nMetric Result\nAccuracy 92%\nLatency 42 ms\nTail.", layout
    )
    assert count == 1 and "| Accuracy | 92% |" in text and "| Latency | 42 ms |" in text
    assert pdf_layout_tables("Unrelated prose", layout) == ("Unrelated prose", 0)
    notes = "237     Part A.\n238     Part B.\n239     Part C."
    assert pdf_layout_tables(notes, notes) == (notes, 0)


@pytest.mark.anyio
@pytest.mark.parametrize("ranking", [[1, 0], [1, 1], [1, 2], None])
async def test_reranking_reports_openai_usage_and_falls_back_to_rrf(monkeypatch, ranking):
    monkeypatch.setattr("app.rerank.rpc", AsyncMock(return_value=True))
    monkeypatch.setenv("RAG_RERANK_ENABLED", "true")
    monkeypatch.setenv("OPENAI_CHAT_MODEL", "gpt-4.1-mini")
    chunks = [{"id": "a", "excerpt": "one"}, {"id": "b", "excerpt": "correct"}]

    async def create(**kwargs):
        assert not kwargs["store"]
        assert kwargs["model"] == "gpt-4.1-mini"
        assert "correct" in kwargs["input"]
        if ranking is None:
            raise APITimeoutError(httpx.Request("POST", "https://api.openai.com/v1/responses"))
        return SimpleNamespace(
            output_text=json.dumps({"order": ranking}),
            usage=SimpleNamespace(input_tokens=200, output_tokens=20),
        )

    ledger = UsageLedger(SimpleNamespace(responses=SimpleNamespace(create=create)))
    ordered, trace = await rerank_candidates(None, ledger, "question", chunks, 1)
    assert trace["model"] == "gpt-4.1-mini"
    assert trace["before"] == ["a", "b"]
    assert ordered[0]["id"] == ("b" if ranking == [1, 0] else "a")
    if ranking is not None:
        assert ledger.calls[0]["stage"] == "rerank"
        assert ledger.calls[0]["input_tokens"] == 200
        assert ledger.cost > 0
    if ranking == [1, 0]:
        assert trace["after"][0] == {"id": "b", "kept": True}
    else:
        assert "RRF used" in trace["status"]


@pytest.mark.anyio
async def test_implicit_rewrite_is_bounded_to_remembered_project_choices():
    generate = AsyncMock(return_value={"project_id": "outside", "query": "Invented"})
    ledger = SimpleNamespace(generate=generate)
    choices = [{"id": "a", "title": "AI Portfolio"}, {"id": "b", "title": "QA AI Pilot"}]
    question = "Which one has better evidence?"
    assert await resolve_vague_query(ledger, question, choices, {}) == (question, [])
    generate.return_value = {"project_id": "b", "query": "How was QA AI Pilot evaluated?"}
    assert await resolve_vague_query(ledger, question, choices, {}) == (
        "How was QA AI Pilot evaluated?",
        ["b"],
    )


def test_reranker_preserves_candidate_identity_and_rejects_bad_indexes():
    assert validate_ranking([1, 0], 2) == [1, 0]
    with pytest.raises(ValueError):
        validate_ranking([1, 1], 2)
