#!/usr/bin/env bash
# run-one.sh "name[:args]" OUTDIR  ->  runs research/jobs/<name>.py|.mjs|.sh with args and OUTDIR.
set -euo pipefail
spec="$1"; out="$2"
name="${spec%%:*}"; arg=""
[[ "$spec" == *:* ]] && arg="${spec#*:}"
dir="$(dirname "$0")"
echo "== $name ($arg) started $(date -u +%FT%TZ)"
if [[ -f "$dir/$name.py" ]]; then python3 -u "$dir/$name.py" "$out" $arg
elif [[ -f "$dir/$name.mjs" ]]; then node "$dir/$name.mjs" "$out" $arg
elif [[ -f "$dir/$name.sh" ]]; then bash "$dir/$name.sh" "$out" $arg
else echo "no such job: $name"; exit 2; fi
echo "== $name finished $(date -u +%FT%TZ)"
