from io import BytesIO
from types import SimpleNamespace as NS
from unittest.mock import AsyncMock
from uuid import uuid4

import httpx
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from PIL import Image

from app import chat, content, files, worker
from app.auth import bearer, get_auth_client, require_admin
from app.main import create_app


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
def client(monkeypatch):
    for key, value in {
        "SUPABASE_URL": "https://example.supabase.co",
        "SUPABASE_SECRET_KEY": "sb_secret_fixture",
        "CHAT_SESSION_SECRET": "s" * 40,
        "CHAT_PROXY_SECRET": "p" * 40,
        "OPENAI_API_KEY": "test-only",
        "CHAT_DAILY_BUDGET_USD": "1",
    }.items():
        monkeypatch.setenv(key, value)
    app = create_app()
    app.dependency_overrides[require_admin] = lambda: NS(user_id=str(uuid4()))
    app.dependency_overrides[bearer] = lambda: NS(credentials="test-token")
    return TestClient(app)


def body(**updates):
    return {
        "data": {"name": "TEST"},
        "expected_revision": None,
        "request_id": str(uuid4()),
        **updates,
    }


def test_admin_log_page_forwards_valid_pagination(client, monkeypatch):
    rpc = AsyncMock(return_value={"rows": [], "has_next": False})
    monkeypatch.setattr(content, "rpc", rpc)
    path = "/api/v1/admin/logs/requests"
    assert client.get(path + "?page=2&size=20&status=failed").json() == {
        "rows": [],
        "has_next": False,
    }
    assert rpc.await_args.args[1:] == (
        "admin_log_page",
        {"p_feed": "requests", "p_page": 2, "p_size": 20, "p_filter": "failed"},
        "test-token",
    )
    assert client.get(path + "?size=30").status_code == 422
    assert client.get(path + "?action=delete").status_code == 422
    assert client.get(path + "?status=pending").status_code == 422
    assert client.get(path + "?page=0").status_code == 422
    assert client.get("/api/v1/admin/logs/other").status_code == 422
    assert TestClient(create_app()).get(path).status_code == 401


def test_catalog_routes_and_validation(client, monkeypatch):
    calls = []

    async def rpc(c, name, args=None, *extra, **kwargs):
        calls.append((name, args))
        return {} if name in ("admin_reindex_document", "admin_monitoring") else []

    monkeypatch.setattr(content, "rpc", rpc)
    monkeypatch.setattr(files, "dispatch_worker", AsyncMock(return_value=False))
    identifier = str(uuid4())
    for path in [
        "/catalog/skills",
        "/catalog/skills/" + identifier,
        "/activity",
        "/monitoring",
        "/documents/" + identifier + "/versions",
    ]:
        assert client.get("/api/v1/admin" + path).status_code == 200
    assert client.post("/api/v1/admin/catalog/skills", json=body()).status_code == 200
    assert (
        client.post(
            "/api/v1/admin/catalog/skills", json=body(data={"name": "TEST", "bad": True})
        ).status_code
        == 422
    )
    assert (
        client.post(
            "/api/v1/admin/catalog/skills", json=body(data={}, operation="activate")
        ).status_code
        == 422
    )
    assert (
        client.post(
            "/api/v1/admin/catalog/resumes?record_id=" + identifier,
            json=body(data={}, operation="activate", expected_revision=1),
        ).status_code
        == 200
    )
    assert (
        client.post(
            "/api/v1/admin/documents/" + identifier + "/reindex", json={"request_id": str(uuid4())}
        ).status_code
        == 200
    )
    assert (
        client.post("/api/v1/admin/documents/" + identifier + "/reindex", json={}).status_code
        == 422
    )
    assert calls[0][0] == "admin_catalog_list"


@pytest.mark.parametrize("outcome", ["success", "duplicate", "rejected", "uncertain", "storage"])
def test_upload_registration_and_safe_cleanup(client, monkeypatch, outcome):
    calls = []

    def handler(request):
        calls.append(request.method)
        return httpx.Response(
            500 if outcome == "storage" and request.method == "POST" else 200, json={}
        )

    async def dependency():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as session:
            yield session

    client.app.dependency_overrides[get_auth_client] = dependency

    async def rpc(*args, **kwargs):
        if outcome in ("rejected", "uncertain"):
            raise HTTPException(422 if outcome == "rejected" else 503, "test")
        return {"duplicate": outcome == "duplicate", "record": {"id": str(uuid4())}}

    monkeypatch.setattr(files, "rpc", rpc)
    data = BytesIO()
    Image.new("RGB", (2, 2)).save(data, format="PNG")
    response = client.post(
        "/api/v1/admin/uploads",
        headers={"Authorization": "Bearer fixture"},
        data={"kind": "image", "title": "TEST"},
        files={"file": ("test.png", data.getvalue(), "image/png")},
    )
    assert response.status_code == (
        422 if outcome == "rejected" else 503 if outcome in ("uncertain", "storage") else 200
    )
    assert ("DELETE" in calls) == (outcome in ("duplicate", "rejected"))


@pytest.mark.parametrize("mode", ["success", "failure", "missing", "quota", "withdrawn"])
def test_chat_stream_and_fail_closed(client, monkeypatch, mode):
    calls = []

    async def rpc(c, name, args=None, **kwargs):
        calls.append((name, args))
        if mode == "quota" and name == "chat_admit":
            raise HTTPException(429, "limit")
        return str(uuid4())

    async def answer(*args):
        if mode == "failure":
            raise RuntimeError("private provider error")
        return {
            "answer": "Verified TEST",
            "sources": [],
            "prompt_tokens": 10,
            "output_tokens": 5,
            "embedding_tokens": 0,
            "cost_usd": 0.001,
            "dependencies": [{"id": "revoked", "kind": "document"}] if mode == "withdrawn" else [],
        }

    class FakeAI:
        def __init__(self, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            pass

    monkeypatch.setattr(chat, "rpc", rpc)
    monkeypatch.setattr(chat, "answer_question", answer)
    current = AsyncMock(return_value=False)
    monkeypatch.setattr(chat, "sources_current", current)
    monkeypatch.setattr(chat, "AsyncOpenAI", FakeAI)
    if mode == "missing":
        monkeypatch.delenv("OPENAI_API_KEY")
    response = client.post(
        "/api/v1/chat", headers={"x-portfolio-proxy": "p" * 40}, json={"question": "TEST question"}
    )
    assert response.status_code == (503 if mode == "missing" else 429 if mode == "quota" else 200)
    if mode == "success":
        assert "event: answer" in response.text and "event: done" in response.text
        trace = next(a for n, a in calls if n == "rag_record_trace")
        assert trace["p_question"] == "TEST question"
        assert "searches" not in response.text
        assert "HttpOnly" in response.headers["set-cookie"]
        assert next(a for n, a in calls if n == "chat_finish")["p_cost"] == 0.001
    if mode == "failure":
        assert "event: error" in response.text and "private provider error" not in response.text
        assert (
            next(a for n, a in calls if n == "chat_finish")["p_error"]
            == "generation_failed_or_cancelled"
        )
    if mode == "withdrawn":
        current.assert_awaited_once()
        assert "event: answer" in response.text and "Verified TEST" not in response.text
        assert next(a for n, a in calls if n == "chat_finish")["p_sources"] == []


def test_feedback_source_and_proxy_protection(client, monkeypatch):
    monkeypatch.setattr(chat, "rpc", AsyncMock(return_value=True))
    assert client.post("/api/v1/chat", json={"question": "TEST"}).status_code == 403
    session = str(uuid4())
    client.cookies.set(chat.COOKIE, chat.session_value(session))
    headers = {"x-portfolio-proxy": "p" * 40}
    assert (
        client.post(
            "/api/v1/chat/feedback", headers=headers, json={"message_id": str(uuid4()), "vote": 1}
        ).status_code
        == 200
    )
    assert (
        client.post(
            "/api/v1/chat/feedback", headers=headers, json={"message_id": str(uuid4()), "vote": 0}
        ).status_code
        == 403
    )
    monkeypatch.setattr(chat, "rpc", AsyncMock(return_value=None))
    assert client.get("/api/v1/sources/" + str(uuid4())).status_code == 404
    assert (
        client.post(
            "/api/v1/chat/feedback", headers=headers, json={"message_id": str(uuid4()), "vote": -1}
        ).status_code
        == 404
    )
    assert client.post("/api/v1/chat", content="x" * 9000).status_code == 413
    assert client.post("/api/v1/admin/uploads", data={}).status_code == 401


@pytest.mark.anyio
async def test_retention_runs_without_ai_key(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    rpc = AsyncMock(return_value=None)
    monkeypatch.setattr(worker, "rpc", rpc)
    await worker.run()
    assert [call.args[1] for call in rpc.await_args_list] == [
        "worker_retention_cleanup",
        "worker_claim_preview_job",
    ]
