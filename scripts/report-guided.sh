#!/bin/bash
# Before (master pipeline) / after (auto) / after (guided or target) renders for the defect cases. usage: scripts/report-guided.sh <outdir>
D=$1; mkdir -p "$D"; L=--legacy=out/legacy/src/core
r() { tag=$1; shift; m=$1; h=$2; shift 2; TAG=$tag timeout 1500 env "$@" npx tsx scripts/report.ts models/$m.glb $h "$D" $LEG > "$D/${m}_${h}_$tag.log" 2>&1; }
LEG=$L r before prototype-kit-figurine 150 & LEG= r after prototype-kit-figurine 150 & LEG= r target3 prototype-kit-figurine 150 MIN_PARTS=3 &
LEG=$L r before woman_seated_v16 150 & LEG= r after woman_seated_v16 150 & LEG= r guided woman_seated_v16 150 HINTS=tests/hints/woman_head.json &
wait
LEG=$L r before Fox 150 & LEG= r after Fox 150 & LEG= r guided Fox 150 HINTS=tests/hints/fox_head.json &
LEG=$L r before Lantern 250 & LEG= r after Lantern 250 & LEG=$L r before m1 150 & LEG= r guided m1 150 HINTS=tests/hints/m1_head.json &
wait
