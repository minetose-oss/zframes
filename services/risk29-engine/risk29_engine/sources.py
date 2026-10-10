from __future__ import annotations

import asyncio
import csv
import html
import io
import re
import time
from urllib.parse import urljoin
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from typing import Protocol

import httpx
import xlrd

from .scoring import SeriesPoint

FRED_URL = "https://fred.stlouisfed.org/graph/fredgraph.csv"
OFR_URL = "https://www.financialresearch.gov/financial-stress-index/data/fsi.csv"
LBMA_GOLD_URL = "https://prices.lbma.org.uk/json/gold_pm.json"
SHILLER_PAGE_URL = "https://shillerdata.com/"
TREASURY_URL = (
    "https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml"
    "?data=daily_treasury_yield_curve&field_tdr_date_value_month={yyyymm}"
)


class SourceClient(Protocol):
    async def fred(self, series_id: str) -> list[SeriesPoint]: ...
    async def treasury_curve(self) -> list[SeriesPoint]: ...
    async def ofr(self) -> list[SeriesPoint]: ...
    async def lbma_gold(self) -> list[SeriesPoint]: ...
    async def shiller(self, metric: str) -> list[SeriesPoint]: ...


@dataclass
class PublicSourceClient:
    timeout_seconds: float = 20.0
    retry_attempts: int = 2
    # Fetch FRED series concurrently. The request-level timeout is deliberately
    # much lower on Vercel, so queuing seven series behind a small semaphore can
    # exceed the serverless invocation limit even when each request times out
    # correctly. Eight slots cover the current seven FRED-backed signals.
    _fred_semaphore: asyncio.Semaphore = field(
        default_factory=lambda: asyncio.Semaphore(8), init=False, repr=False
    )
    _shiller_lock: asyncio.Lock = field(
        default_factory=asyncio.Lock, init=False, repr=False
    )
    _shiller_cache: dict[str, list[SeriesPoint]] | None = field(
        default=None, init=False, repr=False
    )
    _shiller_cache_loaded_at: float = field(default=0.0, init=False, repr=False)

    async def _get_text(self, url: str, *, params: dict[str, str] | None = None) -> str:
        timeout = httpx.Timeout(self.timeout_seconds, connect=min(10.0, self.timeout_seconds))
        last_error: Exception | None = None
        for attempt in range(max(1, self.retry_attempts)):
            try:
                async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
                    response = await client.get(
                        url,
                        params=params,
                        headers={
                            "User-Agent": "risk29-engine/0.1",
                            "Accept": "text/html,text/csv,text/plain,*/*",
                        },
                    )
                    response.raise_for_status()
                    return response.text
            except httpx.TransportError as exc:
                last_error = exc
                if attempt + 1 >= max(1, self.retry_attempts):
                    raise
                await asyncio.sleep(0.35 * (attempt + 1))
        assert last_error is not None
        raise last_error

    async def _get_json(self, url: str):
        timeout = httpx.Timeout(self.timeout_seconds, connect=min(10.0, self.timeout_seconds))
        last_error: Exception | None = None
        for attempt in range(max(1, self.retry_attempts)):
            try:
                async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
                    response = await client.get(
                        url,
                        headers={
                            "User-Agent": "risk29-engine/0.1",
                            "Accept": "application/json,*/*",
                        },
                    )
                    response.raise_for_status()
                    return response.json()
            except httpx.TransportError as exc:
                last_error = exc
                if attempt + 1 >= max(1, self.retry_attempts):
                    raise
                await asyncio.sleep(0.35 * (attempt + 1))
        assert last_error is not None
        raise last_error

    async def _get_bytes(self, url: str) -> bytes:
        timeout = httpx.Timeout(self.timeout_seconds, connect=min(10.0, self.timeout_seconds))
        last_error: Exception | None = None
        for attempt in range(max(1, self.retry_attempts)):
            try:
                async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
                    response = await client.get(
                        url,
                        headers={
                            "User-Agent": "risk29-engine/0.3",
                            "Accept": "application/vnd.ms-excel,application/octet-stream,*/*",
                        },
                    )
                    response.raise_for_status()
                    return response.content
            except httpx.HTTPError as exc:
                last_error = exc
                if attempt + 1 >= max(1, self.retry_attempts):
                    raise
                await asyncio.sleep(0.35 * (attempt + 1))
        assert last_error is not None
        raise last_error

    @staticmethod
    def _shiller_column_map(sheet) -> dict[str, int]:
        headers: dict[int, str] = {}
        upper = min(8, sheet.nrows)
        for column in range(sheet.ncols):
            parts = [
                str(sheet.cell_value(row, column)).strip()
                for row in range(1, upper)
                if str(sheet.cell_value(row, column)).strip()
            ]
            headers[column] = re.sub(r"\s+", " ", " ".join(parts)).strip().lower()

        def find(required: tuple[str, ...], forbidden: tuple[str, ...] = ()) -> int:
            matches = [
                column
                for column, text in headers.items()
                if text
                and all(token in text for token in required)
                and not any(token in text for token in forbidden)
            ]
            if not matches:
                raise ValueError(
                    "Shiller workbook layout changed; required column not found: "
                    + ", ".join(required)
                )
            return matches[0]

        return {
            "date": find(("date",), ("fraction",)),
            "cape": find(
                ("cyclically adjusted", "cape"),
                ("total return", "tr cape", "excess"),
            ),
            "excess_cape_yield": find(("excess cape yield",)),
        }

    async def _load_shiller_metrics(self) -> dict[str, list[SeriesPoint]]:
        # The workbook is monthly. Cache it for six hours so CAPE and ECY share
        # one download, while a long-lived process still picks up new releases.
        now_mono = time.monotonic()
        if (
            self._shiller_cache is not None
            and now_mono - self._shiller_cache_loaded_at < 6 * 60 * 60
        ):
            return self._shiller_cache

        async with self._shiller_lock:
            now_mono = time.monotonic()
            if (
                self._shiller_cache is not None
                and now_mono - self._shiller_cache_loaded_at < 6 * 60 * 60
            ):
                return self._shiller_cache

            page = await self._get_text(SHILLER_PAGE_URL)
            candidates = re.findall(
                r'href=["\']([^"\']*ie_data\.xls[^"\']*)["\']',
                page,
                flags=re.IGNORECASE,
            )
            if not candidates:
                raise ValueError("Shiller data page: ie_data.xls download link not found")

            download_url = urljoin(
                SHILLER_PAGE_URL,
                html.unescape(candidates[0]),
            )
            workbook_bytes = await self._get_bytes(download_url)
            workbook = xlrd.open_workbook(file_contents=workbook_bytes)
            sheet = workbook.sheet_by_name("Data")
            columns = self._shiller_column_map(sheet)

            metrics: dict[str, list[SeriesPoint]] = {
                "cape": [],
                "excess_cape_yield": [],
            }
            for row in range(sheet.nrows):
                raw_date = sheet.cell_value(row, columns["date"])
                if not isinstance(raw_date, (int, float)):
                    continue
                encoded = float(raw_date)
                year = int(encoded)
                month = int(round((encoded - year) * 100))
                if year < 1871 or not 1 <= month <= 12:
                    continue
                observed = date(year, month, 1)

                for metric in metrics:
                    raw_value = sheet.cell_value(row, columns[metric])
                    if not isinstance(raw_value, (int, float)):
                        continue
                    value = float(raw_value)
                    if metric == "cape" and not 3.0 <= value <= 80.0:
                        continue
                    if metric == "excess_cape_yield" and not -20.0 <= value <= 40.0:
                        continue
                    metrics[metric].append(SeriesPoint(observed, value))

            if len(metrics["cape"]) < 1000:
                raise ValueError("Shiller CAPE: too few usable observations")
            if len(metrics["excess_cape_yield"]) < 1000:
                raise ValueError("Shiller Excess CAPE Yield: too few usable observations")

            self._shiller_cache = metrics
            self._shiller_cache_loaded_at = time.monotonic()
            return metrics

    async def shiller(self, metric: str) -> list[SeriesPoint]:
        metrics = await self._load_shiller_metrics()
        if metric not in metrics:
            raise ValueError(f"unknown Shiller metric {metric}")
        return metrics[metric]

    async def fred(self, series_id: str) -> list[SeriesPoint]:
        # Risk29 only needs enough daily history for MA200 / 20-session momentum.
        # Asking FRED for the full lifetime of each series is needlessly heavy in
        # a serverless function and was observed to cause ReadTimeouts on Vercel.
        today = datetime.now(timezone.utc).date()
        start = today - timedelta(days=550)
        async with self._fred_semaphore:
            text = await self._get_text(
                FRED_URL,
                params={
                    "id": series_id,
                    "cosd": start.isoformat(),
                    "coed": today.isoformat(),
                },
            )
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
