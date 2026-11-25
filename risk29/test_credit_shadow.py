import unittest
from datetime import date, datetime, timezone
from urllib.error import URLError

from credit_shadow import CAPEX, OCF, fundamentals, observe

AS_OF = date(2026, 11, 25)
FACT = {
    "start": "2026-01-01", "end": "2026-09-30", "filed": "2026-11-03",
    "accn": "0000000001-26-000001", "form": "10-Q", "val": 100,
}


def sample(ocf, capex):
    return {"facts": {"us-gaap": {OCF: {"units": {"USD": ocf}},
                                  CAPEX: {"units": {"USD": capex}}}}}


class CreditShadowTest(unittest.TestCase):
    def test_same_filing_fcf_and_ratio(self):
        out = fundamentals(sample([FACT], [{**FACT, "val": 40}]), 1, AS_OF)
        self.assertEqual(out["freeCashFlowUsd"], 60)
        self.assertAlmostEqual(out["capexToFcfRatio"], 40 / 60)
        self.assertEqual(out["filedAt"], "2026-11-03")

    def test_period_and_filing_mismatch(self):
        for changes in ({"start": "2026-07-01"}, {"accn": "0000000001-26-000002"}):
            with self.subTest(changes=changes):
                out = fundamentals(sample([FACT], [{**FACT, **changes}]), 1, AS_OF)
                self.assertEqual(out["status"], "DATA GAP")

    def test_negative_fcf_does_not_make_ratio(self):
        out = fundamentals(sample([FACT], [{**FACT, "val": 120}]), 1, AS_OF)
        self.assertEqual(out["freeCashFlowUsd"], -20)
        self.assertIsNone(out["capexToFcfRatio"])

    def test_conflict_and_future_filing_rejected(self):
        out = fundamentals(sample([FACT, {**FACT, "val": 101}], [FACT]), 1, AS_OF)
        self.assertEqual(out["status"], "DATA GAP")
        out = fundamentals(sample([FACT], [FACT]), 1, date(2026, 11, 2))
        self.assertEqual(out["status"], "DATA GAP")

    def test_available_sec_does_not_enable_buy(self):
        def fixture(url):
            if "companyfacts" in url:
                return sample([FACT], [FACT])
            return {"filings": {"recent": {
                "form": ["8-K"], "items": ["1.01,2.03"], "filingDate": ["2026-11-03"],
                "accessionNumber": [FACT["accn"]],
            }}}

        out = observe(fixture, now=datetime(2026, 11, 25, tzinfo=timezone.utc))
        self.assertEqual(out["coverage"]["fundamentalsObserved"], 4)
        self.assertEqual(len(out["issuers"]["ORCL"]["refinancing"]["filings"]), 1)
        self.assertEqual(out["status"], "CREDIT DATA GAP")
        self.assertFalse(out["buySignalEligible"])

    def test_network_failure_preserves_unknown(self):
        def unavailable(_):
            raise URLError("timeout")

        out = observe(unavailable)
        self.assertEqual(out["coverage"]["fundamentalsObserved"], 0)
        self.assertEqual(out["issuers"]["ORCL"]["fundamentals"]["status"], "UNAVAILABLE")
        self.assertFalse(out["buySignalEligible"])
