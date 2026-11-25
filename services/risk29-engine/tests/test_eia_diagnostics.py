from datetime import date
from unittest.mock import AsyncMock

import pytest

from risk29_engine.scoring import SeriesPoint
from risk29_engine.sources import PublicSourceClient


class Sheet:
    ncols = 2

    def __init__(self, rows):
        self.rows = rows
        self.nrows = len(rows)

    def cell_value(self, row, col):
        return self.rows[row][col]


class Book:
    datemode = 0

    def __init__(self, rows):
        self.sheet = Sheet(rows)

    def sheets(self):
        return [self.sheet]


def workbook(monkeypatch, rows):
    monkeypatch.setattr("risk29_engine.sources.xlrd.open_workbook", lambda **kwargs: Book(rows))


HEADER = ["Date", "Cushing, OK WTI Spot Price FOB (Dollars per Barrel)"]
TODAY = date(2026, 11, 25)


def test_eia_validates_identity_and_filters_future(monkeypatch):
    workbook(monkeypatch, [["metadata", ""], HEADER, ["2026-11-24", 70.5],
                           ["2026-11-23", 69.5], ["2026-11-26", 71],
                           ["bad", 99], ["2026-11-24", 70.5]])
    result = PublicSourceClient._parse_eia_wti_workbook(b"fixture", TODAY)
    assert [p.date for p in result] == [date(2026, 11, 23), date(2026, 11, 24)]
    assert result[-1].source == "EIA Official"


@pytest.mark.parametrize("rows", [
    [["Date", "Brent Spot Price"], ["2026-11-24", 70]],
    [HEADER, ["2026-11-24", 70], ["2026-11-24", 71]],
    [HEADER, ["bad", "bad"]],
])
def test_eia_rejects_invalid_workbook(monkeypatch, rows):
    workbook(monkeypatch, rows)
    with pytest.raises(ValueError):
        PublicSourceClient._parse_eia_wti_workbook(b"fixture", TODAY)


@pytest.mark.asyncio
@pytest.mark.parametrize("price,status", [(70, "extended"), (72, "overlap_mismatch")])
async def test_eia_diagnostics(monkeypatch, caplog, price, status):
    client = PublicSourceClient()
    workbook(monkeypatch, [HEADER, ["2026-11-23", price], ["2026-11-24", 71]])
    monkeypatch.setattr(client, "_get_bytes", AsyncMock(return_value=b"fixture"))
    base = [SeriesPoint(date(2026, 11, 23), 70)]
    result = await client._extend_official_history("DCOILWTICO", base, TODAY)
    assert f"status={status}" in caplog.text
    assert len(result) == (2 if status == "extended" else 1)
