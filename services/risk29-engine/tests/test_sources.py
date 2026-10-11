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



def test_gpr_date_parser_supports_yyyymmdd_and_iso_text():
    assert PublicSourceClient._parse_gpr_date(20261009, 0).isoformat() == "2026-10-09"
    assert PublicSourceClient._parse_gpr_date("2026-10-09", 0).isoformat() == "2026-10-09"


def test_market_breadth_parsers_validate_percent_and_directional_coverage():
    breadth_csv = """date,above_50d,above_200d
2026-10-01,40.0,41.15
2026-10-02,42.0,42.54
"""
    ad_csv = """date,advancers,unchanged,decliners
2026-10-01,296,3,204
2026-10-02,293,3,208
"""
    breadth = PublicSourceClient._parse_market_breadth_csv(breadth_csv)
    advancing = PublicSourceClient._parse_market_ad_csv(ad_csv)

    assert breadth[next(iter(breadth))] == pytest.approx(41.15)
    assert advancing[next(iter(advancing))] == pytest.approx(59.2)


def test_forward_pe_parser_and_percentile_points():
    raw = "date,forward_pe\n" + "\n".join(
        f"2020-01-{day:02d},{10 + day}" for day in range(1, 11)
    ) + "\n"
    points = PublicSourceClient._parse_forward_pe_csv(raw)
    assert len(points) == 10
    scored = PublicSourceClient._forward_pe_percentile_points(
        points,
        lookback=5,
        min_observations=5,
        output_points=3,
    )
    assert len(scored) == 3
    assert scored[-1].value == pytest.approx(90.0)


def test_forward_pe_percentile_fails_closed_on_short_history():
    points = PublicSourceClient._parse_forward_pe_csv(
        "date,forward_pe\n2026-10-08,20.1\n2026-10-09,20.2\n"
    )
    with pytest.raises(ValueError, match="insufficient history"):
        PublicSourceClient._forward_pe_percentile_points(
            points,
            lookback=5,
            min_observations=5,
        )
