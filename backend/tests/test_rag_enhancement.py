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


def test_persisted_state_resolves_references_without_recent_history():
    context = {
        "projects": [
            {"id": "portfolio", "title": "AI Portfolio"},
            {"id": "pilot", "title": "QA AI Pilot"},
        ]
    }
    memory = {"active_project": "portfolio", "presented_projects": ["pilot", "portfolio"]}
    assert chat_engine.resolve_question("how does it work?", context, [], memory=memory)[1] == [
        "portfolio"
    ]
    assert chat_engine.resolve_question("the second project?", context, [], memory=memory)[1] == [
        "portfolio"
    ]
    assert (
        chat_engine.resolve_question("the second project?", {"projects": []}, [], memory=memory)[1]
        == []
    )


def test_here_follows_explicit_portfolio_topic_even_if_previous_citations_drifted():
    context = {
        "projects": [
            {"id": "portfolio", "title": "AI Portfolio"},
            {"id": "assignment", "title": "LLM Assignment 2"},
        ]
    }
    history = [
        {"role": "user", "content": "How does Kai Jian evaluate his AI Portfolio chatbot?"},
        {"role": "assistant", "project_ids": ["projects:assignment"]},
    ]
    assert chat_engine.resolve_question("how does he design his rag here?", context, history)[
        1
    ] == ["portfolio"]


def test_project_order_follows_the_previous_ordered_request_not_citation_rank():
    context = {
        "projects": [
            {"id": "a", "title": "TalentBank"},
            {"id": "b", "title": "QA AI Pilot"},
        ]
    }
    history = [
        {"role": "user", "content": "按顺序介绍 TalentBank 和 QA AI Pilot。"},
        {"role": "assistant", "project_ids": ["projects:b", "projects:a"]},
    ]
    assert chat_engine.resolve_question("第二个项目怎么评估？", context, history)[1] == ["b"]


@pytest.mark.anyio
async def test_ordinal_in_new_conversation_clarifies_without_retrieving(monkeypatch):
    monkeypatch.setattr(chat_engine, "rpc", AsyncMock(return_value=[]))
    retrieve = AsyncMock(return_value=[])
    monkeypatch.setattr(chat_engine, "retrieve", retrieve)
    result = await chat_engine.answer_question(None, None, "第二个项目怎么评估？", "new-session")
    assert result["answer"] == "你指的是哪个已发布的项目？"
    retrieve.assert_not_called()


@pytest.mark.anyio
async def test_portfolio_uses_its_approved_heading_and_english_question(monkeypatch):
    portfolio = {"id": "portfolio", "title": "AI Portfolio", "slug": "ai-portfolio"}
    assignment = {"id": "assignment", "title": "Retrieval Based LLM Assistant"}
    heading = "AI Portfolio · Online Resume"
    eval_chunk = {
        "id": "evaluation",
        "title": "AI Portfolio",
        "heading": heading + " / 评估与改进",
        "version_id": "v",
        "excerpt": "用固定题集测试召回与引用。",
    }

    async def rpc(_client, name, args=None, **_kwargs):
        if name == "portfolio_context":
            return {"projects": [portfolio, assignment]}
        if name == "rag_topics":
            return [heading, "PDF 问答 RAG · LLM Assignment 2"]
        if name == "hybrid_knowledge" and args.get("p_heading") == heading:
            return [eval_chunk]
        return []

    async def generate(_self, stage, instructions, data, _schema, _limit):
        assert data["user_question"] == "How did you evaluate the AI Portfolio RAG?"
        assert "English" in data.get("answer_language", "")
        assert [s["id"] for s in data["current_sources"]] == [
            "projects:portfolio",
            "evaluation",
        ]
        if stage == "answer":
            return {
                "answer": "使用固定题集和引用。",
                "source_ids": ["evaluation"],
                "insufficient_evidence": False,
            }
        return {
            "answer": "I used a fixed set of questions to check recall and citations.",
            "source_ids": ["evaluation"],
            "insufficient_evidence": False,
        }

    monkeypatch.setattr(chat_engine, "rpc", rpc)
    monkeypatch.setattr(chat_engine.UsageLedger, "embed", AsyncMock(return_value=[]))
    monkeypatch.setattr(chat_engine.UsageLedger, "generate", generate)
    result = await chat_engine.answer_question(
        None, None, "How did you evaluate the AI Portfolio RAG?", "s"
    )
    assert result["answer"].startswith("I used")
    assert [s["id"] for s in result["sources"]] == ["evaluation"]


def test_pdf_margins_remove_repeated_running_title_and_number_but_not_body(monkeypatch):
    pages = [
        SimpleNamespace(
            extract_text=lambda: (
                "3\nReport • January\nBody with evidence.\n1        Source footnote."
            )
        ),
        SimpleNamespace(extract_text=lambda: "Report • January\n4\nSecond body."),
        SimpleNamespace(
            extract_text=lambda: "5\nReport • January\nThird body.\n8        Distinct note."
        ),
    ]
    monkeypatch.setattr(
        "app.ingestion.PdfReader", lambda *a, **kw: SimpleNamespace(pages=pages, is_encrypted=False)
    )
    sections = extract_document(b"%PDF-sample", ".pdf")
    assert [(s["page"], s["text"]) for s in sections] == [
        (1, "Body with evidence."),
        (1, "1        Source footnote."),
        (2, "Second body."),
        (3, "Third body."),
        (3, "8        Distinct note."),
    ]


@pytest.mark.parametrize(
    "question, expected_project, expected_heading, language",
    [
        ("How was the FYP evaluated?", "stock", "股票短期趋势预测 · FYP", "English"),
        ("Bagaimana AI Portfolio dinilai?", "portfolio", "AI Portfolio · Online Resume", "Malay"),
        ("AI Portfolio是怎样评估的？", "portfolio", "AI Portfolio · Online Resume", "Chinese"),
        (
            "How does the LLM Assignment 2 RAG work?",
            "llm",
            "PDF 问答 RAG · LLM Assignment 2",
            "English",
        ),
    ],
)
def test_explicit_project_aliases_preserve_scope_and_question_language(
    question, expected_project, expected_heading, language
):
    projects = [
        {"id": "stock", "title": "Stock Short-Term Trend Forecasting Using Sentiment Analysis"},
        {"id": "portfolio", "title": "AI Portfolio"},
        {"id": "llm", "title": "Retrieval-Based LLM Assistant"},
    ]
    catalog, headings = chat_engine.topic_catalog(projects, [expected_heading])
    assert find_projects(question, catalog) == [expected_project]
    assert headings[expected_project] == ["heading:" + expected_heading]
    assert chat_engine.question_language(question) == language


def test_sentence_boundaries_do_not_split_initialisms_inside_a_sentence():
    from app.ingestion import section_boundaries

    text = "An earlier sentence. This report cites U.S. regulatory agencies. Next sentence."
    boundaries, _ = section_boundaries(text)
    assert text.index("regulatory") not in boundaries
    assert text.index("Next") in boundaries
