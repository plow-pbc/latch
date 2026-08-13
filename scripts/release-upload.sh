#!/usr/bin/env bash
# Upload a packaged Domo Desktop release candidate to versioned S3 keys.
#
# Reads apps/desktop/release/ (the electron-builder output that `just package`
# produced) and uploads everything an update or a download needs to
#   s3://<bucket>/<prefix>/releases/<version>-<build>/
# Stable keys are NOT touched — installed apps keep updating from whatever was
# last promoted. `just promote <version> <build>` (release-promote.sh) is the
# separate, human-gated step that ships this candidate.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: release-upload.sh --version <value> --build <number> [options]

Options:
  --version <value>   The stamped version `just package` minted
                      (major.minor.<UTC yyyymmddHHMM>, read from the built app)
  --build <value>     The build number from the same stamp (CFBundleVersion)
  --bucket <name>     S3 bucket (default: releases.plow.co)
  --prefix <path>     Key prefix inside the bucket (default: domo)
  --profile <name>    AWS profile; pass "" to use ambient credentials, e.g.
                      the OIDC role in CI (default: plow)
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

root="$(cd "$(dirname "$0")/.." && pwd)"
release_dir="$root/apps/desktop/release"

aws_args=()
[[ -n "$profile" ]] && aws_args+=(--profile "$profile")

# Everything the feed and the download page need. latest-mac.yml names the zip;
# the blockmap enables differential downloads; the DMG is the human download.
zip_name="Domo-Desktop-${version}-universal.zip"
dmg_name="Domo-Desktop-${version}.dmg"
artifacts=("$zip_name" "$zip_name.blockmap" "$dmg_name" "latest-mac.yml")

for f in "${artifacts[@]}"; do
  [[ -f "$release_dir/$f" ]] || {
    echo "error: expected artifact missing: $release_dir/$f" >&2
    echo "hint: run 'just package' (or 'just release', which packages first)" >&2
    exit 1
  }
done

# The feed must describe the zip sitting next to it — a version mismatch here
# means release/ holds artifacts from an older package run.
grep -q "version: ${version}$" "$release_dir/latest-mac.yml" || {
  echo "error: latest-mac.yml does not carry version ${version} — stale release/ dir?" >&2
  exit 1
}
grep -q "$zip_name" "$release_dir/latest-mac.yml" || {
  echo "error: latest-mac.yml does not reference $zip_name" >&2
  exit 1
}

# Checksum sibling for the DMG, same convention as Plow's releases.
shasum -a 256 "$release_dir/$dmg_name" | awk '{print $1}' > "$release_dir/$dmg_name.sha256"

dest="s3://${bucket}/${prefix}/releases/${version}-${build}"
for f in "${artifacts[@]}" "$dmg_name.sha256"; do
  aws "${aws_args[@]}" s3 cp "$release_dir/$f" "$dest/$f"
done

echo "Uploaded release candidate ${version} (${build}):"
echo "  DMG: https://s3.us-west-2.amazonaws.com/${bucket}/${prefix}/releases/${version}-${build}/${dmg_name}"
echo "To ship it to existing installs: just promote ${version} ${build}"
