#!/usr/bin/env bash
# Linux counterpart of measure-memory.ps1: the memory of one process and all its descendants.
#
# Private is Private_Clean + Private_Dirty from /proc/<p>/smaps_rollup (the counterpart of the
# Windows private working set, ADR 0003); total is Rss, which counts shared pages once per
# process and is for reference only. The script takes --samples readings --interval seconds
# apart and prints the minimum (one reading depends on when it falls relative to the WebView's
# garbage collection).
#
#   scripts/measure-memory.sh --pid <n> [--samples 3] [--interval 2]
#
# Pass the test build's own PID: never a name match, which would count the everyday app too.
# Exit codes: 0 done, 2 no such process (or bad arguments).

set -u
pid=""; samples=3; interval=2
while [ $# -gt 0 ]; do
  case "$1" in
    --pid) pid="${2:-}"; shift 2 ;;
    --samples) samples="${2:-}"; shift 2 ;;
    --interval) interval="${2:-}"; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
case "$pid" in ''|*[!0-9]*) echo "--pid <n> is required" >&2; exit 2 ;; esac
case "$interval" in ''|*[!0-9.]*|*.*.*) echo "--interval must be a positive number" >&2; exit 2 ;; esac
case "$interval" in *[1-9]*) ;; *) echo "--interval must be a positive number" >&2; exit 2 ;; esac
case "$samples" in ''|*[!0-9]*|0) echo "--samples must be a positive number" >&2; exit 2 ;; esac
if [ ! -d "/proc/$pid" ]; then echo "no such process: $pid" >&2; exit 2; fi

# The process and every descendant, one id per line.
tree() {
  local p
  echo "$1"
  for t in /proc/"$1"/task/*/children; do
    [ -r "$t" ] || continue
    for p in $(cat "$t" 2>/dev/null); do tree "$p"; done
  done
}

min_private=""; min_total=""
for ((i = 1; i <= samples; i++)); do
  [ "$i" -gt 1 ] && sleep "$interval"
  [ -d "/proc/$pid" ] || { echo "process $pid has exited" >&2; exit 2; }
  read -r priv total n < <(
    for p in $(tree "$pid" | sort -un); do
      awk '/^(Private_Clean|Private_Dirty):/ { priv += $2 } /^Rss:/ { rss += $2 }
        END { if (NR) print priv + 0, rss + 0 }' "/proc/$p/smaps_rollup" 2>/dev/null
    done | awk '{ priv += $1; rss += $2; n++ } END { print priv + 0, rss + 0, n + 0 }'
  )
  priv_mb=$(awk -v k="$priv" 'BEGIN { printf "%.1f", k / 1024 }')
  total_mb=$(awk -v k="$total" 'BEGIN { printf "%.1f", k / 1024 }')
  echo "sample $i: private $priv_mb MB, total $total_mb MB, processes $n"
  if [ -z "$min_private" ] || [ "$priv" -lt "$min_private" ]; then min_private=$priv; min_total=$total; fi
done
awk -v p="$min_private" -v t="$min_total" 'BEGIN { printf "min: private %.1f MB, total %.1f MB\n", p / 1024, t / 1024 }'
