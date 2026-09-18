from __future__ import annotations

import argparse
import asyncio
import os
import tempfile
from pathlib import Path

import httpx

from .engine import Risk29Engine
from .models import Risk29History, Risk29Snapshot
from .sources import PublicSourceClient


async def _seed_previous(base_url: str | None, data_dir: Path) -> dict[str, str]:
    status = {"latest": "missing", "history": "missing"}
    if not base_url:
        return status

    base = base_url.rstrip("/")
    async with httpx.AsyncClient(timeout=10.0, follow_redirects=True) as client:
        for name, model in (
            ("latest.json", Risk29Snapshot),
            ("history.json", Risk29History),
        ):
            key = name.removesuffix(".json")
            try:
                response = await client.get(
                    f"{base}/{name}",
                    headers={"User-Agent": "risk29-engine/publisher"},
                )
                if response.status_code == 404:
                    continue
                response.raise_for_status()
                validated = model.model_validate_json(response.text)
            except (httpx.HTTPError, ValueError):
                status[key] = "error"
                continue
            (data_dir / name).write_text(validated.model_dump_json(indent=2))
            status[key] = "loaded"
    return status


def _coalesce_history(
    history: Risk29History,
    *,
    minimum_interval_seconds: int = 1800,
) -> Risk29History:
    """Collapse repeated CI/manual publishes inside the same short time window."""

    minimum_interval_ms = minimum_interval_seconds * 1000
    points = []
    for point in history.points:
        if points and point.time - points[-1].time < minimum_interval_ms:
            points[-1] = point
        else:
            points.append(point)
    return Risk29History(generatedAt=history.generatedAt, points=points)


async def publish(
    output_dir: Path,
    *,
    existing_base_url: str | None,
    minimum_available: int,
) -> Risk29Snapshot:
    output_dir.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="risk29-publish-") as tmp:
        data_dir = Path(tmp)
        seed_status = await _seed_previous(existing_base_url, data_dir)
        if existing_base_url and "error" in seed_status.values():
            raise RuntimeError(
                "Refusing to publish because the prior durable Risk29 "
                f"publication could not be read safely: {seed_status}"
            )

        source_client = PublicSourceClient(
            timeout_seconds=float(os.getenv("RISK29_PUBLISH_HTTP_TIMEOUT_SECONDS", "20")),
            retry_attempts=int(os.getenv("RISK29_PUBLISH_RETRY_ATTEMPTS", "2")),
        )
        engine = Risk29Engine(
            source_client,
            data_dir=data_dir,
            refresh_seconds=1,
        )
        snapshot = await engine.latest(force=True)

        if snapshot.score is None or snapshot.health.available < minimum_available:
            raise RuntimeError(
                "Refusing to publish low-coverage Risk29 snapshot: "
                f"available={snapshot.health.available}/{snapshot.health.total}, "
                f"score={snapshot.score!r}"
            )

        history = _coalesce_history(engine.history(365))
        (output_dir / "latest.json").write_text(snapshot.model_dump_json(indent=2) + "\n")
        (output_dir / "history.json").write_text(history.model_dump_json(indent=2) + "\n")
        return snapshot


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Publish a validated Risk29 live snapshot")
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument(
        "--existing-base-url",
        default=os.getenv("RISK29_EXISTING_BASE_URL"),
        help="Static base URL containing the previously published latest/history JSON",
    )
    parser.add_argument(
        "--minimum-available",
        type=int,
        default=int(os.getenv("RISK29_PUBLISH_MINIMUM_AVAILABLE", "7")),
    )
    return parser


async def _main() -> None:
    args = _parser().parse_args()
    snapshot = await publish(
        args.output_dir,
        existing_base_url=args.existing_base_url,
        minimum_available=args.minimum_available,
    )
    print(
        "Published Risk29 snapshot "
        f"score={snapshot.score} state={snapshot.state} "
        f"available={snapshot.health.available}/{snapshot.health.total} "
        f"generatedAt={snapshot.generatedAt}"
    )


if __name__ == "__main__":
    asyncio.run(_main())
