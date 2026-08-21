"""Add one profile's cookies to another's, keeping what the session changed.

Called when a browser session ends: the session browsed on a clone of the
user's profile, and what it signed into has to reach the profile itself
without throwing away what another browser signed into at the same time.

Only rows this session CHANGED are taken. Reading a page is enough to move a
cookie's `lastAccessed`, so "more recently used" would let a browser that
merely looked at a site put its months-old copy of a token over the fresh one
another browser had just been given — signing the user out by doing nothing.
The baseline is what the clone started with; anything equal to it is untouched
and stays out of the merge.

The columns are read from the table rather than written down here — Firefox
adds one every few releases, and a list that went stale would quietly drop
whatever it did not name. `id` is left out on purpose: it is the row number of
the store being written, not part of the cookie.
"""

import os
import sqlite3
import sys

KEY = ("name", "host", "path", "originAttributes")

MERGE = (
    "INSERT OR REPLACE INTO main.moz_cookies (%(names)s) "
    "SELECT %(names)s FROM extra.moz_cookies AS theirs "
    # Changed by this session: no baseline row with the same key and value.
    "WHERE %(changed)s "
    # And not already replaced by a session that changed it more recently.
    "AND NOT EXISTS (SELECT 1 FROM main.moz_cookies AS mine WHERE %(same)s "
    "AND mine.lastAccessed >= theirs.lastAccessed)"
)


def main(into: str, extra: str, baseline: str = "") -> None:
    db = sqlite3.connect(into, timeout=10)
    try:
        db.execute("ATTACH ? AS extra", (extra,))
        columns = [r[1] for r in db.execute("PRAGMA main.table_info(moz_cookies)") if r[1] != "id"]
        if not columns:
            raise SystemExit("no moz_cookies table to merge into")
        keys = [k for k in KEY if k in columns]
        same = " AND ".join("mine.%s = theirs.%s" % (k, k) for k in keys)
        if baseline and os.path.exists(baseline):
            db.execute("ATTACH ? AS base", (baseline,))
            changed = "NOT EXISTS (SELECT 1 FROM base.moz_cookies AS was WHERE %s AND was.value = theirs.value)" % (
                " AND ".join("was.%s = theirs.%s" % (k, k) for k in keys)
            )
        else:
            # No baseline: a first session on a Mac with no profile of its own.
            changed = "1"
        db.execute(MERGE % {"names": ",".join(columns), "changed": changed, "same": same})
        db.commit()
    finally:
        db.close()


if __name__ == "__main__":
    main(*sys.argv[1:4])
