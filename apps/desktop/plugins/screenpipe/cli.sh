#!/bin/sh
set -eu
LC_ALL=C
export LC_ALL

usage() {
  printf '%s\n' 'plow-screenpipe health
plow-screenpipe search [--query TEXT] [--content-type all|ocr|audio|input|accessibility|parsed]
  [--app-name TEXT] [--window-name TEXT] [--start-time RFC3339] [--end-time RFC3339]
  [--limit 1..100] [--offset 0..1000000] [--order asc|desc]
plow-screenpipe --help
plow-screenpipe install

Requires Screenpipe running on this Mac. API calls need network=true in plow_run_command.
Install needs network=true and write_paths=["~/.screenpipe"]. It installs the CLI without starting capture.
Search defaults: all content, newest first, 20 results; requests API text truncation at 2000 characters.
Output: JSON response with search data and pagination.'
}

fail() { printf '%s\n' "$1" >&2; exit 1; }
invalid() { printf '%s\n' "$1" >&2; exit 2; }

[ "$#" -gt 0 ] || { usage >&2; exit 2; }
command=$1
shift
query='' app='' window='' start='' end=''
content_type=all limit=20 offset=0 order=desc

case "$command" in
  install)
    [ "$#" -eq 0 ] || invalid 'Install takes no arguments.'
    exec /bin/sh ./install.sh
    ;;
  --help)
    [ "$#" -eq 0 ] || invalid 'Help takes no arguments.'
    usage
    exit 0
    ;;
  health)
    [ "$#" -eq 0 ] || invalid 'Health takes no arguments.'
    ;;
  search)
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --query|--content-type|--app-name|--window-name|--start-time|--end-time|--limit|--offset|--order)
          [ "$#" -ge 2 ] || invalid 'Each search option needs a value.'
          [ "${#2}" -le 4096 ] || invalid 'Search option values must be at most 4096 bytes.'
          case "$1" in
            --query) query=$2 ;;
            --content-type) content_type=$2 ;;
            --app-name) app=$2 ;;
            --window-name) window=$2 ;;
            --start-time) start=$2 ;;
            --end-time) end=$2 ;;
            --limit) limit=$2 ;;
            --offset) offset=$2 ;;
            --order) order=$2 ;;
          esac
          shift 2
          ;;
        *) invalid 'Unknown search option. Run plow-screenpipe --help.' ;;
      esac
    done
    case "$content_type" in
      all|ocr|audio|input|accessibility|parsed) ;;
      *) invalid 'Unsupported content type.' ;;
    esac
    case "$order" in asc|desc) ;; *) invalid 'Order must be asc or desc.' ;; esac
    case "$limit" in ''|*[!0-9]*) invalid 'Limit must be an integer from 1 to 100.' ;; esac
    [ "${#limit}" -le 3 ] && [ "$limit" -ge 1 ] && [ "$limit" -le 100 ] || invalid 'Limit must be an integer from 1 to 100.'
    case "$offset" in ''|*[!0-9]*) invalid 'Offset must be an integer from 0 to 1000000.' ;; esac
    [ "${#offset}" -le 7 ] && [ "$offset" -le 1000000 ] || invalid 'Offset must be an integer from 0 to 1000000.'
    ;;
  *) invalid 'Only health, search, --help and install are supported.' ;;
esac

# The owner configures a port in the manifest. Callers cannot supply a host,
# URL, token, curl option, or config file through the command's arguments.
port=${SCREENPIPE_API_PORT:-3030}
case "$port" in ''|*[!0-9]*) fail 'Screenpipe API port must be an integer from 1 to 65535.' ;; esac
[ "${#port}" -le 5 ] && [ "$port" -ge 1 ] && [ "$port" -le 65535 ] || fail 'Screenpipe API port must be an integer from 1 to 65535.'

set -- --url "http://127.0.0.1:$port/$command"
if [ "$command" = search ]; then
  case "$order" in asc) api_order=ascending ;; desc) api_order=descending ;; esac
  set -- "$@" --data-urlencode "content_type=$content_type" --data-urlencode "limit=$limit" \
    --data-urlencode "offset=$offset" --data-urlencode "order=$api_order" \
    --data-urlencode 'include_frames=false' --data-urlencode 'include_cloud=false' \
    --data-urlencode 'max_content_length=2000'
  [ -z "$query" ] || set -- "$@" --data-urlencode "q=$query"
  [ -z "$app" ] || set -- "$@" --data-urlencode "app_name=$app"
  [ -z "$window" ] || set -- "$@" --data-urlencode "window_name=$window"
  [ -z "$start" ] || set -- "$@" --data-urlencode "start_time=$start"
  [ -z "$end" ] || set -- "$@" --data-urlencode "end_time=$end"
fi

api_key=''
key_file=${SCREENPIPE_API_KEY_FILE:-}
if [ "$command" = search ] && [ -n "$key_file" ] && [ -e "$key_file" ]; then
  [ -f "$key_file" ] && [ -r "$key_file" ] || fail 'Screenpipe API key file is unreadable.'
  [ "$(/usr/bin/wc -c < "$key_file")" -le 4096 ] || fail 'Screenpipe API key file is too large.'
  api_key=$(/bin/cat "$key_file") || fail 'Screenpipe API key file is unreadable.'
  case "$api_key" in ''|*[!A-Za-z0-9._~+/=-]*) fail 'Screenpipe API key file must contain one bearer token.' ;; esac
fi

body=$(/usr/bin/mktemp "${TMPDIR:-/tmp}/latch-screenpipe.XXXXXX")
trap '/bin/rm -f "$body"' EXIT
trap 'exit 1' HUP INT TERM
# Bound the response file even when an older system curl receives chunked data.
ulimit -f 4096

# -q ignores ~/.curlrc. Auth goes through stdin rather than process argv.
# Proxy bypass and no redirects keep the request and its token on loopback.
if status=$(
  { [ -z "$api_key" ] || printf 'header = "Authorization: Bearer %s"\n' "$api_key"; } |
    /usr/bin/curl -q --config - --silent --globoff --get --proto '=http' \
      --proxy '' --noproxy '*' --connect-timeout 3 --max-time 15 --max-filesize 4194304 \
      --header 'Accept: application/json' --output "$body" --write-out '%{http_code}' "$@" 2>/dev/null
); then
  case "$status" in
    2??) /bin/cat "$body" ;;
    401|403) fail 'Screenpipe rejected authentication. The owner must configure or refresh the API key file; see the plugin README.' ;;
    3??) fail 'Screenpipe returned a redirect. Redirects are refused.' ;;
    400) fail 'Screenpipe rejected the search parameters. Check timestamps and filters with plow-screenpipe --help.' ;;
    *) fail 'Screenpipe returned an HTTP error. Check the running Screenpipe app and its API version.' ;;
  esac
else
  case "$?" in
    7) fail 'Cannot connect to Screenpipe. Start Screenpipe on this Mac and check the configured API port.' ;;
    28) fail 'Screenpipe did not respond within 15 seconds. Check its health and retry a narrower search.' ;;
    *) fail 'Screenpipe request failed or exceeded the response size limit. Check its health and narrow the search.' ;;
  esac
fi
