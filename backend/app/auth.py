"""Single-admin authorization using Supabase Auth as the token verifier."""

import os
from collections.abc import AsyncIterator
from typing import Annotated, Literal
from urllib.parse import urlparse
from uuid import UUID

import httpx
from fastapi import Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel

bearer = HTTPBearer(auto_error=False)


class AdminIdentity(BaseModel):
    user_id: UUID
    role: Literal["admin"] = "admin"


async def get_auth_client() -> AsyncIterator[httpx.AsyncClient]:
    async with httpx.AsyncClient(timeout=8.0, follow_redirects=False) as client:
        yield client


def unauthorized() -> HTTPException:
    return HTTPException(401, "Authentication required", headers={"WWW-Authenticate": "Bearer"})


async def require_admin(
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer)],
    client: Annotated[httpx.AsyncClient, Depends(get_auth_client)],
) -> AdminIdentity:
    if credentials is None or len(credentials.credentials) > 8192:
        raise unauthorized()
    base_url = os.getenv("SUPABASE_URL", "")
    key = os.getenv("SUPABASE_PUBLISHABLE_KEY", "")
    try:
        parsed = urlparse(base_url)
        admin_id = UUID(os.getenv("ADMIN_USER_ID", ""))
        if (
            parsed.scheme != "https"
            or not parsed.hostname
            or parsed.username
            or parsed.password
            or not key.startswith("sb_publishable_")
        ):
            raise ValueError("Invalid auth configuration")
    except ValueError:
        raise HTTPException(503, "Authentication service unavailable") from None

    try:
        response = await client.get(
            f"{base_url.rstrip('/')}/auth/v1/user",
            headers={"apikey": key, "Authorization": f"Bearer {credentials.credentials}"},
        )
        if response.status_code in (401, 403):
            raise unauthorized()
        if response.status_code != 200:
            raise HTTPException(503, "Authentication service unavailable")
        payload = response.json()
        user_id = UUID(payload["id"])
        is_anonymous = payload.get("is_anonymous", False)
    except httpx.HTTPError, ValueError, TypeError, KeyError:
        raise HTTPException(503, "Authentication service unavailable") from None

    # Never authorize from user-editable metadata, email, or an unverified JWT decode.
    if user_id != admin_id or is_anonymous:
        raise HTTPException(403, "Administrator access required")
    return AdminIdentity(user_id=user_id)
