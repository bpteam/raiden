#!/bin/bash
# Run every test model in parallel. usage: scripts/run-all.sh e2e|report|legacy <outdir>
# legacy = report.ts against the pre-redesign pipeline extracted to out/legacy/src/core (git show master:src/core/{prepare,geom}.ts)
MODE=$1; D=$2; mkdir -p "$D"
for spec in "woman_seated_v16 150" "woman_seated_v16 250" "m1 150" "m1 400" "Fox 150" "Fox 300" "prototype-kit-figurine 150" "prototype-kit-animal-bison 250" "Lantern 250"; do
  set -- $spec
  case $MODE in
    e2e) OUT=$D/$1_$2 timeout 1500 npx tsx scripts/e2e.ts models/$1.glb $2 > "$D/$1_$2.log" 2>&1 & ;;
    report) timeout 1500 npx tsx scripts/report.ts models/$1.glb $2 "$D" > "$D/$1_$2_after.log" 2>&1 & ;;
    legacy) timeout 1500 npx tsx scripts/report.ts models/$1.glb $2 "$D" --legacy=out/legacy/src/core > "$D/$1_$2_before.log" 2>&1 & ;;
  esac
done
wait
# bbs mode: slice every e2e project in <outdir> with the Bambu Studio CLI (after `run-all.sh e2e <outdir>`)
if [ "$MODE" = bbs ]; then
  for d in "$D"/*/; do n=$(basename "$d"); m=$(ls -d "$d"*.glb | head -1); b=$(basename "$m");
    timeout 1500 npx tsx scripts/bbs.ts "$m/project_a1mini.3mf" "$d$b.summary.json" > "$D/$n.bbs.json" 2>&1 & done; wait
fi
