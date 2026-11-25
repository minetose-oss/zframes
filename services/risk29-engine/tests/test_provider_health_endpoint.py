import importlib
import httpx
import pytest
from fastapi.testclient import TestClient
from risk29_engine.published import PublishedSnapshotClient

main = importlib.import_module("risk29_engine.main")
PAYLOAD = {"generatedAt": "2026-11-25T12:41:27+00:00",
           "providers": {"DCOILWTICO": {"providerHealth": "HEALTHY", "dataFreshness": "stale"}}}


@pytest.mark.parametrize("status,payload,expected", [
    (200, PAYLOAD, 200),
    (404, {}, 503),
    (200, {"providers": {}}, 503),
    (200, {"generatedAt": "2026-11-25", "providers": {}}, 503),
])
def test_provider_health_route(monkeypatch, status, payload, expected):
    def handler(request):
        assert request.url.path == "/risk29/provider-health.json"
        return httpx.Response(status, json=payload)
    monkeypatch.setattr(main, "published_client", PublishedSnapshotClient(
        "https://example.test/risk29", transport=httpx.MockTransport(handler)))
    response = TestClient(main.app).get("/risk29/provider-health.json")
    assert response.status_code == expected
    if expected == 200:
        assert response.json() == PAYLOAD
        assert response.headers["cache-control"] == "no-store"


def test_provider_health_unconfigured(monkeypatch):
    monkeypatch.setattr(main, "published_client", None)
    assert TestClient(main.app).get("/risk29/provider-health.json").status_code == 503
