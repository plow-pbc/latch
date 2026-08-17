#!/usr/bin/env bash
# Promote a versioned Domo Desktop release candidate to the stable keys that
# installed apps poll. The Domo analog of Plow's plowd-promote-release.
#
# Copies s3://<bucket>/<prefix>/releases/<version>-<build>/* onto stable keys:
#   <prefix>/<zip> + .blockmap        what electron-updater downloads
#   <prefix>/Domo-Desktop.dmg(.sha256) the stable human download link
#   <prefix>/latest-mac.yml           the feed — copied LAST, because writing
#                                     it is the moment existing installs see
#                                     the update; every byte it references must
#                                     already be in place when it lands.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: release-promote.sh --version <value> --build <number> [options]

Options:
  --version <value>   Marketing version, e.g. 0.1.0
  --build <value>     Build number the candidate was uploaded under
  --bucket <name>     S3 bucket (default: releases.plow.co)
  --prefix <path>     Key prefix inside the bucket (default: domo)
  --profile <name>    AWS profile; pass "" for ambient credentials (CI OIDC)
                      (default: plow)
  -h, --help          Show this help
EOF
}

version=""
build=""
bucket="releases.plow.co"
prefix="domo"
profile="plow"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version) version="${2:-}"; shift 2 ;;
    --build) build="${2:-}"; shift 2 ;;
    --bucket) bucket="${2:-}"; shift 2 ;;
    --prefix) prefix="${2:-}"; shift 2 ;;
    --profile) profile="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "error: unknown option: $1" >&2; usage >&2; exit 1 ;;
  esac
done

[[ -n "$version" && -n "$build" ]] || { echo "error: --version and --build are required" >&2; usage >&2; exit 1; }

aws_args=()
[[ -n "$profile" ]] && aws_args+=(--profile "$profile")
# ${aws_args[@]+…}: on the macOS runners' bash 3.2, `set -u` treats expanding
# an EMPTY array as an unbound variable, and CI passes --profile "" so the
# array is empty there. The +-expansion is the 3.2-safe idiom.

src="${prefix}/releases/${version}-${build}"
zip_name="Domo-Desktop-${version}-universal.zip"
dmg_name="Domo-Desktop-${version}.dmg"

# Fail before touching anything if the candidate is incomplete.
for key in "$zip_name" "$zip_name.blockmap" "$dmg_name" "$dmg_name.sha256" "latest-mac.yml"; do
  aws ${aws_args[@]+"${aws_args[@]}"} s3api head-object --bucket "$bucket" --key "$src/$key" >/dev/null 2>&1 || {
    echo "error: candidate artifact missing: s3://${bucket}/${src}/${key}" >&2
    echo "hint: was this version+build uploaded by 'just release'?" >&2
    exit 1
  }
done

copy() {
  aws ${aws_args[@]+"${aws_args[@]}"} s3 cp "s3://${bucket}/${src}/$1" "s3://${bucket}/${prefix}/$2"
}

# Artifacts first, feed last (see header). The zip keeps its versioned name —
# that's the exact string inside latest-mac.yml, resolved relative to the feed.
copy "$zip_name" "$zip_name"
copy "$zip_name.blockmap" "$zip_name.blockmap"
copy "$dmg_name" "Domo-Desktop.dmg"
copy "$dmg_name.sha256" "Domo-Desktop.dmg.sha256"
copy "latest-mac.yml" "latest-mac.yml"

echo "Promoted ${version} (${build}) to stable:"
echo "  feed:     https://s3.us-west-2.amazonaws.com/${bucket}/${prefix}/latest-mac.yml"
echo "  download: https://s3.us-west-2.amazonaws.com/${bucket}/${prefix}/Domo-Desktop.dmg"
