from fastapi.testclient import TestClient

from app.main import create_app


def test_liveness_reports_process_running(monkeypatch):
    monkeypatch.delenv("ALLOWED_ORIGINS", raising=False)
    response = TestClient(create_app()).get("/health/live")
    assert response.status_code == 200
    assert response.json() == {"status": "alive"}


def test_readiness_reports_only_implemented_api_check(monkeypatch):
    monkeypatch.delenv("ALLOWED_ORIGINS", raising=False)
    response = TestClient(create_app()).get("/health/ready")
    assert response.status_code == 200
    assert response.json() == {"status": "ready", "checks": {"api": "ok"}}
    assert response.headers["cache-control"] == "no-store"


def test_local_frontend_can_read_health(monkeypatch):
    monkeypatch.delenv("ALLOWED_ORIGINS", raising=False)
    response = TestClient(create_app()).get(
        "/health/ready", headers={"Origin": "http://localhost:3000"}
    )
    assert response.headers["access-control-allow-origin"] == "http://localhost:3000"


def test_other_origins_fail_preflight(monkeypatch):
    monkeypatch.delenv("ALLOWED_ORIGINS", raising=False)
    response = TestClient(create_app()).options(
        "/health/ready",
        headers={"Origin": "https://untrusted.example", "Access-Control-Request-Method": "GET"},
    )
    assert response.status_code == 400
    assert "access-control-allow-origin" not in response.headers


def test_configured_origin_replaces_local_default(monkeypatch):
    monkeypatch.setenv("ALLOWED_ORIGINS", " https://portfolio.example, https://preview.example ")
    client = TestClient(create_app())
    response = client.get("/health/ready", headers={"Origin": "https://portfolio.example"})
    assert response.headers["access-control-allow-origin"] == "https://portfolio.example"
    response = client.get("/health/ready", headers={"Origin": "http://localhost:3000"})
    assert "access-control-allow-origin" not in response.headers
