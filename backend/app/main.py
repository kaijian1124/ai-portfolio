"""Portfolio API, authenticated content management and grounded chat."""

import os
from typing import Annotated, Literal

from fastapi import Depends, FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from app.auth import AdminIdentity, require_admin
from app.chat import router as chat_router
from app.content import router as content_router
from app.files import router as files_router
from app.limits import RequestLimitsMiddleware
from app.profile import router as profile_router
from app.resume_import import router as resume_import_router


class Liveness(BaseModel):
    status: Literal["alive"] = "alive"


class Readiness(BaseModel):
    status: Literal["ready"] = "ready"
    checks: dict[str, str]


def create_app() -> FastAPI:
    application = FastAPI(title="AI Portfolio API", version="0.1.0")
    origins = [
        origin.strip()
        for origin in os.getenv("ALLOWED_ORIGINS", "http://localhost:3000").split(",")
        if origin.strip()
    ]
    application.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_credentials=False,
        allow_methods=["GET", "PUT"],
        allow_headers=["Accept", "Content-Type", "Authorization"],
    )

    @application.get("/health/live", response_model=Liveness, tags=["health"])
    async def liveness(response: Response) -> Liveness:
        response.headers["Cache-Control"] = "no-store"
        return Liveness()

    @application.get("/health/ready", response_model=Readiness, tags=["health"])
    async def readiness(response: Response) -> Readiness:
        response.headers["Cache-Control"] = "no-store"
        # API-process readiness only. This probe must never call paid AI services.
        return Readiness(checks={"api": "ok"})

    @application.middleware("http")
    async def prevent_admin_caching(request: Request, call_next):
        response = await call_next(request)
        if request.url.path.startswith("/api/v1/admin"):
            response.headers["Cache-Control"] = "private, no-store"
        return response

    @application.get("/api/v1/admin/me", response_model=AdminIdentity, tags=["admin"])
    async def admin_identity(
        identity: Annotated[AdminIdentity, Depends(require_admin)],
    ) -> AdminIdentity:
        return identity

    application.add_middleware(RequestLimitsMiddleware)
    application.include_router(profile_router)
    application.include_router(content_router)
    application.include_router(files_router)
    application.include_router(chat_router)
    application.include_router(resume_import_router)
    return application


app = create_app()
