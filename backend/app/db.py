"""Bounded Supabase RPC/Storage access. Credentials never enter error messages."""

import os
from urllib.parse import urlparse

import httpx
from fastapi import HTTPException


def base_url():
    value = os.getenv("SUPABASE_URL", "").rstrip("/")
    p = urlparse(value)
    if (
        p.scheme != "https"
        or not p.hostname
        or p.username
        or p.password
        or p.query
        or p.fragment
        or p.path
    ):
        raise HTTPException(503, "Supabase server configuration is missing or invalid")
    return value


def headers(token=None, service=False):
    key = os.getenv("SUPABASE_SECRET_KEY" if service else "SUPABASE_PUBLISHABLE_KEY", "")
    if (
        not key
        or (service and not key.startswith(("sb_secret_", "eyJ")))
        or (not service and not key.startswith("sb_publishable_"))
    ):
        raise HTTPException(503, "Required server credentials are not configured")
    result = {"apikey": key, "Content-Type": "application/json"}
    if token:
        result["Authorization"] = "Bearer " + token
    elif key.startswith("eyJ"):
        result["Authorization"] = "Bearer " + key
    return result


async def rpc(client, name, args=None, token=None, service=False):
    try:
        response = await client.post(
            base_url() + "/rest/v1/rpc/" + name, headers=headers(token, service), json=args or {}
        )
    except httpx.HTTPError:
        raise HTTPException(503, "Database service unavailable") from None
    if not response.is_success:
        try:
            value = response.json()
            code = value.get("code") if isinstance(value, dict) else None
        except ValueError:
            code = None
        if response.status_code == 401:
            raise HTTPException(401, "Sign in again", headers={"WWW-Authenticate": "Bearer"})
        if response.status_code == 403 or code == "42501":
            raise HTTPException(403, "Administrator access required")
        if code == "P0002":
            raise HTTPException(404, "Record not found")
        if code in ("40001", "23505"):
            raise HTTPException(
                409,
                "Record changed, request already used, or unique value already exists. Reload before editing.",
            )
        if code in ("22023", "23514", "23502", "22P02", "23503"):
            raise HTTPException(422, "Invalid content fields or relationships")
        if code == "P0001":
            raise HTTPException(429, "Rate limit or daily AI budget reached. Please try later.")
        raise HTTPException(503, "Database setup incomplete or service unavailable")
    if not response.content:
        return None
    try:
        return response.json()
    except ValueError:
        raise HTTPException(503, "Invalid database response") from None
