from app.evaluation import score_case, summarize


def test_evaluation_scores_expected_sources_and_refusal():
    row = score_case(
        {
            "required_terms": ["Python"],
            "expected_source_ids": ["skills:test"],
            "expect_refusal": False,
        },
        {"text": "Python is listed.", "sources": [{"id": "skills:test"}]},
    )
    assert (
        row["source_recall"] == 1 and row["required_term_coverage"] == 1 and row["refusal_correct"]
    )
    refusal = score_case(
        {"expect_refusal": True},
        {"text": "I don't have enough verified information.", "sources": []},
    )
    assert refusal["refusal_correct"]
    report = summarize([{**row, "latency_ms": 20}, {**refusal, "latency_ms": 40}])
    assert (
        report["cases"] == 2 and report["source_recall"] == 1 and report["average_latency_ms"] == 30
    )


import json
from unittest.mock import AsyncMock

import httpx
import pytest

from app import evaluation


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.mark.anyio
async def test_generate_review_and_run_evaluation(tmp_path, monkeypatch):
    identifier = "11111111-1111-4111-8111-111111111111"
    rpc = AsyncMock(
        return_value={
            "profile": {"id": identifier, "display_name": "TEST"},
            "skills": [],
            "projects": [],
        }
    )
    monkeypatch.setattr(evaluation, "rpc", rpc)
    dataset = tmp_path / "cases.jsonl"
    await evaluation.generate(dataset)
    cases = [json.loads(line) for line in dataset.read_text(encoding="utf-8").splitlines()]
    assert all(not c["reviewed"] for c in cases)
    with pytest.raises(ValueError):
        await evaluation.evaluate(dataset, tmp_path / "report.json", False)
    with pytest.raises(ValueError):
        await evaluation.evaluate(dataset, tmp_path / "report.json", True)
    case = {**cases[0], "reviewed": True}
    dataset.write_text(json.dumps(case) + "\n", encoding="utf-8")
    monkeypatch.setenv("CHAT_PROXY_SECRET", "fixture")
    monkeypatch.setenv("EVALUATION_API_BASE_URL", "http://localhost:8000")
    original = httpx.AsyncClient

    def handler(request):
        return httpx.Response(
            200,
            text="event: answer\ndata: "
            + json.dumps({"text": "TEST", "sources": [{"id": "profile:" + identifier}]})
            + "\n\n",
        )

    monkeypatch.setattr(
        evaluation.httpx,
        "AsyncClient",
        lambda **kwargs: original(transport=httpx.MockTransport(handler), **kwargs),
    )
    await evaluation.evaluate(dataset, tmp_path / "report.json", True)
    assert json.loads((tmp_path / "report.json").read_text())["metrics"]["source_recall"] == 1
    assert rpc.await_args.args[1] == "evaluation_save_report"
