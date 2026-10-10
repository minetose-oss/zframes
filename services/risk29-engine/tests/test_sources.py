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
