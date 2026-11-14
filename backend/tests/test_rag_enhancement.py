import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from app import chat_engine
from app.chat_engine import find_projects, generation_cost
from app.ingestion import chunk_sections, extract_document


def test_markdown_preserves_heading_path_and_literal_code():
    sections = extract_document(
        b"---\nvisibility: public\n---\n# QA Pilot\n## Validation\n"
        b"Evidence.\n\n```md\n# Literal\n```\n",
        ".md",
    )
    assert sections == [
        {
            "text": "Evidence.\n\n```md\n# Literal\n```",
            "page": None,
            "heading": "QA Pilot / Validation",
        }
    ]


def test_short_complete_paragraphs_are_not_cut_to_fill_a_window():
    sections = [{"text": "A complete rule.\n\nAn independent exception.", "heading": "Rules"}]
    chunks = chunk_sections(sections)
    assert chunks[0]["text"] == sections[0]["text"]
    assert chunks[0]["heading"] == "Rules"


def test_project_resolution_accepts_names_slugs_and_only_published_context():
    context = {
        "projects": [
            {"id": "a", "title": "TalentBank", "slug": "talent-bank"},
            {"id": "b", "title": "QA AI Pilot", "slug": "qa-ai-pilot"},
        ]
    }
    assert find_projects("对比 QA AI Pilot 和 talent-bank", context) == ["b", "a"]
    assert find_projects("unknown project", context) == []


def test_cached_input_is_a_subset_of_prompt_tokens():
    usage = SimpleNamespace(
        input_tokens=2000,
        output_tokens=500,
        input_tokens_details=SimpleNamespace(cached_tokens=1000),
    )
    assert generation_cost(usage, 0.40, 0.10, 1.60) == pytest.approx(0.0013)


@pytest.mark.anyio
@pytest.mark.parametrize("supported", [True, False])
async def test_agent_searches_both_projects_then_one_gap(monkeypatch, supported):
    monkeypatch.setenv("RAG_AGENT_ENABLED", "true")
    projects = [
        {"id": "a", "title": "TalentBank", "slug": "talentbank"},
        {"id": "b", "title": "QA AI Pilot", "slug": "qa-ai-pilot"},
    ]
    scopes = []

    async def rpc(_client, name, args=None, **_kwargs):
        if name == "portfolio_context":
            return {"projects": projects}
        if name == "rag_history":
            return [{"role": "assistant", "content": "Revoked private details."}]
        if name == "hybrid_knowledge":
            scope = args["p_project_id"]
            scopes.append(scope)
            assert args["p_trace"]
            return {
                "vector": [{"id": scope, "rank": 1}],
                "keyword": [],
                "fused": [
                    {"id": scope, "title": scope, "excerpt": "Verified work.", "version_id": "v"}
                ],
            }
        return []

    def response(value):
        return SimpleNamespace(
            output_text=json.dumps(value), usage=SimpleNamespace(input_tokens=50, output_tokens=15)
        )

    create = AsyncMock(
        side_effect=[
            response({"query": "QA AI Pilot test coverage", "project_id": "b"}),
            response(
                {
                    "answer": "Verified comparison.",
                    "source_ids": ["a", "b"],
                    "insufficient_evidence": False,
                }
            ),
            response({"supported": supported}),
        ]
    )
    ai = SimpleNamespace(
        responses=SimpleNamespace(create=create),
        embeddings=SimpleNamespace(
            create=AsyncMock(
                return_value=SimpleNamespace(
                    usage=SimpleNamespace(total_tokens=15),
                    data=[SimpleNamespace(embedding=[0.0] * 1536)],
                )
            )
        ),
    )
    monkeypatch.setattr(chat_engine, "rpc", rpc)
    trace = {"searches": []}
    answer = await chat_engine.answer_question(
        None, ai, "Compare TalentBank and QA AI Pilot", "session", trace=trace
    )
    assert scopes == ["a", "b", "b"]
    assert answer["candidate_ids"] == ["a", "b"]
    assert [step["vector"][0]["id"] for step in trace["searches"]] == scopes
    assert [source["id"] for source in trace["context"]] == ["projects:a", "projects:b", "a", "b"]
    assert answer["embedding_tokens"] == 30
    assert len(answer["usage_breakdown"]) == 5
    assert all(
        "Revoked private details" not in call.kwargs["input"] for call in create.await_args_list
    )
    assert [source["id"] for source in answer["sources"]] == (["a", "b"] if supported else [])


@pytest.mark.anyio
async def test_revoked_dependency_blocks_answer_even_when_not_cited(monkeypatch):
    rpc = AsyncMock(return_value=False)
    monkeypatch.setattr(chat_engine, "rpc", rpc)
    assert not await chat_engine.sources_current(None, [{"kind": "document", "id": "withdrawn"}])
    rpc.assert_awaited_once_with(None, "knowledge_current", {"p_ids": ["withdrawn"]}, service=True)


def test_project_ordinal_does_not_shift_after_revocation():
    context = {"projects": [{"id": "b", "title": "QA AI Pilot"}]}
    history = [{"role": "assistant", "project_ids": ["projects:a", "projects:b"]}]
    assert chat_engine.resolve_question("first project", context, history) == ("first project", [])
    assert chat_engine.resolve_question("second project", context, history)[1] == ["b"]
