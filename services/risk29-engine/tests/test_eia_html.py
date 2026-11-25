from datetime import date
from unittest.mock import AsyncMock

import pytest

from risk29_engine.scoring import SeriesPoint
from risk29_engine.sources import PublicSourceClient

HTML = """<h1>Cushing, OK WTI Spot Price FOB (Dollars per Barrel)</h1>
<table><tr><td>2026 Nov-16 to Nov-20</td><td>69</td><td>70</td>
<td>&nbsp;</td><td>72</td><td>73</td></tr></table>"""


def test_html_dates_and_missing_day():
    points = PublicSourceClient._parse_eia_wti_html(HTML, date(2026, 11, 19))
    assert [(p.date.day, p.value) for p in points] == [(16, 69), (17, 70), (19, 72)]


def test_html_wrong_benchmark():
    with pytest.raises(ValueError):
        PublicSourceClient._parse_eia_wti_html(HTML.replace("WTI", "Brent"), date(2026, 11, 25))


@pytest.mark.asyncio
async def test_xls_error_recovers_html(monkeypatch, caplog):
    client = PublicSourceClient()
    monkeypatch.setattr(client, "_get_bytes", AsyncMock(side_effect=ValueError("EIA WTI: missing header")))
    monkeypatch.setattr(client, "_get_text", AsyncMock(return_value=HTML))
    result = await client._extend_official_history("DCOILWTICO", [SeriesPoint(date(2026, 11, 17), 70)], date(2026, 11, 25))
    assert result[-1].date == date(2026, 11, 20)
    assert "missing header" in caplog.text
    assert "status=extended" in caplog.text
