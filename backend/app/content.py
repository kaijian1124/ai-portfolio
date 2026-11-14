"""Typed content administration; all writes use audited database transactions."""

from datetime import date
from typing import Annotated, Literal
from urllib.parse import urlparse
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import (
    AfterValidator,
    BaseModel,
    BeforeValidator,
    ConfigDict,
    Field,
    StrictBool,
    StrictInt,
    StrictStr,
    model_validator,
)

from app.auth import bearer, get_auth_client, require_admin
from app.db import rpc

Resource = Literal[
    "projects", "skills", "experiences", "education", "resumes", "documents", "project_assets"
]


def optional(value):
    return value.strip() or None if isinstance(value, str) else value


def secure_url(value):
    if value:
        p = urlparse(value)
        if (
            p.scheme != "https"
            or not p.hostname
            or p.username
            or p.password
            or any(c.isspace() for c in value)
        ):
            raise ValueError("Use HTTPS without embedded credentials")
        _ = p.port
    return value


Url = Annotated[
    StrictStr | None, Field(max_length=2048), BeforeValidator(optional), AfterValidator(secure_url)
]


class Common(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    status: Literal["draft", "published", "archived"] = "draft"
    sort_order: Annotated[StrictInt, Field(ge=-10000, le=10000)] = 0


class Project(Common):
    title: Annotated[StrictStr, Field(min_length=1, max_length=160)]
    slug: Annotated[
        StrictStr, Field(min_length=1, max_length=100, pattern=r"^[a-z0-9]+(-[a-z0-9]+)*$")
    ]
    summary: Annotated[StrictStr, Field(max_length=2000)] = ""
    body_markdown: Annotated[StrictStr, Field(max_length=60000)] = ""
    github_url: Url = None
    demo_url: Url = None
    is_featured: StrictBool = False
    category: Annotated[StrictStr, Field(max_length=80)] = ""
    technologies: Annotated[
        list[Annotated[StrictStr, Field(min_length=1, max_length=60)]], Field(max_length=30)
    ] = []


class Skill(Common):
    name: Annotated[StrictStr, Field(min_length=1, max_length=100)]
    category: Annotated[StrictStr, Field(max_length=80)] = ""
    description: Annotated[StrictStr, Field(max_length=2000)] = ""


class Dates(Common):
    started_on: date
    ended_on: date | None = None
    description_markdown: Annotated[StrictStr, Field(max_length=20000)] = ""

    @model_validator(mode="after")
    def ordered(self):
        if self.ended_on and self.ended_on < self.started_on:
            raise ValueError("End date must not precede start date")
        return self


class Experience(Dates):
    company: Annotated[StrictStr, Field(min_length=1, max_length=160)]
    job_title: Annotated[StrictStr, Field(min_length=1, max_length=160)]
    location: Annotated[StrictStr | None, Field(max_length=120), BeforeValidator(optional)] = None


class Education(Dates):
    institution: Annotated[StrictStr, Field(min_length=1, max_length=160)]
    qualification: Annotated[StrictStr, Field(min_length=1, max_length=160)]
    field_of_study: Annotated[StrictStr, Field(max_length=160)] = ""


class Resume(Common):
    title: Annotated[StrictStr, Field(min_length=1, max_length=160)]


class Document(Resume):
    project_id: UUID | None = None
    approved_for_chat: StrictBool = False


class Asset(Common):
    status: Literal["draft", "published", "archived"] = "published"
    alt_text: Annotated[StrictStr, Field(max_length=500)] = ""


MODELS = {
    "projects": Project,
    "skills": Skill,
    "experiences": Experience,
    "education": Education,
    "resumes": Resume,
    "documents": Document,
    "project_assets": Asset,
}


def validate_content(resource, data):
    if resource not in MODELS:
        raise ValueError("Unsupported resource")
    return MODELS[resource].model_validate(data).model_dump(mode="json")


class Mutation(BaseModel):
    model_config = ConfigDict(extra="forbid")
    data: dict
    expected_revision: Annotated[StrictInt | None, Field(ge=0, le=9007199254740991)]
    request_id: UUID
    operation: Literal["save", "delete", "restore", "activate"] = "save"


router = APIRouter(prefix="/api/v1/admin", dependencies=[Depends(require_admin)], tags=["admin"])


@router.get("/catalog/{resource}")
async def listing(
    resource: Resource,
    credentials=Depends(bearer),
    client=Depends(get_auth_client),
    limit: int = Query(100, ge=1, le=100),
    offset: int = Query(0, ge=0, le=100000),
    include_deleted: bool = False,
):
    return {
        "records": await rpc(
            client,
            "admin_catalog_list",
            {
                "p_resource": resource,
                "p_limit": limit,
                "p_offset": offset,
                "p_include_deleted": include_deleted,
            },
            credentials.credentials,
        )
    }


@router.post("/catalog/{resource}")
async def mutate(
    resource: Resource,
    body: Mutation,
    record_id: UUID | None = None,
    credentials=Depends(bearer),
    client=Depends(get_auth_client),
):
    from fastapi import HTTPException
    from pydantic import ValidationError

    try:
        data = validate_content(resource, body.data) if body.operation == "save" else {}
    except ValueError, ValidationError:
        raise HTTPException(422, "Check required fields, dates, lengths and HTTPS links") from None
    if body.operation == "activate" and resource != "resumes":
        raise HTTPException(422, "Only a Resume can be activated")
    return {
        "record": await rpc(
            client,
            "admin_catalog_mutate",
            {
                "p_resource": resource,
                "p_id": str(record_id) if record_id else None,
                "p_data": data,
                "p_expected_revision": body.expected_revision,
                "p_request_id": str(body.request_id),
                "p_operation": body.operation,
            },
            credentials.credentials,
        )
    }


@router.get("/activity")
async def activity(credentials=Depends(bearer), client=Depends(get_auth_client)):
    return {"events": await rpc(client, "admin_activity", {}, credentials.credentials)}


@router.get("/monitoring")
async def monitoring(credentials=Depends(bearer), client=Depends(get_auth_client)):
    return await rpc(client, "admin_monitoring", {}, credentials.credentials)


@router.get("/logs/{feed}")
async def admin_logs(
    feed: Literal["requests", "jobs", "audit"],
    page: int = Query(1, ge=1, le=2000000),
    size: int = Query(10, ge=10, le=50),
    credentials=Depends(bearer),
    client=Depends(get_auth_client),
):
    if size not in (10, 20, 50):
        raise HTTPException(422, "Page size must be 10, 20 or 50")
    return await rpc(
        client,
        "admin_log_page",
        {"p_feed": feed, "p_page": page, "p_size": size},
        credentials.credentials,
    )


@router.get("/retrieval-runs")
async def retrieval_runs(credentials=Depends(bearer), client=Depends(get_auth_client)):
    return {"runs": await rpc(client, "admin_retrieval_runs", {}, credentials.credentials)}


@router.get("/retrieval-runs/{request_id}")
async def retrieval_run(
    request_id: UUID, credentials=Depends(bearer), client=Depends(get_auth_client)
):
    return await rpc(
        client, "admin_retrieval_trace", {"p_request": str(request_id)}, credentials.credentials
    )


@router.get("/retrieval-chunks/{chunk_id}")
async def retrieval_chunk(
    chunk_id: UUID, credentials=Depends(bearer), client=Depends(get_auth_client)
):
    return await rpc(
        client, "admin_retrieval_chunk", {"p_chunk": str(chunk_id)}, credentials.credentials
    )


@router.get("/documents/{record_id}/versions")
async def versions(record_id: UUID, credentials=Depends(bearer), client=Depends(get_auth_client)):
    return {
        "versions": await rpc(
            client, "admin_document_versions", {"p_id": str(record_id)}, credentials.credentials
        )
    }


@router.get("/documents/{record_id}/versions/{version_id}/chunks")
async def ingestion_chunks(
    record_id: UUID,
    version_id: UUID,
    offset: int = Query(0, ge=0, le=100000),
    limit: int = Query(20, ge=1, le=50),
    credentials=Depends(bearer),
    client=Depends(get_auth_client),
):
    return await rpc(
        client,
        "admin_ingestion_chunks",
        {
            "p_document": str(record_id),
            "p_version": str(version_id),
            "p_offset": offset,
            "p_limit": limit,
        },
        credentials.credentials,
    )


@router.post("/documents/{record_id}/reindex")
async def reindex(
    record_id: UUID, body: dict, credentials=Depends(bearer), client=Depends(get_auth_client)
):
    from fastapi import HTTPException

    try:
        request_id = str(UUID(str(body.get("request_id"))))
    except ValueError:
        raise HTTPException(422, "A request UUID is required") from None
    result = await rpc(
        client,
        "admin_reindex_document",
        {"p_id": str(record_id), "p_request_id": request_id},
        credentials.credentials,
    )
    from app.files import dispatch_worker

    result["worker_dispatched"] = await dispatch_worker(client)
    return result


@router.get("/catalog/{resource}/{record_id}")
async def get_record(
    resource: Resource,
    record_id: UUID,
    credentials=Depends(bearer),
    client=Depends(get_auth_client),
):
    return {
        "record": await rpc(
            client,
            "admin_catalog_get",
            {"p_resource": resource, "p_id": str(record_id)},
            credentials.credentials,
        )
    }
