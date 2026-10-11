import pytest

from risk29_engine.sources import PublicSourceClient


def test_shiller_excess_cape_yield_is_normalized_to_percent():
    assert PublicSourceClient._normalize_shiller_value(
        "excess_cape_yield",
        0.0056,
    ) == pytest.approx(0.56)


def test_shiller_cape_is_not_rescaled():
    assert PublicSourceClient._normalize_shiller_value(
        "cape",
        40.7,
    ) == pytest.approx(40.7)



def test_policy_event_severity_is_conservative_and_deterministic():
    client = PublicSourceClient()
    assert client._policy_event_severity("Routine research publication") == 10
    assert client._policy_event_severity("Federal Reserve issues FOMC statement") == 35
    assert client._policy_event_severity("Central bank changes policy rate") == 70
    assert client._policy_event_severity("Emergency rate cut and swap line") == 90


def test_policy_feed_parser_reads_rss_and_atom_dates():
    rss = """<rss><channel><item>
      <title>Emergency rate cut</title>
      <description>Policy action</description>
      <pubDate>Fri, 09 Oct 2026 12:00:00 GMT</pubDate>
    </item></channel></rss>"""
    events = PublicSourceClient._parse_policy_feed_events(rss)
    assert len(events) == 1
    assert events[0][0].isoformat() == "2026-10-09"
    assert events[0][1] == 90
