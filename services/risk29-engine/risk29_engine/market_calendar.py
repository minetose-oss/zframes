from datetime import timedelta
from functools import lru_cache

import exchange_calendars as xcals
import pandas as pd

@lru_cache(maxsize=1)
def _calendar():
    return xcals.get_calendar("XNYS")

def market_freshness(as_of, now, freshness):
    """Daily US index observations must cover the last completed session.
    Allow 60 minutes after scheduled close for publication.
    """
    cal = _calendar()
    cutoff = pd.Timestamp(now - timedelta(hours=1))
    day = pd.Timestamp(cutoff.date())
    session = cal.date_to_session(day, direction="previous")
    if cal.session_close(session) > cutoff:
        session = cal.previous_session(session)
    expected = session.date()
    if as_of >= expected:
        return freshness, None
    prior = cal.previous_session(session).date()
    status = "stale" if as_of < prior or freshness == "stale" else "delayed"
    return status, f"Market close coverage: expected {expected}, observed {as_of}"
