"""Add what a browser session did to the user's cookies, and nothing else.

Called when a session ends: it browsed on a clone of the user's profile, and
what it did there has to reach the profile itself without throwing away what
another browser did at the same time.

The clone is compared against the baseline it started from, so the merge knows
what this session actually DID rather than what it looks like now:

  * a row whose columns differ from the baseline was changed here — a new
    token, a longer expiry, a security attribute — and is written back;
  * a row that is gone was signed out of, and is removed from the profile, but
    only while the profile still holds exactly what the baseline did: another
    browser that changed it since gets to keep its version;
  * everything else was merely read. Reading moves `lastAccessed`, which is
    why that column is not part of "changed" — otherwise a browser that
    touched nothing would put its months-old copy of a token over the fresh
    one another browser had just been given, and sign the user out by doing
    nothing.

Columns are read from the table rather than written down here: Firefox adds
one every few releases, and a list that went stale would quietly drop whatever
it did not name. `id` is left out on purpose — it is the row number of the
store being written, not part of the cookie.
"""

import os
import sqlite3
import sys

KEY = ("name", "host", "path", "originAttributes")
# Moved by a read, so it says nothing about what the session changed.
READ_ONLY_COLUMN = "lastAccessed"


def main(into: str, extra: str, baseline: str) -> None:
    """`into` the user's profile, `extra` the session's clone, `baseline` what
    that clone started from — absent only on a profile with no cookie store."""
    db = sqlite3.connect(into, timeout=10)
    try:
        db.execute("ATTACH ? AS extra", (extra,))
        columns = [r[1] for r in db.execute("PRAGMA main.table_info(moz_cookies)") if r[1] != "id"]
        if not columns:
            raise SystemExit("no moz_cookies table to merge into")
        keys = [k for k in KEY if k in columns]
        state = [c for c in columns if c != READ_ONLY_COLUMN]
        names = ",".join(columns)

        def match(left: str, right: str, cols: "list[str]") -> str:
            # IS, not =: a NULL column matches a NULL column.
            return " AND ".join("%s.%s IS %s.%s" % (left, c, right, c) for c in cols)

        # A session that changed the same cookie more recently already won:
        # true with a baseline and without one, which is why it is the only
        # condition two sessions racing on a brand-new profile have.
        conditions = [
            "NOT EXISTS (SELECT 1 FROM main.moz_cookies AS mine WHERE %s "
            "AND mine.lastAccessed >= theirs.lastAccessed)" % match("mine", "theirs", keys)
        ]

        if os.path.exists(baseline):
            db.execute("ATTACH ? AS base", (baseline,))
            # Signed out here: gone from the clone, and the profile still holds
            # exactly what this session started from.
            db.execute(
                "DELETE FROM main.moz_cookies WHERE EXISTS ("
                "  SELECT 1 FROM base.moz_cookies AS was WHERE %s AND %s"
                ") AND NOT EXISTS ("
                "  SELECT 1 FROM extra.moz_cookies AS theirs WHERE %s"
                ")"
                % (
                    match("was", "moz_cookies", keys),
                    match("was", "moz_cookies", state),
                    match("theirs", "moz_cookies", keys),
                )
            )
            # Changed here: some state column differs from what it started as.
            conditions.append(
                "NOT EXISTS (SELECT 1 FROM base.moz_cookies AS was WHERE %s AND %s)"
                % (match("was", "theirs", keys), match("was", "theirs", state))
            )

        db.execute(
            "INSERT OR REPLACE INTO main.moz_cookies (%s) SELECT %s FROM extra.moz_cookies AS theirs WHERE %s"
            % (names, names, " AND ".join(conditions))
        )
        db.commit()
    finally:
        db.close()


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], sys.argv[3])
