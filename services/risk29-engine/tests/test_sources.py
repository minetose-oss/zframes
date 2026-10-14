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


def test_cftc_parser_normalizes_leveraged_net_by_open_interest():
    raw = """date,all,am_long,am_short,am_net,lev_long,lev_short,lev_net
2026-09-29,2000000,1100000,-200000,900000,120000,-500000,-380000
2026-10-06,1900000,1090000,-190000,900000,110000,-530000,-420000
"""
    points = PublicSourceClient._parse_cftc_sp500_tff_csv(raw)
    assert len(points) == 2
    assert points[0].value == pytest.approx(-19.0)
    assert points[1].value == pytest.approx(-22.1052631579)


def test_rolling_zscore_points_returns_signed_zscore():
    raw = "date,all,am_long,am_short,am_net,lev_long,lev_short,lev_net\n"
    rows = []
    for i in range(1, 61):
        # Keep open interest fixed and move leveraged net lower each week.
        rows.append(
            f"2025-{1 + (i - 1)//5:02d}-{1 + (i - 1)%5:02d},1000000,0,0,0,0,0,{-100000 - i*1000}"
        )
    points = PublicSourceClient._parse_cftc_sp500_tff_csv(raw + "\n".join(rows) + "\n")
    scored = PublicSourceClient._rolling_zscore_points(
        points,
        lookback=52,
        min_observations=20,
        output_points=3,
    )
    assert len(scored) == 3
    assert scored[-1].value < 0


def test_cboe_put_call_parser_reads_official_table_and_session_date():
    page = """
    <div data-date="2026-10-09"></div>
    <table>
      <tr><td>TOTAL PUT/CALL RATIO</td><td class="value">0.82</td></tr>
      <tr><td>INDEX PUT/CALL RATIO</td><td>1.13</td></tr>
    </table>
    """
    points = PublicSourceClient._parse_cboe_put_call_html(page)
    assert len(points) == 1
    assert points[0].date.isoformat() == "2026-10-09"
    assert points[0].value == pytest.approx(0.82)


def test_cboe_put_call_parser_fails_closed_without_total_ratio():
    with pytest.raises(ValueError, match="total ratio not found"):
        PublicSourceClient._parse_cboe_put_call_html(
            '<div data-date="2026-10-09">INDEX PUT/CALL RATIO 1.13</div>'
        )


def test_aaii_parser_returns_bull_minus_bear_spread():
    page = """
    <table>
      <tr><td>Oct 7</td><td>40.3%</td><td>20.8%</td><td>39.0%</td></tr>
      <tr><td>Sep 30</td><td>34.6%</td><td>18.9%</td><td>46.5%</td></tr>
      <tr><td>Sep 23</td><td>32.7%</td><td>19.2%</td><td>48.1%</td></tr>
    </table>
    """
    from datetime import date

    points = PublicSourceClient._parse_aaii_sentiment_html(
        page,
        today=date(2026, 10, 11),
    )
    assert [point.date.isoformat() for point in points] == [
        "2026-09-23",
        "2026-09-30",
        "2026-10-07",
    ]
    assert points[-1].value == pytest.approx(1.3)


def test_aaii_parser_handles_year_boundary():
    page = """
    <table>
      <tr><td>Jan 7</td><td>40.0%</td><td>20.0%</td><td>40.0%</td></tr>
      <tr><td>Dec 31</td><td>30.0%</td><td>20.0%</td><td>50.0%</td></tr>
    </table>
    """
    from datetime import date

    points = PublicSourceClient._parse_aaii_sentiment_html(
        page,
        today=date(2027, 1, 8),
    )
    assert points[0].date.isoformat() == "2026-12-31"
    assert points[1].date.isoformat() == "2027-01-07"
