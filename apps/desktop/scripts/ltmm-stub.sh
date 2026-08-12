#!/bin/sh
# A stand-in for the `ltmm` CLI, for test drives and isolated launches.
#
# It has to satisfy BOTH operations of the LTMM gateway, which is why this is a
# file and not `/usr/bin/true`. `true` is inert for `startSeeding`, but for
# `recall` it is a malformed backend: it exits 0 with empty stdout, so
# JSON.parse("") throws and every recall in the session fails with "recall
# returned an unreadable response" -- a real-looking bug caused entirely by the
# harness. Emitting `[]` keeps the seed spawn inert and lets recall answer
# honestly: the store knows nothing.
echo '[]'
