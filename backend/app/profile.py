"""Profile reads/writes. Supabase RPC owns the atomic mutation and audit transaction."""

import os
import re
from datetime import datetime
from typing import Annotated, Literal
from urllib.parse import urlparse
from uuid import UUID

import httpx
from fastapi import APIRouter, Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StrictInt,
    StrictStr,
    ValidationError,
    field_validator,
)

from app.auth import bearer, get_auth_client, require_admin, unauthorized


class ProfileFields(BaseModel):
    model_config = ConfigDict(extra="forbid")
    display_name: Annotated[StrictStr, Field(min_length=1, max_length=120)]
    headline: Annotated[StrictStr, Field(max_length=200)]
    about_markdown: Annotated[StrictStr, Field(max_length=20000)]
    location: Annotated[StrictStr | None, Field(max_length=120)]
    public_email: Annotated[StrictStr | None, Field(max_length=254)]
    github_url: Annotated[StrictStr | None, Field(max_length=2048)]
    linkedin_url: Annotated[StrictStr | None, Field(max_length=2048)]
    status: Literal["draft", "published", "archived"]

    @field_validator("display_name", mode="before")
    @classmethod
    def trim_name(cls, value):
        return value.strip() if isinstance(value, str) else value

    @field_validator("location", "public_email", "github_url", "linkedin_url", mode="before")
    @classmethod
    def normalize_optional(cls, value):
        return value.strip() or None if isinstance(value, str) else value

    @field_validator("public_email")
    @classmethod
    def validate_email(cls, value):
        if value and not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", value):
            raise ValueError("Invalid public email")
        return value

    @field_validator("github_url", "linkedin_url")
    @classmethod
    def validate_url(cls, value):
        if value:
            parsed = urlparse(value)
            if (
                parsed.scheme != "https"
                or not parsed.hostname
                or parsed.username
                or parsed.password
                or any(char.isspace() for char in value)
            ):
                raise ValueError("Only credential-free HTTPS URLs are allowed")
            try:
                _ = parsed.port
            except ValueError:
                raise ValueError("Invalid URL port") from None
        return value


class SaveProfileRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    profile: ProfileFields
    expected_revision: Annotated[StrictInt | None, Field(ge=0, le=9007199254740991)]
    request_id: UUID


class ProfileRecord(ProfileFields):
    model_config = ConfigDict(extra="ignore")
    id: UUID
    revision: Annotated[StrictInt, Field(ge=0, le=9007199254740991)]
    sort_order: int
    created_at: datetime
    updated_at: datetime


class ProfileResponse(BaseModel):
    profile: ProfileRecord | None


router = APIRouter(
    prefix="/api/v1/admin/profile", tags=["admin"], dependencies=[Depends(require_admin)]
)
Client = Annotated[httpx.AsyncClient, Depends(get_auth_client)]
Credentials = Annotated[HTTPAuthorizationCredentials, Depends(bearer)]


async def call_profile_rpc(name: str, payload: dict, credentials, client) -> object:
    try:
        response = await client.post(
            f"{os.environ['SUPABASE_URL'].rstrip('/')}/rest/v1/rpc/{name}",
            headers={
                "apikey": os.environ["SUPABASE_PUBLISHABLE_KEY"],
                "Authorization": f"Bearer {credentials.credentials}",
            },
            json=payload,
        )
    except httpx.HTTPError:
        raise HTTPException(503, "Profile service unavailable") from None
    if response.status_code == 401:
        raise unauthorized()
    if not response.is_success:
        try:
            error = response.json()
            code = error.get("code") if isinstance(error, dict) else None
        except ValueError:
            code = None
        if response.status_code == 403 or code == "42501":
            raise HTTPException(403, "Administrator access required")
        if code == "40001":
            raise HTTPException(
                409, "Profile has changed or request ID was reused; reload before editing"
            )
        if code in {"22023", "23514", "23502", "22P02"}:
            raise HTTPException(422, "Invalid profile input")
        raise HTTPException(503, "Profile service unavailable")
    if not response.content:
        return None
    try:
        return response.json()
    except ValueError:
        raise HTTPException(503, "Invalid profile service response") from None


def parse_record(value: object) -> ProfileRecord:
    try:
        return ProfileRecord.model_validate(value)
    except ValidationError:
        raise HTTPException(503, "Invalid profile service response") from None


@router.get("", response_model=ProfileResponse)
async def read_profile(credentials: Credentials, client: Client) -> ProfileResponse:
    value = await call_profile_rpc("admin_get_profile", {}, credentials, client)
    return ProfileResponse(profile=None if value is None else parse_record(value))


@router.put("", response_model=ProfileResponse)
async def save_profile(
    body: SaveProfileRequest, credentials: Credentials, client: Client
) -> ProfileResponse:
    value = await call_profile_rpc(
        "admin_save_profile",
        {
            "p_profile": body.profile.model_dump(mode="json"),
            "p_expected_revision": body.expected_revision,
            "p_request_id": str(body.request_id),
        },
        credentials,
        client,
    )
    return ProfileResponse(profile=parse_record(value))
