"""Independent scoring of approved retrieval candidates through Cohere Rerank."""

import math
import os
import time
from types import SimpleNamespace

import httpx
from fastapi import HTTPException

from app.db import rpc

MODEL = "rerank-v3.5"


def validate_ranking(results, count):
    if not isinstance(results, list) or len(results) != count:
        raise ValueError("incomplete ranking")
    seen = set()
    ranked = []
    for item in results:
        index, score = item["index"], item["relevance_score"]
        if (
            type(index) is not int
            or index not in range(count)
            or index in seen
            or type(score) not in (float, int)
            or not math.isfinite(score)
            or not 0 <= score <= 1
        ):
            raise ValueError("invalid ranking")
        seen.add(index)
        ranked.append((index, score))
    return sorted(ranked, key=lambda item: (-item[1], item[0]))


async def rerank_candidates(client, ledger, query, chunks, keep):
    baseline = chunks[:12]
    trace = {
        "model": MODEL,
        "status": "disabled",
        "before": [str(c["id"]) for c in baseline],
        "after": [],
    }
    if os.getenv("RAG_RERANK_ENABLED", "").lower() != "true":
        return chunks, trace
    key = os.getenv("COHERE_API_KEY")
    if not key:
        return chunks, {**trace, "status": "missing configuration"}
    if len(baseline) < 2:
        return chunks, {**trace, "status": "fewer than two candidates"}
    try:
        charge = float(os.environ["RERANK_USD_PER_REQUEST"])
        if not math.isfinite(charge) or charge <= 0:
            raise ValueError
        ledger.check(charge)
    except KeyError, ValueError:
        return chunks, {**trace, "status": "budget or pricing unavailable"}

    try:
        current = await rpc(client, "knowledge_current", {"p_ids": trace["before"]}, service=True)
    except HTTPException:
        current = False
    if not current:
        return chunks, {**trace, "status": "eligibility changed; RRF used"}

    started = time.monotonic()
    # Count the attempted request even if the upstream result cannot be verified.
    ledger.cost += charge
    response = None
    validated = None
    try:
        response = await client.post(
            "https://api.cohere.com/v2/rerank",
            headers={"Authorization": "Bearer " + key},
            json={
                "model": MODEL,
                "query": query[:2000],
                "documents": [
                    "\n".join(filter(None, (c.get("heading"), c["excerpt"])))[:2600]
                    for c in baseline
                ],
            },
            follow_redirects=False,
            timeout=4,
        )
        response.raise_for_status()
        validated = validate_ranking(response.json()["results"], len(baseline))
    except httpx.HTTPError, ValueError, TypeError, KeyError:
        trace["status"] = "provider unavailable; RRF used"
    else:
        trace["status"] = "completed"
        trace["after"] = [
            {"id": str(baseline[index]["id"]), "score": score, "kept": rank < keep}
            for rank, (index, score) in enumerate(validated)
        ]
    trace["latency_ms"] = round((time.monotonic() - started) * 1000)
    await ledger.record(
        "rerank",
        SimpleNamespace(
            usage=True,
            _request_id=response.headers.get("x-request-id") if response is not None else None,
        ),
        {"model": MODEL, "rerank_requests": 1, "cost_usd": charge},
    )
    if validated is None:
        return chunks, trace
    return [baseline[index] for index, _ in validated] + chunks[12:], trace
