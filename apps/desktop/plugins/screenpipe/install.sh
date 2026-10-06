#!/bin/sh
set -eu
LC_ALL=C
export LC_ALL
umask 077

fail() { printf '%s\n' "$1" >&2; exit 1; }
[ "$#" -eq 0 ] || fail 'Install takes no arguments.'
[ "$(/usr/bin/uname -s)" = Darwin ] || fail 'The Latch installer supports macOS only.'
machine=$(/usr/bin/uname -m)
case "$machine" in
  arm64)
    package=cli-darwin-arm64
    checksum=7ea1e954f1938d65730aff6a915df4fae82dbef63a58a6799cc4492ec960dc88cf2d8b67e674dc65cf49ed2f78ee1a593b600ae15ebb9abd28518fd718417c40
    ;;
  x86_64)
    package=cli-darwin-x64
    checksum=9fee072da6cb027c2bbbf6c02cde9841d0312e9cb8c79e429d5cc40ef16345bab439606d77ec5e49a759d196456241054e9fc24b9d7cb96d199aa37ed8608c19
    ;;
  *) fail 'Unsupported Mac architecture.' ;;
esac

version=0.4.52
root=${SCREENPIPE_INSTALL_DIR:-"$HOME/.screenpipe/latch-cli"}
release="$root/$version-$machine"
/bin/mkdir -p "$root"
lock="$root/.install-lock"
/bin/mkdir "$lock" 2>/dev/null || fail 'Another installation is in progress. Retry after it finishes.'
scratch='' stage=''
cleanup() {
  [ -z "$scratch" ] || /bin/rm -rf "$scratch"
  [ -z "$stage" ] || /bin/rm -rf "$stage"
  /bin/rmdir "$lock"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

if [ -x "$release/bin/screenpipe" ] && [ -f "$release/.package-integrity" ] &&
  [ "$(/bin/cat "$release/.package-integrity")" = "$checksum" ]; then
  printf 'Screenpipe %s is already installed at %s/bin/screenpipe\n' "$version" "$release"
  exit 0
fi
[ ! -e "$release" ] || fail 'The managed release directory already exists but is incomplete. Preserve it and repair it before retrying.'

scratch=$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/latch-screenpipe-install.XXXXXX")
url="https://registry.npmjs.org/@screenpipe/$package/-/$package-$version.tgz"
printf 'Downloading Screenpipe %s from the official npm platform package.\n' "$version"
/usr/bin/curl -q --fail --silent --globoff --proto '=https' --proxy '' --noproxy '*' \
  --connect-timeout 10 --max-time 300 --max-filesize 268435456 --output "$scratch/release.tgz" \
  "$url" 2>/dev/null || fail 'Screenpipe download failed. Check network access and retry.'
actual=$(/usr/bin/shasum -a 512 "$scratch/release.tgz")
[ "${actual%% *}" = "$checksum" ] || fail 'Screenpipe package checksum mismatch. Nothing was installed.'

# The pinned packages contain the engine, architecture-specific native resources,
# package metadata and license. No npm wrapper or lifecycle scripts are executed.
stage=$(/usr/bin/mktemp -d "$root/.install.XXXXXX")
/usr/bin/tar -xzf "$scratch/release.tgz" -C "$stage" --strip-components=1
[ -f "$stage/bin/screenpipe" ] && [ -f "$stage/LICENSE.md" ] || fail 'The Screenpipe package is incomplete.'
/bin/chmod 755 "$stage/bin/screenpipe"
printf '%s\n' "$checksum" > "$stage/.package-integrity"
/bin/mv "$stage" "$release"
stage=''
printf 'Installed Screenpipe %s at %s/bin/screenpipe\n' "$version" "$release"
printf '%s\n' 'Start recording from the owner terminal and grant macOS permissions. See the plow-screenpipe skill for startup and authentication setup.'
