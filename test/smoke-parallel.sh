#!/bin/bash
# 冒烟测试分三份同时跑（每份自己的临时目录、自己的端口，相隔 100），跑完按顺序打印，合计通过和失败。
# 大部分时间花在等后台进程和定时器上，所以同时跑能从 4 分钟左右缩到 1 分半左右。
# 单份：SMOKE_PART=2 bash test/smoke.sh；从头到尾一份跑：bash test/smoke.sh
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BASE="${SMOKE_PORT:-4878}"
OUT="$(mktemp -d "${TMPDIR:-/tmp}/mydash-smoke-parts.XXXXXX")"
trap 'rm -rf "$OUT"' EXIT
PARTS=(1 2 3); PIDS=()
for p in "${PARTS[@]}"; do
  SMOKE_PART=$p SMOKE_PORT=$((BASE + (p - 1) * 100)) bash "$ROOT/test/smoke.sh" > "$OUT/$p.log" 2>&1 &
  PIDS+=($!)
done
status=0; pass=0; fail=0
for i in "${!PARTS[@]}"; do
  p=${PARTS[$i]}
  wait "${PIDS[$i]}" || status=1
  echo "===== 第 $p 份 ====="
  cat "$OUT/$p.log"
  line=$(grep -E '^通过 [0-9]+，失败 [0-9]+$' "$OUT/$p.log" | tail -1)
  if [ -z "$line" ]; then echo "第 $p 份没有跑完"; status=1; continue; fi
  n=$(echo "$line" | sed -E 's/^通过 ([0-9]+)，失败 ([0-9]+)$/\1 \2/')
  pass=$((pass + ${n% *})); fail=$((fail + ${n#* }))
done
echo
echo "三份合计：通过 ${pass}，失败 ${fail}"
[ $fail -eq 0 ] && [ $status -eq 0 ]
