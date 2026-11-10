"""Run: python -m unittest discover -s risk29 -p 'test_validate_data_health.py'"""
import datetime as dt
import unittest

try:
    from risk29.validate_data_health import validate
except ImportError:
    from validate_data_health import validate


NOW = dt.datetime(2026, 11, 10, 1, 10, tzinfo=dt.timezone.utc)
STAMP = "2026-11-09T14:47:31+00:00"


def payloads():
    brief = {"schemaVersion": "1", "generatedAt": STAMP, "score": 46.8,
             "state": "watch", "confidence": "normal"}
    latest = {"schemaVersion": "1", "generatedAt": STAMP, "score": 46.8,
              "state": "watch", "signals": [
                  {"id": "vix", "freshness": "delayed", "asOf": "2026-11-05"},
                  {"id": "curve", "freshness": "fresh", "asOf": "2026-11-06"},
              ]}
    return brief, latest


class Risk29ValidatorTests(unittest.TestCase):
    def test_same_run_valid_but_delayed_flagged(self):
        b, l = payloads()
        result = validate(b, l, NOW)
        self.assertTrue(result["decisionAllowed"])
        self.assertEqual(result["delayed"], 1)
        self.assertEqual(result["usableCoveragePct"], 100)
        self.assertTrue(result["warnings"])

    def test_mismatched_run_fails_closed(self):
        b, l = payloads()
        l["generatedAt"] = "2026-11-09T14:48:00+00:00"
        self.assertFalse(validate(b, l, NOW)["decisionAllowed"])

    def test_stale_brief_fails_closed(self):
        b, l = payloads()
        b["generatedAt"] = l["generatedAt"] = "2026-11-08T00:00:00+00:00"
        result = validate(b, l, NOW)
        self.assertFalse(result["decisionAllowed"])
        self.assertIsNone(result["score"])

    def test_missing_score_fails_closed(self):
        b, l = payloads()
        del b["score"]
        self.assertFalse(validate(b, l, NOW)["decisionAllowed"])

    def test_missing_signals_fails_closed(self):
        b, l = payloads()
        del l["signals"]
        self.assertFalse(validate(b, l, NOW)["decisionAllowed"])

    def test_unknown_not_zero(self):
        b, l = payloads()
        l["signals"].append({"id": "x"})
        result = validate(b, l, NOW)
        self.assertEqual(result["unknown"], 1)
        self.assertEqual(result["usableCoveragePct"], 66.67)
        self.assertEqual(result["problemSignals"][0]["id"], "x")

    def test_data_health_conflict(self):
        b, l = payloads()
        b["dataHealth"] = {"totalSignals": 29}
        self.assertFalse(validate(b, l, NOW)["decisionAllowed"])


if __name__ == "__main__":
    unittest.main()
