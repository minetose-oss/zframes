from datetime import date
import pytest
from risk29_engine.sources import PublicSourceClient

@pytest.mark.parametrize("day,status", [(24,"AWAITING_RELEASE"), (25,"RELEASE_DAY"), (26,"OVERDUE")])
def test_release_calendar(day, status):
    assert PublicSourceClient._eia_release_status("<b>Next Release Date:</b> 11/25/2026", date(2026,11,day), date(2026,11,17)) == status

def test_unknown_calendar():
    assert PublicSourceClient._eia_release_status("no schedule", date(2026,11,25), date(2026,11,17)) == "UNKNOWN"
