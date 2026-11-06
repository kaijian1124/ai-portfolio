import pytest

from app.chat_engine import route_query, validate_answer
from app.content import validate_content
from app.ingestion import chunk_sections, extract_document


def test_project_validation_rejects_injected_fields_and_unsafe_urls():
    with pytest.raises(ValueError):
        validate_content("projects", {"title": "TEST", "slug": "test", "role": "admin"})
    with pytest.raises(ValueError):
        validate_content(
            "projects", {"title": "TEST", "slug": "test", "github_url": "javascript:alert(1)"}
        )


def test_content_dates_and_technologies():
    with pytest.raises(ValueError):
        validate_content(
            "experiences",
            {
                "company": "TEST",
                "job_title": "TEST",
                "started_on": "2025-01-01",
                "ended_on": "2024-01-01",
            },
        )
    assert validate_content(
        "projects", {"title": "TEST", "slug": "test", "technologies": ["Python"]}
    )["technologies"] == ["Python"]


def test_chunks_preserve_source_location_and_have_bounds():
    chunks = chunk_sections([{"text": "TEST text. " * 1000, "page": 2, "heading": "Methods"}])
    assert len(chunks) > 1 and all(len(c["text"]) <= 2000 for c in chunks)
    assert all(c["page"] == 2 and c["heading"] == "Methods" for c in chunks)


def test_bad_documents_are_rejected():
    with pytest.raises(ValueError):
        extract_document(b"not pdf", ".pdf")
    with pytest.raises(ValueError):
        extract_document(b"bad", ".docx")


def test_unsupported_citations_fail_closed():
    answer = validate_answer(
        {"answer": "Unverified claim", "source_ids": ["invented"], "insufficient_evidence": False},
        ["profile:one"],
    )
    assert answer["insufficient_evidence"] and not answer["source_ids"]


def test_query_routing_does_not_use_vector_search_for_basic_skills():
    assert route_query("What programming languages does this person know?") == "structured"
    assert route_query("Explain the technical architecture and model training") == "rag"
