"""Add one profile's cookies to another's, keeping whichever was used last.

Called when a browser session ends: the session browsed on a clone of the
user's profile, and what it signed into has to reach the profile itself
without throwing away what another browser signed into at the same time.

The columns are read from the table rather than written down here — Firefox
adds one every few releases, and a list that went stale would quietly drop
whatever it did not name. `id` is left out on purpose: it is the row number of
the store being written, not part of the cookie.
"""

import sqlite3
import sys

KEY = ("name", "host", "path", "originAttributes")

MERGE = (
    "INSERT OR REPLACE INTO main.moz_cookies (%s) SELECT %s FROM extra.moz_cookies AS theirs "
    "WHERE NOT EXISTS (SELECT 1 FROM main.moz_cookies AS mine WHERE %s "
    "AND mine.lastAccessed >= theirs.lastAccessed)"
)


def main(into: str, extra: str) -> None:
    db = sqlite3.connect(into, timeout=10)
    try:
        db.execute("ATTACH ? AS extra", (extra,))
        columns = [r[1] for r in db.execute("PRAGMA main.table_info(moz_cookies)") if r[1] != "id"]
        if not columns:
            raise SystemExit("no moz_cookies table to merge into")
        names = ",".join(columns)
        same = " AND ".join("mine.%s = theirs.%s" % (k, k) for k in KEY if k in columns)
        db.execute(MERGE % (names, names, same))
        db.commit()
    finally:
        db.close()


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
