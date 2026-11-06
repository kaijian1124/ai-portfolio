"""Bounded request buffering and upload concurrency before multipart parsing."""

import asyncio
import json


class RequestLimitsMiddleware:
    def __init__(self, app):
        self.app = app
        self.uploads = asyncio.Semaphore(2)

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope["method"] not in ("POST", "PUT", "PATCH"):
            return await self.app(scope, receive, send)
        upload = scope["path"] == "/api/v1/admin/uploads"
        limit = 22 * 1024 * 1024 if upload else 512 * 1024
        if scope["path"].startswith("/api/v1/chat"):
            limit = 8192
        headers = dict(scope.get("headers", []))

        async def reject(status, message):
            data = json.dumps({"detail": message}).encode()
            await send(
                {
                    "type": "http.response.start",
                    "status": status,
                    "headers": [
                        (b"content-type", b"application/json"),
                        (b"cache-control", b"no-store"),
                    ],
                }
            )
            await send({"type": "http.response.body", "body": data})

        if upload and not headers.get(b"authorization", b"").lower().startswith(b"bearer "):
            return await reject(401, "Authentication required")
        try:
            if int(headers.get(b"content-length", b"0")) > limit:
                return await reject(413, "Request too large")
        except ValueError:
            return await reject(400, "Invalid content length")
        if upload and self.uploads.locked():
            return await reject(429, "Too many uploads; try later")
        if upload:
            await self.uploads.acquire()
        try:
            parts = []
            size = 0
            try:
                async with asyncio.timeout(30):
                    while True:
                        message = await receive()
                        if message["type"] == "http.disconnect":
                            return
                        value = message.get("body", b"")
                        size += len(value)
                        if size > limit:
                            return await reject(413, "Request too large")
                        parts.append(value)
                        if not message.get("more_body", False):
                            break
            except TimeoutError:
                return await reject(408, "Request timed out")
            body = b"".join(parts)
            delivered = False

            async def replay():
                nonlocal delivered
                if not delivered:
                    delivered = True
                    return {"type": "http.request", "body": body, "more_body": False}
                return await receive()

            await self.app(scope, replay, send)
        finally:
            if upload:
                self.uploads.release()
