"""Durable queue runner. Run on GitHub Actions or any separately managed worker."""

import argparse
import asyncio
import hashlib
import math
import os
from pathlib import PurePosixPath

import httpx
from openai import AsyncOpenAI

from app.db import base_url, headers, rpc
from app.ingestion import chunk_sections, extract_document


async def process_job(client, ai, job):
    from starlette.concurrency import run_in_threadpool

    model = os.getenv("OPENAI_EMBEDDING_MODEL", "text-embedding-3-small")
    reserved = False
    tokens = 0
    try:
        response = await client.get(
            base_url()
            + "/storage/v1/object/authenticated/portfolio-knowledge/"
            + job["storage_path"],
            headers=headers(service=True),
            timeout=45,
        )
        response.raise_for_status()
        data = response.content
        if len(data) > 20971520 or hashlib.sha256(data).hexdigest() != job["sha256"]:
            raise ValueError("file_integrity_failed")
        sections = await run_in_threadpool(
            extract_document, data, PurePosixPath(job["filename"]).suffix.lower()
        )
        chunks = chunk_sections(sections)
        price = float(os.getenv("EMBEDDING_USD_PER_MILLION", "0.02"))
        budget = float(os.getenv("INGESTION_DAILY_BUDGET_USD", "0"))
        if not math.isfinite(price) or not math.isfinite(budget) or price <= 0 or budget < 0:
            raise ValueError("invalid_embedding_budget")
        if model != "text-embedding-3-small" and not os.getenv("EMBEDDING_USD_PER_MILLION"):
            raise ValueError("embedding_price_required")
        estimate = (sum(len(c["text"].encode("utf-8")) + 100 for c in chunks)) * price / 1000000
        reserved = await rpc(
            client,
            "worker_reserve_budget",
            {
                "p_job": job["id"],
                "p_lease": job["lease_token"],
                "p_budget": budget,
                "p_reserve": estimate,
            },
            service=True,
        )
        if not reserved:
            raise ValueError("embedding_daily_budget_reached")
        for index in range(0, len(chunks), 32):
            batch = chunks[index : index + 32]
            embedded = await ai.embeddings.create(
                model=model, input=[c["text"] for c in batch], dimensions=1536
            )
            tokens += embedded.usage.total_tokens
            if len(embedded.data) != len(batch):
                raise ValueError("embedding_batch_mismatch")
            for chunk, value in zip(batch, sorted(embedded.data, key=lambda item: item.index)):
                if len(value.embedding) != 1536:
                    raise ValueError("embedding_dimension_mismatch")
                chunk["embedding"] = value.embedding
            await rpc(
                client,
                "worker_store_chunks",
                {
                    "p_job": job["id"],
                    "p_lease": job["lease_token"],
                    "p_chunks": batch,
                    "p_model": model,
                },
                service=True,
            )
        await rpc(
            client,
            "worker_settle_budget",
            {"p_lease": job["lease_token"], "p_tokens": tokens, "p_cost": tokens * price / 1000000},
            service=True,
        )
        activated = await rpc(
            client,
            "worker_finish_job",
            {"p_job": job["id"], "p_lease": job["lease_token"], "p_model": model},
            service=True,
        )
        return "completed" if activated else "superseded"
    except Exception as error:  # noqa: BLE001 - persist failed job before returning
        if reserved:
            await rpc(
                client,
                "worker_settle_budget",
                {"p_lease": job["lease_token"], "p_tokens": tokens, "p_cost": 0, "p_failed": True},
                service=True,
            )
        code = str(error) if isinstance(error, ValueError) else type(error).__name__
        await rpc(
            client,
            "worker_finish_job",
            {"p_job": job["id"], "p_lease": job["lease_token"], "p_error": code[:80]},
            service=True,
        )
        return "failed"


async def run(max_jobs=3):
    async with httpx.AsyncClient(timeout=30, follow_redirects=False) as client:
        await rpc(client, "worker_retention_cleanup", service=True)
    if not os.getenv("OPENAI_API_KEY"):
        print("Retention complete; ingestion disabled until OPENAI_API_KEY is configured.")
        return
    async with (
        httpx.AsyncClient(timeout=30, follow_redirects=False) as client,
        AsyncOpenAI(timeout=30, max_retries=0) as ai,
    ):
        for _ in range(max_jobs):
            job = await rpc(client, "worker_claim_job", service=True)
            if not job:
                break
            status = await process_job(client, ai, job)
            print("ingestion", job["id"], status, flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--max-jobs", type=int, default=3)
    args = parser.parse_args()
    asyncio.run(run(max(1, min(args.max_jobs, 10))))
