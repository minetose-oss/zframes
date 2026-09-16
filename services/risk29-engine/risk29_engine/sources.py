from __future__ import annotations

import csv
import io
import re
from dataclasses import dataclass
from datetime import date, datetime, timezone
from typing import Protocol

import httpx

from .scoring import SeriesPoint

FRED_URL = "https://fred.stlouisfed.org/graph/fredgraph.csv"
OFR_URL = "https://www.financialresearch.gov/financial-stress-index/data/fsi.csv"
LBMA_GOLD_URL = "https://prices.lbma.org.uk/json/gold_pm.json"
TREASURY_URL = (
    "https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml"
    "?data=daily_treasury_yield_curve&field_tdr_date_value_month={yyyymm}"
)


class SourceClient(Protocol):
    async def fred(self, series_id: str) -> list[SeriesPoint]: ...
    async def treasury_curve(self) -> list[SeriesPoint]: ...
    async def ofr(self) -> list[SeriesPoint]: ...
    async def lbma_gold(self) -> list[SeriesPoint]: ...


@dataclass
class PublicSourceClient:
    timeout_seconds: float = 20.0

    async def _get_text(self, url: str, *, params: dict[str, str] | None = None) -> str:
        timeout = httpx.Timeout(self.timeout_seconds)
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
            response = await client.get(url, params=params, headers={"User-Agent": "risk29-engine/0.1"})
            response.raise_for_status()
            return response.text

    async def _get_json(self, url: str):
        timeout = httpx.Timeout(self.timeout_seconds)
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
            response = await client.get(url, headers={"User-Agent": "risk29-engine/0.1"})
            response.raise_for_status()
            return response.json()

    async def fred(self, series_id: str) -> list[SeriesPoint]:
        text = await self._get_text(FRED_URL, params={"id": series_id})
        rows = csv.reader(io.StringIO(text))
        header = next(rows, None)
        if not header or len(header) < 2:
            raise ValueError(f"FRED {series_id}: unexpected CSV header")
        points: list[SeriesPoint] = []
        for row in rows:
            if len(row) < 2 or row[1].strip() in {"", "."}:
                continue
            try:
                observed = date.fromisoformat(row[0].strip())
                value = float(row[1])
            except (ValueError, TypeError):
                continue
            points.append(SeriesPoint(observed, value))
        if not points:
            raise ValueError(f"FRED {series_id}: no usable observations")
        points.sort(key=lambda point: point.date)
        return points

    async def treasury_curve(self) -> list[SeriesPoint]:
        now = datetime.now(timezone.utc)
        for month_back in (0, 1):
            year = now.year
            month = now.month - month_back
            if month <= 0:
                year -= 1
                month += 12
            text = await self._get_text(TREASURY_URL.format(yyyymm=f"{year:04d}{month:02d}"))
            spread = self._parse_treasury_spread(text)
            if spread:
                return spread
        raise ValueError("Treasury curve: no recent 2Y/10Y observations")

    @staticmethod
    def _parse_treasury_spread(xml: str) -> list[SeriesPoint]:
        blocks = re.findall(r"<m:properties>[\s\S]*?</m:properties>", xml)
        points: list[SeriesPoint] = []
        for block in blocks:
            date_match = re.search(r"<d:NEW_DATE[^>]*>([^<]+)</d:NEW_DATE>", block)
            two_match = re.search(r"<d:BC_2YEAR[^>]*>([^<]*)</d:BC_2YEAR>", block)
            ten_match = re.search(r"<d:BC_10YEAR[^>]*>([^<]*)</d:BC_10YEAR>", block)
            if not date_match or not two_match or not ten_match:
                continue
            try:
                observed = date.fromisoformat(date_match.group(1)[:10])
                spread = float(ten_match.group(1)) - float(two_match.group(1))
            except ValueError:
                continue
            points.append(SeriesPoint(observed, spread))
        points.sort(key=lambda point: point.date)
        return points

    async def ofr(self) -> list[SeriesPoint]:
        text = await self._get_text(OFR_URL)
        rows = csv.reader(io.StringIO(text))
        next(rows, None)
        points: list[SeriesPoint] = []
        for row in rows:
            if len(row) < 2:
                continue
            try:
                observed = date.fromisoformat(row[0].strip())
                value = float(row[1])
            except (ValueError, TypeError):
                continue
            points.append(SeriesPoint(observed, value))
        if not points:
            raise ValueError("OFR FSI: no usable observations")
        points.sort(key=lambda point: point.date)
        return points

    async def lbma_gold(self) -> list[SeriesPoint]:
        body = await self._get_json(LBMA_GOLD_URL)
        if not isinstance(body, list):
            raise ValueError("LBMA gold: unexpected response shape")
        points: list[SeriesPoint] = []
        for row in body:
            if not isinstance(row, dict):
                continue
            values = row.get("v")
            try:
                observed = date.fromisoformat(str(row.get("d")))
                value = float(values[0]) if isinstance(values, list) and values else None
            except (ValueError, TypeError, IndexError):
                continue
            if value is None or value <= 0:
                continue
            points.append(SeriesPoint(observed, value))
        if not points:
            raise ValueError("LBMA gold: no usable observations")
        points.sort(key=lambda point: point.date)
        return points
