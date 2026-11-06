import httpx
import pytest
from fastapi.testclient import TestClient

from app.auth import get_auth_client
from app.main import create_app

ADMIN = "11111111-1111-4111-8111-111111111111"
OTHER = "22222222-2222-4222-8222-222222222222"


@pytest.fixture
def configured(monkeypatch):
    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setenv("SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test_fixture")
    monkeypatch.setenv("ADMIN_USER_ID", ADMIN)
    return create_app()


def client_for(application, handler):
    async def override():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            yield client

    application.dependency_overrides[get_auth_client] = override
    return TestClient(application)


def test_admin_identity_is_verified_remotely(configured):
    def handler(request):
        assert str(request.url) == "https://example.supabase.co/auth/v1/user"
        assert request.headers["authorization"] == "Bearer test-access-token"
        assert request.headers["apikey"] == "sb_publishable_test_fixture"
        return httpx.Response(200, json={"id": ADMIN, "is_anonymous": False})

    response = client_for(configured, handler).get(
        "/api/v1/admin/me", headers={"Authorization": "Bearer test-access-token"}
    )
    assert response.status_code == 200
    assert response.json() == {"user_id": ADMIN, "role": "admin"}
    assert response.headers["cache-control"] == "private, no-store"


@pytest.mark.parametrize("header", [None, "Basic abc", "Bearer", "Bearer " + "a" * 8193])
def test_missing_or_malformed_credentials_are_unauthorized(configured, header):
    def handler(request):
        pytest.fail("No remote call should be made")

    headers = {} if header is None else {"Authorization": header}
    response = client_for(configured, handler).get("/api/v1/admin/me", headers=headers)
    assert response.status_code == 401
    assert response.headers["www-authenticate"] == "Bearer"
    assert response.headers["cache-control"] == "private, no-store"


@pytest.mark.parametrize("status", [401, 403])
def test_invalid_or_expired_token_is_unauthorized(configured, status):
    response = client_for(
        configured,
        lambda request: httpx.Response(status, json={"message": "private upstream details"}),
    ).get("/api/v1/admin/me", headers={"Authorization": "Bearer forged"})
    assert response.status_code == 401
    assert "private upstream" not in response.text


@pytest.mark.parametrize(
    "user",
    [
        {"id": OTHER, "user_metadata": {"role": "admin"}},
        {"id": ADMIN, "is_anonymous": True},
    ],
)
def test_authenticated_non_admin_is_forbidden(configured, user):
    response = client_for(configured, lambda request: httpx.Response(200, json=user)).get(
        "/api/v1/admin/me", headers={"Authorization": "Bearer valid-other-user"}
    )
    assert response.status_code == 403


@pytest.mark.parametrize("status", [429, 500, 503, 302])
def test_upstream_failure_is_not_treated_as_auth_success(configured, status):
    response = client_for(configured, lambda request: httpx.Response(status)).get(
        "/api/v1/admin/me", headers={"Authorization": "Bearer test-token"}
    )
    assert response.status_code == 503


@pytest.mark.parametrize("payload", [{}, {"id": "invalid"}, [], None])
def test_invalid_identity_response_fails_closed(configured, payload):
    response = client_for(configured, lambda request: httpx.Response(200, json=payload)).get(
        "/api/v1/admin/me", headers={"Authorization": "Bearer test-token"}
    )
    assert response.status_code == 503


def test_transport_error_fails_closed(configured):
    def handler(request):
        raise httpx.ConnectError("private connection error", request=request)

    response = client_for(configured, handler).get(
        "/api/v1/admin/me", headers={"Authorization": "Bearer test-token"}
    )
    assert response.status_code == 503
    assert "private connection" not in response.text


@pytest.mark.parametrize(
    "name,value",
    [
        ("SUPABASE_URL", ""),
        ("SUPABASE_URL", "http://example.supabase.co"),
        ("SUPABASE_URL", "https://user:password@example.supabase.co"),
        ("SUPABASE_PUBLISHABLE_KEY", "sb_secret_wrong_key"),
        ("ADMIN_USER_ID", ""),
        ("ADMIN_USER_ID", "not-a-uuid"),
    ],
)
def test_bad_configuration_fails_closed(configured, monkeypatch, name, value):
    monkeypatch.setenv(name, value)
    response = client_for(configured, lambda request: pytest.fail("No upstream call expected")).get(
        "/api/v1/admin/me", headers={"Authorization": "Bearer test-token"}
    )
    assert response.status_code == 503
