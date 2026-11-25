from datetime import date
from unittest.mock import patch

import pytest

from risk29_engine.sources import PublicSourceClient


TITLE = "Cushing, OK WTI Spot Price FOB (Dollars per Barrel)"


class Sheet:
    def __init__(self, name, rows):
        self.name = name
        self.rows = rows
        self.nrows = len(rows)
        self.ncols = len(rows[0])

    def cell_value(self, row, col):
        return self.rows[row][col]


class Book:
    datemode = 0

    def __init__(self, sheets):
        self._sheets = sheets

    def sheets(self):
        return self._sheets


def test_verified_workbook_structure():
    meta = Sheet("Contents", [["", TITLE]])
    data = Sheet("Data 1", [
        ["Back to Contents", "Data 1: " + TITLE],
        ["Sourcekey", "RWTC"],
        ["Date", TITLE],
        [31414.0, 25.56],
        [31415.0, 26.0],
    ])
    with patch("risk29_engine.sources.xlrd.open_workbook", return_value=Book([meta, data])):
        points = PublicSourceClient._parse_eia_wti_workbook(b"", date(2026, 11, 25))
    assert [(p.date, p.value) for p in points] == [
        (date(1986, 1, 2), 25.56), (date(1986, 1, 3), 26.0)
    ]
    with patch("risk29_engine.sources.xlrd.open_workbook", return_value=Book([meta, data, data])):
        with pytest.raises(ValueError, match="ambiguous"):
            PublicSourceClient._parse_eia_wti_workbook(b"", date(2026, 11, 25))
    with patch("risk29_engine.sources.xlrd.open_workbook", return_value=Book([meta])):
        with pytest.raises(ValueError, match="missing"):
            PublicSourceClient._parse_eia_wti_workbook(b"", date(2026, 11, 25))
