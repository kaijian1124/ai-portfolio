"""Authenticated bounded uploads and short-lived private download links."""

import hashlib
import os
import re
from io import BytesIO
from urllib.parse import quote, urlparse
from uuid import UUID, uuid4

import httpx
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from PIL import Image, UnidentifiedImageError

from app.auth import bearer, get_auth_client, require_admin
from app.db import base_url, headers, rpc
from app.ingestion import extract_document

router = APIRouter(prefix="/api/v1/admin", dependencies=[Depends(require_admin)], tags=["files"])
BUCKETS = {
    "resume": "portfolio-resumes",
    "knowledge": "portfolio-knowledge",
    "image": "portfolio-images",
}


def validate_upload(data, kind, filename):
    if kind not in BUCKETS:
        raise ValueError("unsupported_upload")
    limit = 4194304 if kind == "image" else 10485760 if kind == "resume" else 20971520
    if not data or len(data) > limit:
        raise ValueError("file_size_limit")
    suffix = "." + filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    if kind == "image":
        try:
            with Image.open(BytesIO(data)) as image:
                if image.width * image.height > 20000000:
                    raise ValueError("image_dimensions_too_large")
                fmt = image.format
                image.verify()
            if fmt not in ("PNG", "JPEG", "WEBP"):
                raise ValueError("unsupported_image")
            return {
                "PNG": (".png", "image/png"),
                "JPEG": (".jpg", "image/jpeg"),
                "WEBP": (".webp", "image/webp"),
            }[fmt]
        except UnidentifiedImageError, OSError:
            raise ValueError("invalid_image") from None
    if suffix not in ((".pdf",) if kind == "resume" else (".pdf", ".docx", ".md")):
        raise ValueError("unsupported_document")
    if suffix == ".pdf" and not data.startswith(b"%PDF-"):
        raise ValueError("invalid_pdf")
    # Validation and parsing run outside the event loop; knowledge parsing is repeated in the durable worker.
    if kind == "knowledge":
        extract_document(data, suffix)
    else:
        from pypdf import PdfReader

        try:
            pdf = PdfReader(BytesIO(data), strict=True)
            if pdf.is_encrypted or len(pdf.pages) > 300:
                raise ValueError("invalid_resume")
        except Exception:  # noqa: BLE001 - sanitize failures at the external-service/parser boundary
            raise ValueError("invalid_resume") from None
    return (
        suffix,
        {
            ".pdf": "application/pdf",
            ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            ".md": "text/markdown",
        }[suffix],
    )


async def signed_url(client, bucket, path):
    if bucket not in BUCKETS.values() or not re.fullmatch(
        r"[a-f0-9-]+/[a-f0-9-]+\.(pdf|docx|md|png|jpg|webp)", path
    ):
        raise HTTPException(422, "Invalid file reference")
    response = await client.post(
        base_url() + "/storage/v1/object/sign/" + bucket + "/" + quote(path, safe="/"),
        headers=headers(service=True),
        json={"expiresIn": 60},
    )
    if not response.is_success:
        raise HTTPException(503, "File download unavailable")
    try:
        value = response.json()["signedURL"]
    except ValueError, KeyError:
        raise HTTPException(503, "Invalid storage response") from None
    if value.startswith("https://"):
        result = value
    elif value.startswith("/storage/v1/"):
        result = base_url() + value
    else:
        result = base_url() + "/storage/v1/" + value.lstrip("/")
    if urlparse(result).netloc != urlparse(base_url()).netloc:
        raise HTTPException(503, "Invalid storage origin")
    return result


async def dispatch_worker(client):
    token = os.getenv("GITHUB_ACTIONS_TOKEN", "")
    repo = os.getenv("GITHUB_REPOSITORY", "")
    if not token or not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repo):
        return False
    try:
        response = await client.post(
            "https://api.github.com/repos/" + repo + "/actions/workflows/ingestion.yml/dispatches",
            headers={"Authorization": "Bearer " + token, "Accept": "application/vnd.github+json"},
            json={"ref": os.getenv("GITHUB_DEFAULT_BRANCH", "main")},
        )
        return response.status_code == 204
    except httpx.HTTPError:
        return False


@router.post("/uploads")
async def upload(
    file: UploadFile = File(...),
    kind: str = Form(...),
    title: str = Form(...),
    project_id: UUID | None = Form(None),
    replace_id: UUID | None = Form(None),
    credentials=Depends(bearer),
    client=Depends(get_auth_client),
):
    from starlette.concurrency import run_in_threadpool

    if kind not in BUCKETS:
        raise HTTPException(422, "Unsupported upload kind")
    title = title.strip()
    if not 1 <= len(title) <= 160:
        raise HTTPException(422, "Title must contain 1–160 characters")
    filename = re.sub(
        r"[\x00-\x1f\x7f]", "", (file.filename or "upload").replace("\\", "/").split("/")[-1]
    )[:180]
    data = await file.read(20971521)
    try:
        suffix, mime = await run_in_threadpool(validate_upload, data, kind, filename)
    except ValueError as error:
        raise HTTPException(422, str(error)) from None
    path = str(uuid4()) + "/" + str(uuid4()) + suffix
    bucket = BUCKETS[kind]
    response = await client.post(
        base_url() + "/storage/v1/object/" + bucket + "/" + path,
        headers={**headers(service=True), "Content-Type": mime, "x-upsert": "false"},
        content=data,
        timeout=45,
    )
    if not response.is_success:
        raise HTTPException(503, "File upload failed")
    try:
        result = await rpc(
            client,
            "admin_register_upload",
            {
                "p_kind": kind,
                "p_title": title,
                "p_filename": filename,
                "p_path": path,
                "p_sha256": hashlib.sha256(data).hexdigest(),
                "p_size": len(data),
                "p_project_id": str(project_id) if project_id else None,
                "p_replace_id": str(replace_id) if replace_id else None,
            },
            credentials.credentials,
        )
    except HTTPException as error:
        # On uncertain server failures the DB may have committed. Keep the file for reconciliation.
        if error.status_code < 500:
            try:
                await client.delete(
                    base_url() + "/storage/v1/object/" + bucket + "/" + path,
                    headers=headers(service=True),
                )
            except httpx.HTTPError:
                pass
        raise
    if result.get("duplicate"):
        try:
            await client.delete(
                base_url() + "/storage/v1/object/" + bucket + "/" + path,
                headers=headers(service=True),
            )
        except httpx.HTTPError:
            pass
    if kind == "knowledge":
        result["worker_dispatched"] = await dispatch_worker(client)
    return result


@router.get("/files/{resource}/{record_id}")
async def private_file(
    resource: str,
    record_id: UUID,
    version_id: UUID | None = None,
    credentials=Depends(bearer),
    client=Depends(get_auth_client),
):
    info = await rpc(
        client,
        "admin_file_info",
        {
            "p_resource": resource,
            "p_id": str(record_id),
            "p_version_id": str(version_id) if version_id else None,
        },
        credentials.credentials,
    )
    return {"url": await signed_url(client, info["bucket"], info["path"])}
