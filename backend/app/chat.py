"""Anonymous-session chat with persistent quota reservations and validated SSE delivery."""

import asyncio
import contextlib
import hashlib
import hmac
import json
import math
import os
import re
import time
from uuid import UUID, uuid4

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from openai import AsyncOpenAI
from pydantic import BaseModel, ConfigDict, Field, StrictInt, StrictStr

from app.chat_engine import FALLBACK, answer_question, price_configuration, sources_current
from app.db import headers, rpc

router = APIRouter(prefix="/api/v1", tags=["chat"])
COOKIE = "portfolio_chat"


def secret():
    value = os.getenv("CHAT_SESSION_SECRET", "")
    if len(value) < 32:
        raise HTTPException(503, "Chat session configuration is missing")
    return value.encode()


def session_value(session):
    return session + "." + hmac.new(secret(), session.encode(), hashlib.sha256).hexdigest()


def read_session(value):
    try:
        session, signature = (value or "").split(".", 1)
        session = str(UUID(session))
        return (
            session
            if hmac.compare_digest(session_value(session), session + "." + signature)
            else None
        )
    except ValueError, TypeError:
        return None


def verify_proxy(request):
    configured = os.getenv("CHAT_PROXY_SECRET", "")
    if len(configured) < 32:
        raise HTTPException(503, "Chat proxy configuration is missing")
    if not hmac.compare_digest(
        request.headers.get("x-portfolio-proxy", "").encode(), configured.encode()
    ):
        raise HTTPException(403, "Use the portfolio chat interface")


def event(name, data):
    return "event: " + name + "\ndata: " + json.dumps(data, ensure_ascii=False) + "\n\n"


class Question(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    question: StrictStr = Field(min_length=1, max_length=2000)


class Feedback(BaseModel):
    model_config = ConfigDict(extra="forbid")
    message_id: UUID
    vote: StrictInt = Field(ge=-1, le=1)


@router.post("/chat")
async def chat(body: Question, request: Request):
    verify_proxy(request)
    if not os.getenv("OPENAI_API_KEY"):
        raise HTTPException(503, "AI is not configured yet")
    headers(service=True)
    try:
        _model, price_in, price_out, price_embedding = price_configuration()
    except ValueError:
        raise HTTPException(503, "AI pricing configuration is invalid") from None
    session = read_session(request.cookies.get(COOKIE)) or str(uuid4())
    request_id = str(uuid4())
    ip = request.headers.get("x-portfolio-client-ip", "unknown")[:100]
    ip_hash = hmac.new(secret(), ip.encode(), hashlib.sha256).hexdigest()
    try:
        budget = float(os.getenv("CHAT_DAILY_BUDGET_USD", "0"))
        reserve = float(os.getenv("CHAT_REQUEST_RESERVE_USD", "0.05"))
    except ValueError:
        raise HTTPException(503, "Chat budget configuration is invalid") from None
    if reserve < (100000 * price_in + 1000 * price_out + 12000 * price_embedding) / 1000000:
        raise HTTPException(503, "Request reservation is too small for configured model prices")
    if not math.isfinite(budget) or not math.isfinite(reserve) or budget < 0 or reserve <= 0:
        raise HTTPException(503, "Chat budget configuration is invalid")
    async with httpx.AsyncClient(timeout=15) as client:
        await rpc(
            client,
            "chat_admit",
            {
                "p_session": session,
                "p_request": request_id,
                "p_ip_hash": ip_hash,
                "p_budget": budget,
                "p_reserve": reserve,
            },
            service=True,
        )

    async def stream():
        started = time.monotonic()
        settled = False
        task = None
        async with (
            httpx.AsyncClient(timeout=15) as client,
            AsyncOpenAI(timeout=30, max_retries=0) as ai,
        ):

            async def record_usage(calls):
                await rpc(
                    client,
                    "rag_record_usage",
                    {"p_request": request_id, "p_calls": calls},
                    service=True,
                )

            try:
                yield event(
                    "status", {"message": "Finding verified sources…", "mode": "validated_answer"}
                )
                task = asyncio.create_task(
                    asyncio.wait_for(
                        answer_question(client, ai, body.question, session, record_usage),
                        timeout=50,
                    )
                )
                while not task.done():
                    done, _ = await asyncio.wait({task}, timeout=5)
                    if not done:
                        yield ": heartbeat\n\n"
                result = await task
                if result.get("dependencies") and not await sources_current(
                    client, result["dependencies"]
                ):
                    result["answer"] = (
                        "目前没有足够的已核实资料回答这个问题。"
                        if re.search(r"[\u4e00-\u9fff]", body.question)
                        else FALLBACK
                    )
                    result["sources"] = []
                    result["dependencies"] = []
                    result["candidate_ids"] = []
                message_id = await rpc(
                    client,
                    "chat_finish",
                    {
                        "p_request": request_id,
                        "p_question": body.question,
                        "p_answer": result["answer"],
                        "p_sources": result["sources"],
                        "p_prompt": result["prompt_tokens"],
                        "p_output": result["output_tokens"],
                        "p_embedding": result["embedding_tokens"],
                        "p_cost": result["cost_usd"],
                        "p_latency": int((time.monotonic() - started) * 1000),
                    },
                    service=True,
                )
                settled = True
                if not message_id:
                    raise RuntimeError("chat_request_expired")
                # Validate complete structured output before releasing any answer text.
                payload = {
                    "text": result["answer"],
                    "sources": result["sources"],
                    "message_id": message_id,
                }
                # Only the authenticated direct evaluator sets this flag. The Next.js proxy
                # forwards a fixed header allowlist and never forwards evaluation headers.
                if request.headers.get("x-portfolio-evaluation") == "1":
                    payload["candidate_ids"] = result.get("candidate_ids", [])
                yield event("answer", payload)
                yield event("done", {})
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001 - sanitize failures at the external-service/parser boundary
                yield event(
                    "error",
                    {
                        "message": "The assistant could not complete this answer. Please try again later."
                    },
                )
            finally:
                if task and not task.done():
                    task.cancel()
                    with contextlib.suppress(BaseException):
                        await task
                if not settled:
                    with contextlib.suppress(Exception):
                        await asyncio.shield(
                            rpc(
                                client,
                                "chat_finish",
                                {
                                    "p_request": request_id,
                                    "p_question": "",
                                    "p_answer": "",
                                    "p_sources": [],
                                    "p_prompt": 0,
                                    "p_output": 0,
                                    "p_embedding": 0,
                                    "p_cost": reserve,
                                    "p_latency": int((time.monotonic() - started) * 1000),
                                    "p_error": "generation_failed_or_cancelled",
                                },
                                service=True,
                            )
                        )

    response = StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
    )
    response.set_cookie(
        COOKIE,
        session_value(session),
        httponly=True,
        secure=os.getenv("APP_ENV") == "production",
        samesite="lax",
        max_age=86400 * 30,
        path="/",
    )
    return response


@router.post("/chat/feedback")
async def feedback(body: Feedback, request: Request):
    verify_proxy(request)
    session = read_session(request.cookies.get(COOKIE))
    if not session or body.vote not in (-1, 1):
        raise HTTPException(403, "Invalid feedback session")
    async with httpx.AsyncClient(timeout=10) as client:
        ok = await rpc(
            client,
            "chat_vote",
            {"p_session": session, "p_message": str(body.message_id), "p_vote": body.vote},
            service=True,
        )
    if not ok:
        raise HTTPException(404, "Message not found")
    return {"saved": True}


@router.get("/sources/{source_id}")
async def source(source_id: UUID):
    async with httpx.AsyncClient(timeout=10) as client:
        result = await rpc(client, "public_source", {"p_id": str(source_id)}, service=True)
    if not result:
        raise HTTPException(404, "This source is unavailable or has been withdrawn")
    return result
