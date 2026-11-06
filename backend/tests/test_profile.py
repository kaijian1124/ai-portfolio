import json

import httpx
import pytest
from fastapi.testclient import TestClient

from app.auth import get_auth_client
from app.main import create_app

ADMIN = "11111111-1111-4111-8111-111111111111"
REQUEST_ID = "33333333-3333-4333-8333-333333333333"
FIELDS = {
    "display_name": "TEST ONLY",
    "headline": "Test headline",
    "about_markdown": "Test about",
    "location": None,
    "public_email": "test@example.test",
    "github_url": "https://github.com/example",
    "linkedin_url": None,
    "status": "draft",
}
RECORD = {
    **FIELDS,
    "id": "22222222-2222-4222-8222-222222222222",
    "revision": 1,
    "created_at": "2026-01-01T00:00:00Z",
    "updated_at": "2026-01-01T00:00:00Z",
    "sort_order": 0,
}
HEADERS = {"Authorization": "Bearer test-user-token"}


@pytest.fixture
def application(monkeypatch):
    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setenv("SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test_fixture")
    monkeypatch.setenv("ADMIN_USER_ID", ADMIN)
    return create_app()


def client_for(application, rpc_handler, user_id=ADMIN):
    def handler(request):
        if request.url.path == "/auth/v1/user":
            return httpx.Response(200, json={"id": user_id, "is_anonymous": False})
        assert request.headers["authorization"] == HEADERS["Authorization"]
        assert request.headers["apikey"] == "sb_publishable_test_fixture"
        return rpc_handler(request)

    async def override():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            yield client

    application.dependency_overrides[get_auth_client] = override
    return TestClient(application)


def body(**overrides):
    return {"profile": FIELDS, "expected_revision": 0, "request_id": REQUEST_ID, **overrides}


def test_reads_existing_and_empty_profile(application):
    responses = [RECORD, None]

    def handler(request):
        assert request.method == "POST"
        assert request.url.path == "/rest/v1/rpc/admin_get_profile"
        assert json.loads(request.content) == {}
        return httpx.Response(200, json=responses.pop(0))

    client = client_for(application, handler)
    response = client.get("/api/v1/admin/profile", headers=HEADERS)
    assert response.status_code == 200
    assert response.json()["profile"]["display_name"] == "TEST ONLY"
    assert response.headers["cache-control"] == "private, no-store"
    assert client.get("/api/v1/admin/profile", headers=HEADERS).json() == {"profile": None}


def test_saves_only_allowlisted_fields_with_version_and_request_id(application):
    def handler(request):
        assert request.url.path == "/rest/v1/rpc/admin_save_profile"
        assert json.loads(request.content) == {
            "p_profile": FIELDS,
            "p_expected_revision": 0,
            "p_request_id": REQUEST_ID,
        }
        return httpx.Response(200, json=RECORD)

    response = client_for(application, handler).put(
        "/api/v1/admin/profile", headers=HEADERS, json=body()
    )
    assert response.status_code == 200
    assert response.json()["profile"]["revision"] == 1


@pytest.mark.parametrize("method", ["GET", "PUT"])
def test_profile_endpoints_require_authentication(application, method):
    response = client_for(application, lambda request: pytest.fail("No RPC expected")).request(
        method, "/api/v1/admin/profile", json=body() if method == "PUT" else None
    )
    assert response.status_code == 401


def test_non_admin_cannot_save(application):
    response = client_for(
        application,
        lambda request: pytest.fail("No RPC expected"),
        "44444444-4444-4444-8444-444444444444",
    ).put("/api/v1/admin/profile", headers=HEADERS, json=body())
    assert response.status_code == 403


@pytest.mark.parametrize(
    "payload",
    [
        body(profile={**FIELDS, "display_name": " "}),
        body(profile={**FIELDS, "headline": "x" * 201}),
        body(profile={**FIELDS, "about_markdown": "x" * 20001}),
        body(profile={**FIELDS, "public_email": "bad email"}),
        body(profile={**FIELDS, "github_url": "javascript:alert(1)"}),
        body(profile={**FIELDS, "github_url": "https://user:pass@example.test"}),
        body(profile={**FIELDS, "status": "invalid"}),
        body(profile={**FIELDS, "role": "admin"}),
        body(expected_revision=True),
        body(expected_revision=-1),
        body(request_id="bad-id"),
        body(extra_field="not allowed"),
    ],
)
def test_invalid_requests_are_rejected_before_rpc(application, payload):
    response = client_for(application, lambda request: pytest.fail("No RPC expected")).put(
        "/api/v1/admin/profile", headers=HEADERS, json=payload
    )
    assert response.status_code == 422


@pytest.mark.parametrize(
    "code,status,expected",
    [
        ("40001", 409, 409),
        ("42501", 403, 403),
        ("22023", 400, 422),
        ("23514", 400, 422),
        ("PGRST202", 404, 503),
        ("unknown", 500, 503),
    ],
)
def test_database_errors_are_mapped_without_leaking_details(application, code, status, expected):
    response = client_for(
        application,
        lambda request: httpx.Response(
            status, json={"code": code, "message": "private SQL details"}
        ),
    ).put("/api/v1/admin/profile", headers=HEADERS, json=body())
    assert response.status_code == expected
    assert "private SQL" not in response.text


def test_rpc_unauthorized_requires_login(application):
    response = client_for(application, lambda request: httpx.Response(401)).get(
        "/api/v1/admin/profile", headers=HEADERS
    )
    assert response.status_code == 401


@pytest.mark.parametrize("payload", [{"revision": 1}, None, [], "invalid"])
def test_malformed_save_response_is_not_reported_as_success(application, payload):
    response = client_for(application, lambda request: httpx.Response(200, json=payload)).put(
        "/api/v1/admin/profile", headers=HEADERS, json=body()
    )
    assert response.status_code == 503


def test_transport_failure_preserves_uncertain_outcome(application):
    def handler(request):
        raise httpx.ReadTimeout("private timeout", request=request)

    response = client_for(application, handler).put(
        "/api/v1/admin/profile", headers=HEADERS, json=body()
    )
    assert response.status_code == 503
    assert "private timeout" not in response.text


def test_optional_blank_fields_are_normalized(application):
    def handler(request):
        data = json.loads(request.content)["p_profile"]
        assert data["location"] is None
        assert data["github_url"] is None
        return httpx.Response(200, json=RECORD)

    response = client_for(application, handler).put(
        "/api/v1/admin/profile",
        headers=HEADERS,
        json=body(profile={**FIELDS, "location": " ", "github_url": ""}),
    )
    assert response.status_code == 200
