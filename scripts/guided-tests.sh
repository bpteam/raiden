#!/bin/bash
# Guided Split / Target Parts evidence runs on the real models. usage: scripts/guided-tests.sh <outdir>
D=$1; mkdir -p "$D"
run() { n=$1; shift; OUT=$D/$n timeout 1500 env "$@" > "$D/$n.log" 2>&1; }
run m1_400 npx tsx scripts/e2e.ts models/m1.glb 400 &
run figurine_150_min3 MIN_PARTS=3 npx tsx scripts/e2e.ts models/prototype-kit-figurine.glb 150 &
run woman_150_head npx tsx scripts/e2e.ts models/woman_seated_v16.glb 150 tests/hints/woman_head.json &
run woman_250_head npx tsx scripts/e2e.ts models/woman_seated_v16.glb 250 tests/hints/woman_head.json &
run fox_150_head npx tsx scripts/e2e.ts models/Fox.glb 150 tests/hints/fox_head.json &
run m1_150_head npx tsx scripts/e2e.ts models/m1.glb 150 tests/hints/m1_head.json &
wait
