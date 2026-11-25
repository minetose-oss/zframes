"""Run: python -m unittest discover -s tests -p 'test_risk29_health_validator.py'"""
import unittest
from datetime import datetime, timedelta, timezone
from scripts.risk29_health_validator import validate

NOW = datetime(2026, 11, 18, 1, 0, tzinfo=timezone.utc)


def fixture():
    stamp = (NOW - timedelta(hours=1)).isoformat()
    brief = {"generatedAt": stamp, "score": 47.1, "state": "watch", "confidence": "normal"}
    latest = {"generatedAt": stamp, "score": 47.1, "state": "watch",
              "signals": [{"id": f"s{i}", "category": "macro", "asOf": "2026-11-17",
                           "freshness": "fresh", "ageSeconds": 3600, "reason": None}
                          for i in range(29)]}
    return brief, latest


class HealthValidatorTests(unittest.TestCase):
    def test_valid(self):
        b, l = fixture()
        r = validate(b, l, now=NOW)
        self.assertEqual(r["decisionGate"], "PASS")
        self.assertEqual(r["freshCoveragePct"], 100)
        self.assertEqual(r["currentScore"], 47.1)

    def test_stale_payload_fails_closed(self):
        b, l = fixture()
        old = (NOW - timedelta(hours=25)).isoformat()
        b["generatedAt"] = l["generatedAt"] = old
        r = validate(b, l, now=NOW)
        self.assertEqual(r["decisionGate"], "FAIL")
        self.assertIsNone(r["currentScore"])

    def test_mismatch_fails_closed(self):
        b, l = fixture()
        l["score"] = 99
        r = validate(b, l, now=NOW)
        self.assertEqual(r["consistency"], "CONSISTENCY WARNING")
        self.assertIsNone(r["currentScore"])

    def test_missing_signal_is_not_zero(self):
        b, l = fixture()
        l["signals"].pop()
        r = validate(b, l, now=NOW)
        self.assertEqual(r["decisionGate"], "FAIL")
        self.assertEqual(r["totalSignals"], 28)

    def test_degraded_stale_signal_warns(self):
        b, l = fixture()
        b["confidence"] = "degraded"
        l["signals"][0]["freshness"] = "stale"
        r = validate(b, l, now=NOW)
        self.assertEqual(r["decisionGate"], "WARNING")
        self.assertEqual(r["counts"]["stale"], 1)
        self.assertEqual(r["freshCoveragePct"], round(100 * 28 / 29, 2))

    def test_previous_only_when_older(self):
        b, l = fixture()
        previous = {"generatedAt": (NOW - timedelta(days=1)).isoformat(),
                    "score": 44.09, "state": "watch"}
        r = validate(b, l, now=NOW, previous=previous)
        self.assertEqual(r["comparison"]["scoreDelta"], 3.01)
        self.assertEqual(validate(b, l, now=NOW)["comparison"]["status"], "COMPARISON UNAVAILABLE")


if __name__ == "__main__":
    unittest.main()


class ProductionSyncTests(unittest.TestCase):
    def test_sync_exact_match(self):
        from scripts.risk29_health_probe import compare_sync
        self.assertEqual(compare_sync({"generatedAt": "a"}, {"generatedAt": "a"})["status"], "PASS")

    def test_sync_mismatch_and_unknown(self):
        from scripts.risk29_health_probe import compare_sync
        self.assertEqual(compare_sync({"generatedAt": "a"}, {"generatedAt": "b"})["status"], "MISMATCH")
        self.assertEqual(compare_sync({}, {})["status"], "UNKNOWN")


class ProviderHealthSyncTests(unittest.TestCase):
    def test_provider_sync(self):
        from scripts.risk29_health_probe import compare_provider_sync
        payload = {"generatedAt": "a", "providers": {"WTI": {"dataFreshness": "stale"}}}
        self.assertEqual(compare_provider_sync(payload, payload, {"generatedAt": "a"})["status"], "PASS")
        self.assertEqual(compare_provider_sync(payload, payload, {"generatedAt": "b"})["status"], "MISMATCH")
        self.assertEqual(compare_provider_sync(payload, {"generatedAt": "a", "providers": {}}, {"generatedAt": "a"})["status"], "MISMATCH")
        self.assertEqual(compare_provider_sync({}, {}, {})["status"], "UNKNOWN")

    def test_probe_missing_live_provider_endpoint(self):
        from unittest.mock import patch
        from urllib.error import HTTPError
        from scripts import risk29_health_probe as probe
        brief, latest = fixture()
        stamp = datetime.now(timezone.utc).isoformat()
        brief["generatedAt"] = latest["generatedAt"] = stamp
        def fetch(url):
            if url.endswith("provider-health.json"):
                if url.startswith(probe.LIVE):
                    raise HTTPError(url, 404, "Not Found", {}, None)
                return {"generatedAt": stamp, "providers": {}}
            return brief if url.endswith("brief-th.json") else latest
        with patch.object(probe, "get_json", side_effect=fetch):
            result = probe.probe()
        self.assertEqual(result["decisionGate"], "FAIL")
        self.assertEqual(result["liveApiHealth"], "FAIL")
        self.assertEqual(result["endpoints"]["live/provider-health.json"]["httpStatus"], 404)
