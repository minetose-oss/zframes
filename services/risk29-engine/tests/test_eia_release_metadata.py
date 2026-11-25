from datetime import date
from risk29_engine.sources import PublicSourceClient


def test_release_metadata_does_not_invent_clock():
    result = PublicSourceClient._eia_release_metadata(
        "Next Release Date: 11/25/2026", date(2026, 11, 25), date(2026, 11, 17)
    )
    assert result == {"nextReleaseDate": "2026-11-25", "nextReleaseAt": None,
                      "releaseStatus": "RELEASE_DAY"}


def test_release_metadata_missing():
    result = PublicSourceClient._eia_release_metadata(
        "", date(2026, 11, 25), date(2026, 11, 17)
    )
    assert result["nextReleaseAt"] is None
    assert result["nextReleaseDate"] is None
    assert result["releaseStatus"] == "UNKNOWN"
