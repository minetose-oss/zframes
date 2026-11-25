from datetime import date, datetime, timezone

from risk29_engine.market_calendar import market_freshness


def test_latest_close():
    now = datetime(2026, 11, 25, 2, tzinfo=timezone.utc)
    assert market_freshness(date(2026, 11, 24), now, "fresh") == ("fresh", None)
    assert market_freshness(date(2026, 11, 23), now, "fresh")[0] == "delayed"
    assert market_freshness(date(2026, 11, 20), now, "fresh")[0] == "stale"


def test_thanksgiving_and_early_close():
    now = datetime(2026, 11, 27, 17, tzinfo=timezone.utc)
    assert market_freshness(date(2026, 11, 25), now, "fresh") == ("fresh", None)
    now = datetime(2026, 11, 27, 20, tzinfo=timezone.utc)
    assert market_freshness(date(2026, 11, 25), now, "fresh")[0] == "delayed"
