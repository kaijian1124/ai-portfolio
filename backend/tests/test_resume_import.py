import json
from types import SimpleNamespace as NS
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from app import resume_import as module
from app.auth import bearer, require_admin
from app.main import create_app


@pytest.fixture
def anyio_backend():
    return "asyncio"


def test_candidates_reject_unsupported_claims_and_force_drafts():
    text = "Built a Python inventory project for tracking stock."
    raw = {
        "items": [
            {
                "resource": "skills",
                "fields_json": json.dumps({"name": "Python", "status": "published"}),
                "evidence_quote": "Python inventory project",
            },
            {
                "resource": "skills",
                "fields_json": '{"name":"Invented"}',
                "evidence_quote": "This evidence is not in the resume.",
            },
        ]
    }
    items = module.validate_candidates(raw, text)
    assert len(items) == 1 and items[0]["data"]["status"] == "draft"
    assert "id" in items[0] and "id" not in items[0]["data"]


def test_candidates_cannot_target_profile_or_existing_ids():
    raw = {
        "items": [
            {
                "resource": "projects",
                "fields_json": '{"id":"existing","title":"TEST","slug":"test"}',
                "evidence_quote": "A verified TEST project",
            }
        ]
    }
    assert module.validate_candidates(raw, "A verified TEST project") == []


@pytest.mark.anyio
async def test_analyze_uses_current_file_and_settles_budget(monkeypatch):
    calls = []
    identifier = str(uuid4())
    request_id = str(uuid4())

    async def rpc(client, name, args=None, *extra, **kwargs):
        calls.append((name, args))
        if name == "admin_resume_import_begin":
            return {"claimed": True, "import": {"id": request_id, "status": "processing"}}
        if name == "admin_file_info":
            return {"bucket": "portfolio-resumes", "path": "test/test.pdf"}
        if name == "resume_import_finish":
            return {"id": request_id, "status": "completed", "candidates": args["p_candidates"]}

    monkeypatch.setattr(module, "rpc", rpc)
    monkeypatch.setattr(
        module, "extract_document", lambda *a: [{"text": "Verified Python project evidence."}]
    )
    monkeypatch.setattr(module, "download_resume", AsyncMock(return_value=b"PDF"))
    ai = NS(
        responses=NS(
            create=AsyncMock(
                return_value=NS(
                    output_text=json.dumps(
                        {
                            "items": [
                                {
                                    "resource": "skills",
                                    "fields_json": '{"name":"Python"}',
                                    "evidence_quote": "Verified Python project",
                                }
                            ]
                        }
                    ),
                    usage=NS(input_tokens=20, output_tokens=10),
                )
            )
        )
    )
    result = await module.analyze_resume(None, ai, identifier, request_id, "jwt", 1)
    assert result["status"] == "completed" and len(result["candidates"]) == 1
    assert calls[-1][0] == "resume_import_finish" and calls[-1][1]["p_error"] is None


@pytest.mark.anyio
async def test_retry_does_not_repeat_paid_extraction(monkeypatch):
    monkeypatch.setattr(
        module,
        "rpc",
        AsyncMock(
            return_value={"claimed": False, "import": {"status": "completed", "candidates": []}}
        ),
    )
    ai = NS(responses=NS(create=AsyncMock()))
    assert (await module.analyze_resume(None, ai, str(uuid4()), str(uuid4()), "jwt", 1))[
        "status"
    ] == "completed"
    ai.responses.create.assert_not_awaited()


def test_routes_require_admin_before_extracting():
    client = TestClient(create_app())
    assert (
        client.post(
            "/api/v1/admin/resumes/" + str(uuid4()) + "/imports", json={"request_id": str(uuid4())}
        ).status_code
        == 401
    )


def test_apply_validates_selection_and_never_accepts_field_payloads(monkeypatch):
    app = create_app()
    app.dependency_overrides[require_admin] = lambda: NS()
    app.dependency_overrides[bearer] = lambda: NS(credentials="jwt")
    monkeypatch.setattr(
        module, "rpc", AsyncMock(return_value={"status": "applied", "created": [], "skipped": 0})
    )
    client = TestClient(app)
    base = "/api/v1/admin/resumes/" + str(uuid4()) + "/imports/" + str(uuid4()) + "/apply"
    assert client.post(base, json={"candidate_ids": [str(uuid4())]}).status_code == 200
    assert (
        client.post(base, json={"candidate_ids": [], "data": {"status": "published"}}).status_code
        == 422
    )


@pytest.mark.anyio
async def test_failed_extraction_is_settled_and_does_not_save_candidates(monkeypatch):
    calls = []

    async def rpc(client, name, args=None, *extra, **kwargs):
        calls.append((name, args))
        if name == "admin_resume_import_begin":
            return {"claimed": True, "import": {}}
        if name == "admin_file_info":
            return {"bucket": "portfolio-resumes", "path": "test/test.pdf"}
        return {"status": "failed", "error": args["p_error"]}

    monkeypatch.setattr(module, "rpc", rpc)
    monkeypatch.setattr(module, "download_resume", AsyncMock(side_effect=ValueError("invalid_pdf")))
    result = await module.analyze_resume(None, None, str(uuid4()), str(uuid4()), "jwt", 1)
    assert result["status"] == "failed" and calls[-1][1]["p_candidates"] == []


@pytest.mark.anyio
async def test_download_rejects_non_resume_and_reads_bounded_storage(monkeypatch):
    import httpx

    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setenv("SUPABASE_SECRET_KEY", "sb_secret_fixture")
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(lambda request: httpx.Response(200, content=b"PDF"))
    ) as client:
        assert (
            await module.download_resume(
                client,
                {"bucket": "portfolio-resumes", "path": str(uuid4()) + "/" + str(uuid4()) + ".pdf"},
            )
            == b"PDF"
        )
        with pytest.raises(ValueError):
            await module.download_resume(client, {"bucket": "other", "path": "../private"})


def test_analysis_configuration_fails_closed(monkeypatch):
    app = create_app()
    app.dependency_overrides[require_admin] = lambda: NS()
    app.dependency_overrides[bearer] = lambda: NS(credentials="jwt")
    client = TestClient(app)
    path = "/api/v1/admin/resumes/" + str(uuid4()) + "/imports"
    payload = {"request_id": str(uuid4())}
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    assert client.post(path, json=payload).status_code == 503
    monkeypatch.setenv("OPENAI_API_KEY", "fixture")
    monkeypatch.setenv("SUPABASE_SECRET_KEY", "sb_secret_fixture")
    monkeypatch.setenv("CHAT_DAILY_BUDGET_USD", "nan")
    assert client.post(path, json=payload).status_code == 503
