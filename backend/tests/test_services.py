import hashlib
import json
from io import BytesIO
from types import SimpleNamespace as NS
from unittest.mock import AsyncMock
from uuid import uuid4
from zipfile import ZipFile

import httpx
import pytest
from fastapi import HTTPException
from PIL import Image

from app import chat, db, files, worker
from app import chat_engine as engine
from app.ingestion import chunk_sections, extract_document


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
def configuration(monkeypatch):
    for key, value in {
        "SUPABASE_URL": "https://example.supabase.co",
        "SUPABASE_PUBLISHABLE_KEY": "sb_publishable_test",
        "SUPABASE_SECRET_KEY": "sb_secret_test",
        "CHAT_SESSION_SECRET": "s" * 40,
        "CHAT_PROXY_SECRET": "p" * 40,
        "INGESTION_DAILY_BUDGET_USD": "1",
        "CHAT_DAILY_BUDGET_USD": "1",
    }.items():
        monkeypatch.setenv(key, value)


def png():
    stream = BytesIO()
    Image.new("RGB", (2, 2)).save(stream, format="PNG")
    return stream.getvalue()


def docx():
    stream = BytesIO()
    with ZipFile(stream, "w") as archive:
        archive.writestr(
            "word/document.xml",
            '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Methods</w:t></w:r></w:p><w:p><w:r><w:t>Verified TEST evidence.</w:t></w:r></w:p></w:body></w:document>',
        )
    return stream.getvalue()


def test_configuration_and_sessions(monkeypatch):
    assert db.headers(service=True)["apikey"] == "sb_secret_test"
    assert db.headers("jwt")["Authorization"] == "Bearer jwt"
    session = str(uuid4())
    cookie = chat.session_value(session)
    assert chat.read_session(cookie) == session
    assert chat.read_session(cookie + "x") is None
    assert chat.read_session("bad") is None
    monkeypatch.setenv("SUPABASE_SECRET_KEY", "eyJlegacy")
    assert db.headers(service=True)["Authorization"] == "Bearer eyJlegacy"
    for bad in [
        "http://example.com",
        "https://user:pass@example.com",
        "https://example.com/path",
        "",
    ]:
        monkeypatch.setenv("SUPABASE_URL", bad)
        with pytest.raises(HTTPException):
            db.base_url()
    monkeypatch.setenv("SUPABASE_SECRET_KEY", "public")
    with pytest.raises(HTTPException):
        db.headers(service=True)
    monkeypatch.setenv("CHAT_SESSION_SECRET", "short")
    with pytest.raises(HTTPException):
        chat.secret()


@pytest.mark.anyio
@pytest.mark.parametrize(
    "status,code,expected",
    [
        (401, None, 401),
        (403, None, 403),
        (400, "P0002", 404),
        (400, "40001", 409),
        (400, "23505", 409),
        (400, "23514", 422),
        (400, "22P02", 422),
        (400, "P0001", 429),
        (500, None, 503),
    ],
)
async def test_rpc_errors_are_sanitized(status, code, expected):
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(
            lambda request: httpx.Response(status, json={"code": code, "message": "SECRET ERROR"})
        )
    ) as client:
        with pytest.raises(HTTPException) as error:
            await db.rpc(client, "test", service=True)
        assert error.value.status_code == expected and "SECRET" not in error.value.detail


@pytest.mark.anyio
async def test_rpc_payload_and_transport():
    for response, expected in [
        (httpx.Response(200, json={"ok": True}), {"ok": True}),
        (httpx.Response(204), None),
    ]:
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(lambda request, response=response: response)
        ) as client:
            assert await db.rpc(client, "test") == expected
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(lambda request: httpx.Response(200, text="bad"))
    ) as client:
        with pytest.raises(HTTPException):
            await db.rpc(client, "test")

    def fail(request):
        raise httpx.ConnectError("secret")

    async with httpx.AsyncClient(transport=httpx.MockTransport(fail)) as client:
        with pytest.raises(HTTPException):
            await db.rpc(client, "test")


def test_real_docx_and_image_validation():
    sections = extract_document(docx(), ".docx")
    assert sections[0]["heading"] == "Methods" and sections[0]["page"] is None
    assert files.validate_upload(docx(), "knowledge", "file.docx")[0] == ".docx"
    assert files.validate_upload(png(), "image", "wrong.exe") == (".png", "image/png")
    for data, kind, name in [
        (b"", "image", "a.png"),
        (b"x", "unknown", "a"),
        (b"bad", "image", "a.png"),
        (b"bad", "resume", "a.pdf"),
        (b"x", "knowledge", "a.exe"),
    ]:
        with pytest.raises(ValueError):
            files.validate_upload(data, kind, name)
    with pytest.raises(ValueError):
        extract_document(b"x", ".txt")
    with pytest.raises(ValueError):
        chunk_sections([])
    with pytest.raises(ValueError):
        chunk_sections([{"text": "a" * 900000}])


@pytest.mark.anyio
async def test_signed_urls_enforce_origin_and_path(monkeypatch):
    path = str(uuid4()) + "/" + str(uuid4()) + ".pdf"
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(
            lambda request: httpx.Response(
                200, json={"signedURL": "/storage/v1/object/sign/file?token=test"}
            )
        )
    ) as client:
        assert (await files.signed_url(client, "portfolio-resumes", path)).startswith(
            "https://example.supabase.co/"
        )
        with pytest.raises(HTTPException):
            await files.signed_url(client, "other", path)
        with pytest.raises(HTTPException):
            await files.signed_url(client, "portfolio-resumes", "../x")
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(
            lambda request: httpx.Response(200, json={"signedURL": "https://evil.test/file"})
        )
    ) as client:
        with pytest.raises(HTTPException):
            await files.signed_url(client, "portfolio-resumes", path)
    assert await files.dispatch_worker(NS()) is False
    monkeypatch.setenv("GITHUB_ACTIONS_TOKEN", "fixture")
    monkeypatch.setenv("GITHUB_REPOSITORY", "test/repo")
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(lambda request: httpx.Response(204))
    ) as client:
        assert await files.dispatch_worker(client)


@pytest.mark.anyio
@pytest.mark.parametrize("mode", ["success", "budget", "integrity", "embedding", "superseded"])
async def test_worker_activation_budget_integrity_and_failure(monkeypatch, mode):
    data = docx()
    job = {
        "id": str(uuid4()),
        "lease_token": str(uuid4()),
        "storage_path": "test/file.docx",
        "filename": "file.docx",
        "sha256": hashlib.sha256(data).hexdigest() if mode != "integrity" else "bad",
    }
    calls = []

    async def rpc(client, name, args=None, **kwargs):
        calls.append((name, args))
        if name == "worker_load_approved_preview":
            return None if mode == "integrity" else [{"ordinal": 0, "text": "Approved text."}]
        if name == "worker_reserve_budget":
            return mode != "budget"
        if name == "worker_finish_job":
            return mode != "superseded"
        return True

    monkeypatch.setattr(worker, "rpc", rpc)
    embedding = NS(
        usage=NS(total_tokens=10),
        data=[NS(index=0, embedding=[0.0] * (2 if mode == "embedding" else 1536))],
    )
    ai = NS(embeddings=NS(create=AsyncMock(return_value=embedding)))
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(lambda request: httpx.Response(200, content=data))
    ) as client:
        result = await worker.process_job(client, ai, job)
    assert result == (
        "completed"
        if mode == "success"
        else "superseded"
        if mode in ("integrity", "superseded")
        else "failed"
    )
    if mode in ("budget", "integrity"):
        ai.embeddings.create.assert_not_awaited()
    if mode == "success":
        ai.embeddings.create.assert_awaited_once()
        assert ai.embeddings.create.await_args.kwargs["input"] == ["Approved text."]
    assert calls[-1][0] == (
        "worker_load_approved_preview" if mode == "integrity" else "worker_finish_job"
    )
    if mode == "embedding":
        assert any(n == "worker_settle_budget" and a.get("p_failed") for n, a in calls)


@pytest.mark.anyio
async def test_prepare_preview_verifies_original_and_saves_chunks_without_ai(monkeypatch):
    data = docx()
    job = {
        "id": str(uuid4()),
        "lease_token": str(uuid4()),
        "storage_path": "test/file.docx",
        "filename": "file.docx",
        "sha256": hashlib.sha256(data).hexdigest(),
    }
    calls = AsyncMock(return_value=True)
    monkeypatch.setattr(worker, "rpc", calls)
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(lambda request: httpx.Response(200, content=data))
    ) as client:
        assert await worker.prepare_preview(client, job) == "awaiting_review"
        calls.assert_awaited_once()
        assert calls.await_args.args[1] == "worker_save_preview"
        assert calls.await_args.args[2]["p_chunks"][0]["text"]
        calls.reset_mock()
        assert await worker.prepare_preview(client, {**job, "sha256": "invalid"}) == "failed"
        assert calls.await_args.args[1] == "worker_finish_job"
        assert calls.await_args.args[2]["p_error"] == "file_integrity_failed"


@pytest.mark.anyio
@pytest.mark.parametrize("kind", ["structured", "rag", "empty", "invalid", "chinese"])
async def test_grounded_answers_and_citation_validation(monkeypatch, kind):
    sid = "profile:" + str(uuid4())
    cid = str(uuid4())

    async def rpc(client, name, args=None, **kwargs):
        if name == "portfolio_context":
            return (
                {}
                if kind == "empty"
                else {
                    "profile": {
                        "id": sid.split(":")[1],
                        "display_name": "TEST ONLY",
                        "status": "published",
                    },
                    "skills": [],
                }
            )
        if name == "rag_history":
            return [{"role": "user", "content": "TEST project architecture"}]
        if name == "hybrid_knowledge":
            return [
                {
                    "id": cid,
                    "title": "TEST document",
                    "excerpt": "Verified methods",
                    "version_id": str(uuid4()),
                    "page": 2,
                }
            ]

    monkeypatch.setattr(engine, "rpc", rpc)
    answer = {
        "answer": "Verified test answer",
        "source_ids": [cid if kind == "rag" else sid],
        "insufficient_evidence": False,
    }
    if kind in ("invalid", "chinese"):
        answer["source_ids"] = ["invented"]
    ai = NS(
        embeddings=NS(
            create=AsyncMock(
                return_value=NS(usage=NS(total_tokens=5), data=[NS(embedding=[0] * 1536)])
            )
        ),
        responses=NS(
            create=AsyncMock(
                return_value=NS(
                    output_text=json.dumps(answer), usage=NS(input_tokens=20, output_tokens=10)
                )
            )
        ),
    )
    question = (
        "How was the portfolio architecture implemented?"
        if kind == "rag"
        else "技能是什么"
        if kind == "chinese"
        else "What skills?"
    )
    result = await engine.answer_question(None, ai, question, str(uuid4()))
    assert result["cost_usd"] >= 0
    if kind in ("empty", "invalid", "chinese"):
        assert result["sources"] == []
    else:
        assert result["sources"] and result["answer"] == "Verified test answer"
    if kind == "chinese":
        assert "已核实" in result["answer"]
    if kind != "rag":
        ai.embeddings.create.assert_not_awaited()


def test_prices_fail_closed(monkeypatch):
    monkeypatch.setenv("OPENAI_CHAT_MODEL", "other")
    with pytest.raises(ValueError):
        engine.price_configuration()
    monkeypatch.setenv("OPENAI_CHAT_MODEL", "gpt-4.1-mini")
    monkeypatch.setenv("LLM_INPUT_USD_PER_MILLION", "nan")
    with pytest.raises(ValueError):
        engine.price_configuration()
    assert engine.validate_answer({}, [])["insufficient_evidence"]
    assert engine.validate_answer(
        {"answer": "x", "source_ids": [], "insufficient_evidence": True}, []
    )["insufficient_evidence"]
