from __future__ import annotations

import asyncio
import csv
import html
import io
import re
import time
import xml.etree.ElementTree as ET
from email.utils import parsedate_to_datetime
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
GPR_DAILY_URL = "https://www.matteoiacoviello.com/gpr_files/data_gpr_daily_recent.xls"
GPR_DAILY_MIRROR_URL = "https://raw.githubusercontent.com/iacoviel/iacoviel.github.io/master/gpr_files/data_gpr_daily_recent.xls"
GPR_DAILY_URLS = (GPR_DAILY_URL, GPR_DAILY_MIRROR_URL)
MARKET_BREADTH_CSV_URL = (
    "https://raw.githubusercontent.com/AlphaLabX1/forward-pe-viewer/"
    "main/data/sp500_breadth.csv"
)
MARKET_AD_CSV_URL = (
    "https://raw.githubusercontent.com/AlphaLabX1/forward-pe-viewer/"
    "main/data/sp500_ad.csv"
)
MARKET_BREADTH_SOURCE_URL = (
    "https://github.com/AlphaLabX1/forward-pe-viewer/tree/main/data"
)
FORWARD_PE_CSV_URL = (
    "https://raw.githubusercontent.com/AlphaLabX1/forward-pe-viewer/"
    "main/data/20052_sandp_500.csv"
)
FORWARD_PE_SOURCE_URL = (
    "https://github.com/AlphaLabX1/forward-pe-viewer/blob/main/"
    "data/20052_sandp_500.csv"
)
FED_POLICY_RSS_URL = "https://www.federalreserve.gov/feeds/press_monetary.xml"
ECB_POLICY_RSS_URL = "https://www.ecb.europa.eu/rss/press.html"
BOJ_POLICY_RSS_URL = "https://www.boj.or.jp/en/rss/whatsnew.xml"
POLICY_RSS_URLS = (FED_POLICY_RSS_URL, ECB_POLICY_RSS_URL, BOJ_POLICY_RSS_URL)
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
    async def gpr_geopolitical_shock(self) -> list[SeriesPoint]: ...
    async def policy_regime_shock(self) -> list[SeriesPoint]: ...
    async def market_breadth(self) -> list[SeriesPoint]: ...
    async def sp500_forward_pe_percentile(self) -> list[SeriesPoint]: ...


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
    _gpr_lock: asyncio.Lock = field(
        default_factory=asyncio.Lock, init=False, repr=False
    )
    _gpr_cache: list[SeriesPoint] | None = field(default=None, init=False, repr=False)
    _gpr_cache_loaded_at: float = field(default=0.0, init=False, repr=False)

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

    async def _get_json(self, url: str, *, params: dict[str, str] | None = None):
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

    @staticmethod
    def _normalize_shiller_value(metric: str, value: float) -> float:
        # Shiller stores Excess CAPE Yield as a decimal fraction in ie_data.xls
        # (for example 0.0056 means 0.56%). Risk29's percent unit is expressed
        # in percentage points, matching the rest of the engine.
        if metric == "excess_cape_yield":
            return value * 100.0
        return value

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
                    value = self._normalize_shiller_value(
                        metric,
                        float(raw_value),
                    )
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


    @staticmethod
    def _gpr_column_map(sheet) -> tuple[int, int, int]:
        for row in range(min(20, sheet.nrows)):
            labels = {
                column: re.sub(
                    r"\s+",
                    " ",
                    str(sheet.cell_value(row, column)).strip(),
                ).upper()
                for column in range(sheet.ncols)
            }
            gpr_columns = [
                column for column, label in labels.items() if label == "GPRD"
            ]
            date_columns = [
                column
                for column, label in labels.items()
                if label in {"DATE", "DAY", "OBSERVATION DATE", "OBSERVATION_DATE"}
                or (label.endswith("DATE") and "UPDATE" not in label)
            ]
            if gpr_columns and date_columns:
                return row, date_columns[0], gpr_columns[0]
        raise ValueError("GPR workbook layout changed; DATE/GPRD columns not found")

    @staticmethod
    def _parse_gpr_date(raw: object, datemode: int) -> date | None:
        if isinstance(raw, (int, float)):
            numeric = float(raw)
            if numeric >= 10_000_000:
                text = str(int(round(numeric)))
                try:
                    return datetime.strptime(text, "%Y%m%d").date()
                except ValueError:
                    return None
            try:
                return xlrd.xldate_as_datetime(numeric, datemode).date()
            except (ValueError, OverflowError, TypeError):
                return None

        text = str(raw or "").strip()
        for fmt in ("%Y-%m-%d", "%Y%m%d", "%m/%d/%Y", "%d/%m/%Y"):
            try:
                return datetime.strptime(text[:10] if fmt == "%Y-%m-%d" else text, fmt).date()
            except ValueError:
                continue
        return None

    async def gpr_geopolitical_shock(self) -> list[SeriesPoint]:
        """
        Load the Caldara-Iacoviello daily Geopolitical Risk index (GPRD).

        This is preferable to an ad-hoc news keyword count for production:
        the published index is academically documented, newspaper-normalized,
        and updated weekly. A GitHub mirror is used only as a transport fallback
        for the same source workbook.
        """
        now_mono = time.monotonic()
        if (
            self._gpr_cache is not None
            and now_mono - self._gpr_cache_loaded_at < 6 * 60 * 60
        ):
            return self._gpr_cache

        async with self._gpr_lock:
            now_mono = time.monotonic()
            if (
                self._gpr_cache is not None
                and now_mono - self._gpr_cache_loaded_at < 6 * 60 * 60
            ):
                return self._gpr_cache

            workbook = None
            last_error: Exception | None = None
            for url in GPR_DAILY_URLS:
                try:
                    workbook_bytes = await self._get_bytes(url)
                    workbook = xlrd.open_workbook(file_contents=workbook_bytes)
                    break
                except Exception as exc:
                    last_error = exc
            if workbook is None:
                if last_error is not None:
                    raise ValueError(
                        f"GPR daily workbook unavailable: {type(last_error).__name__}: {last_error}"
                    ) from last_error
                raise ValueError("GPR daily workbook unavailable")

            chosen = None
            for sheet in workbook.sheets():
                try:
                    header_row, date_column, gpr_column = self._gpr_column_map(sheet)
                    chosen = (sheet, header_row, date_column, gpr_column)
                    break
                except ValueError:
                    continue
            if chosen is None:
                raise ValueError("GPR workbook layout changed; usable sheet not found")

            sheet, header_row, date_column, gpr_column = chosen
            points: list[SeriesPoint] = []
            for row in range(header_row + 1, sheet.nrows):
                observed = self._parse_gpr_date(
                    sheet.cell_value(row, date_column),
                    workbook.datemode,
                )
                raw_value = sheet.cell_value(row, gpr_column)
                try:
                    value = float(raw_value)
                except (TypeError, ValueError):
                    continue
                if observed is None or value < 0:
                    continue
                points.append(SeriesPoint(observed, value))

            points.sort(key=lambda point: point.date)
            if len(points) < 60:
                raise ValueError("GPR daily workbook: too few usable observations")

            self._gpr_cache = points
            self._gpr_cache_loaded_at = time.monotonic()
            return points

    @staticmethod
    def _parse_feed_date(raw: str) -> date | None:
        text = raw.strip()
        if not text:
            return None
        try:
            parsed = parsedate_to_datetime(text)
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            return parsed.astimezone(timezone.utc).date()
        except (TypeError, ValueError, OverflowError):
            pass
        try:
            parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            return parsed.astimezone(timezone.utc).date()
        except ValueError:
            return None

    @staticmethod
    def _policy_event_severity(text: str) -> float:
        normalized = re.sub(r"\s+", " ", html.unescape(text)).lower()
        high = (
            "emergency",
            "unscheduled",
            "intervention",
            "swap line",
            "quantitative easing",
            "quantitative tightening",
            "yield curve control",
            "rate cut",
            "rate hike",
            "cuts interest rate",
            "raises interest rate",
            "lowers interest rate",
            "raised the target range",
            "lowered the target range",
            "asset purchase programme",
            "asset purchase program",
        )
        medium = (
            "balance sheet",
            "taper",
            "standing repo",
            "liquidity facility",
            "negative interest rate",
            "forward guidance",
            "policy rate",
            "interest rate decision",
        )
        routine = (
            "fomc statement",
            "monetary policy decision",
            "monetary policy decisions",
            "monetary policy meeting",
            "policy board meeting",
            "press conference",
        )
        if any(term in normalized for term in high):
            return 90.0
        if any(term in normalized for term in medium):
            return 70.0
        if any(term in normalized for term in routine):
            return 35.0
        return 10.0

    @classmethod
    def _parse_policy_feed_events(cls, body: str) -> list[tuple[date, float]]:
        try:
            root = ET.fromstring(body)
        except ET.ParseError as exc:
            raise ValueError(f"official policy RSS parse error: {exc}") from exc

        events: list[tuple[date, float]] = []
        for item in root.iter():
            local = item.tag.rsplit("}", 1)[-1].lower()
            if local not in {"item", "entry"}:
                continue
            text_parts: list[str] = []
            observed: date | None = None
            for child in item.iter():
                child_local = child.tag.rsplit("}", 1)[-1].lower()
                raw = "".join(child.itertext()).strip()
                if not raw:
                    continue
                if child_local in {
                    "title",
                    "description",
                    "summary",
                    "content",
                    "category",
                }:
                    text_parts.append(raw)
                if observed is None and child_local in {
                    "pubdate",
                    "published",
                    "updated",
                    "date",
                }:
                    observed = cls._parse_feed_date(raw)
            if observed is None:
                continue
            joined = re.sub(r"<[^>]+>", " ", " ".join(text_parts))
            events.append((observed, cls._policy_event_severity(joined)))
        return events

    async def policy_regime_shock(self) -> list[SeriesPoint]:
        """
        Build a conservative event-risk score from official Fed/ECB/BoJ feeds.

        The classifier is intentionally deterministic and headline/summary based.
        A severe policy event starts high and decays for seven days; routine
        meetings create only a mild bump. If one central-bank feed is down, the
        remaining official feeds still keep the signal live.
        """
        results = await asyncio.gather(
            *(self._get_text(url) for url in POLICY_RSS_URLS),
            return_exceptions=True,
        )
        successful = [result for result in results if isinstance(result, str)]
        if not successful:
            raise ValueError("official policy RSS: all feeds unavailable")

        events: list[tuple[date, float]] = []
        for body in successful:
            try:
                events.extend(self._parse_policy_feed_events(body))
            except ValueError:
                continue
        if not events:
            raise ValueError("official policy RSS: no dated events parsed")

        today = datetime.now(timezone.utc).date()
        decay = (1.0, 0.85, 0.70, 0.55, 0.40, 0.30, 0.20, 0.15)
        points: list[SeriesPoint] = []
        for offset in range(44, -1, -1):
            observed = today - timedelta(days=offset)
            score = 10.0
            for event_date, severity in events:
                age = (observed - event_date).days
                if 0 <= age < len(decay):
                    candidate = 10.0 + (severity - 10.0) * decay[age]
                    score = max(score, candidate)
            points.append(SeriesPoint(observed, round(score, 2)))
        return points

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

    @staticmethod
    def _parse_market_breadth_csv(text: str) -> dict[date, float]:
        rows = csv.DictReader(io.StringIO(text))
        values: dict[date, float] = {}
        for row in rows:
            try:
                observed = date.fromisoformat(str(row.get("date", "")).strip())
                above_200d = float(str(row.get("above_200d", "")).strip())
            except (ValueError, TypeError):
                continue
            if not 0.0 <= above_200d <= 100.0:
                continue
            values[observed] = above_200d
        return values

    @staticmethod
    def _parse_market_ad_csv(text: str) -> dict[date, float]:
        rows = csv.DictReader(io.StringIO(text))
        values: dict[date, float] = {}
        for row in rows:
            try:
                observed = date.fromisoformat(str(row.get("date", "")).strip())
                advancers = float(str(row.get("advancers", "")).strip())
                decliners = float(str(row.get("decliners", "")).strip())
            except (ValueError, TypeError):
                continue
            directional = advancers + decliners
            # S&P 500 currently contains just over 500 listed securities because
            # a few constituents have multiple share classes. Reject obviously
            # incomplete rows rather than manufacturing a breadth reading.
            if not (400.0 <= directional <= 550.0):
                continue
            values[observed] = 100.0 * advancers / directional
        return values

    async def market_breadth(self) -> list[SeriesPoint]:
        """
        Build a conservative S&P 500 breadth-strength composite.

        The transport archive republishes MacroMicro's S&P 500 breadth series.
        We only combine dates present in BOTH files, so a lagging advance/decline
        feed cannot be silently forward-filled and presented as current data.
        The composite is 70% of constituents above their 200-day moving average
        plus 30% of directional issues that advanced that session.

        Freshness is handled by the engine from the latest common observation.
        """
        breadth_text, ad_text = await asyncio.gather(
            self._get_text(MARKET_BREADTH_CSV_URL),
            self._get_text(MARKET_AD_CSV_URL),
        )
        above_200d = self._parse_market_breadth_csv(breadth_text)
        advancing_share = self._parse_market_ad_csv(ad_text)
        common_dates = sorted(set(above_200d) & set(advancing_share))
        if len(common_dates) < 120:
            raise ValueError(
                "S&P 500 market breadth: too few validated common observations"
            )

        points = [
            SeriesPoint(
                observed,
                0.70 * above_200d[observed] + 0.30 * advancing_share[observed],
            )
            for observed in common_dates
        ]
        points.sort(key=lambda point: point.date)
        return points

    @staticmethod
    def _parse_forward_pe_csv(text: str) -> list[SeriesPoint]:
        rows = csv.DictReader(io.StringIO(text))
        points: list[SeriesPoint] = []
        for row in rows:
            try:
                observed = date.fromisoformat(str(row.get("date", "")).strip())
                value = float(str(row.get("forward_pe", "")).strip())
            except (ValueError, TypeError):
                continue
            # Forward P/E should be positive. A very wide upper guard catches
            # malformed rows without imposing a market-view judgement.
            if not 0.0 < value < 100.0:
                continue
            points.append(SeriesPoint(observed, value))
        points.sort(key=lambda point: point.date)
        return points

    @staticmethod
    def _forward_pe_percentile_points(
        points: list[SeriesPoint],
        *,
        lookback: int = 2520,
        min_observations: int = 1260,
        output_points: int = 60,
    ) -> list[SeriesPoint]:
        if lookback < 2 or min_observations < 2:
            raise ValueError("forward P/E percentile: invalid lookback")
        if len(points) < min_observations:
            raise ValueError("forward P/E percentile: insufficient history")

        start = max(min_observations - 1, len(points) - max(2, output_points))
        output: list[SeriesPoint] = []
        for index in range(start, len(points)):
            window = points[max(0, index - lookback + 1) : index + 1]
            if len(window) < min_observations:
                continue
            current = points[index].value
            values = [point.value for point in window]
            below = sum(value < current for value in values)
            equal = sum(value == current for value in values)
            percentile = 100.0 * (below + 0.5 * equal) / len(values)
            output.append(SeriesPoint(points[index].date, percentile))

        if len(output) < 2:
            raise ValueError("forward P/E percentile: too few scored observations")
        return output

    async def sp500_forward_pe_percentile(self) -> list[SeriesPoint]:
        """
        Return the S&P 500 forward P/E as a trailing 10-year percentile.

        The upstream archive contains a daily forward-P/E series back to 2003.
        Risk29 converts that level into a rolling percentile so the valuation
        signal remains comparable across different market regimes. The source
        is fail-closed if it does not contain at least five years of history.
        """
        text = await self._get_text(FORWARD_PE_CSV_URL)
        raw = self._parse_forward_pe_csv(text)
        return self._forward_pe_percentile_points(raw)

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
