# raiden — browser-only auto splitter for Bambu Lab A1 Mini

Load a model, press **Auto Prepare**, get printable parts with dowel joints, oriented for surface quality and packed on 180×180×180 mm plates, exported as a Bambu Studio project. Everything runs client-side (Web Worker + manifold-3d WASM); no backend.

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # unit self-checks on simple solids
npm run e2e -- models/woman_seated_v16.glb 250        # node E2E: import → prepare → export → re-import
npx tsx scripts/report.ts models/m1.glb 150 out/report # six rendered views + uniform metrics
npx tsx scripts/bbs.ts out/m1.glb/project_a1mini.3mf out/m1.glb.summary.json   # slice the export with Bambu Studio CLI (flatpak)
```

Libraries: [manifold-3d](https://github.com/elalish/manifold) (Apache-2.0: booleans, plane split, slicing, simplify), three.js (MIT: view), glTF-Transform + meshoptimizer (MIT: GLB import), fflate (MIT: 3MF/ZIP).

## Pipeline (`src/core/prepare.ts`)

Decomposition, orientation and packing are decided **together**: every candidate split is scored with the print orientation each resulting part would get. Ideas from Chopper (Luo et al. 2012: BSP of planar cuts, beam search, seam/connector/part-count objectives), Dapper (Chen et al. 2015: decomposition judged together with packing and support), and Wang et al. 2016 (orientation per part from visual surface quality: stair-stepping and support scars on visible surfaces).

1. **Import + weld** (`geom.ts`): watertight check, winding repair, open parts reported, never silently fixed. Disconnected closed shells become separate parts (no seam needed).
2. **Surface analysis** (`analysis.ts`, `raster.ts`): orthographic z-buffer from 96 directions (weighted toward upper/front viewers) → per-surface **visibility**; normal variation in a 2.5 mm ball → **detail**; curvature sign → **concavity** (creases, folds). No semantic labels needed.
3. **Candidate cuts** (`cuts.ts`): 32 hemisphere normals + principal axes; for every offset, the plane∩surface curve is integrated with visibility × detail × anti-crease weights (a seam under a skirt or in a fold is nearly free; one across a smooth visible surface is expensive). Necks (perimeter minima with wider surface on both sides) get a bonus. Oversized parts also get the best seams inside the window where a cut actually makes the part fit.
4. **Joint search** (`search.ts`): beam search over BSPs on a ~12k-triangle proxy. Each state is scored: Σ per-part best orientation cost + seam visibility + connector feasibility (glue-only/fragile islands, thin washers) + part count + estimated plates; parts that do not fit are a hard constraint (large penalty). The unsplit model is always a candidate; a split for quality alone is accepted only if every extra part lowers the total by ≥ 8 %.
5. **Orientation** (`orient.ts`): 26 axis/diagonal directions, a ring of small tilts around upright, and every seam face down. Cost = support area on visible/detailed surfaces, hidden support, support volume to the bed, stair-stepping on visible gentle slopes, sagging down-skins, tipping (height vs bed contact; no flat contact = stands on supports), height. Yaw is left to packing.
6. **Replay on the full mesh + dowels** (`joints.ts`): blind holes + separate dowels, sized from the section's inscribed circle; every hole verified ≥ 99.95 % inside material, never reaching a neighbouring part; single-dowel islands get a square key; too-thin islands are reported glue-only.
7. **Packing** (`pack.ts`): 1 mm raster of each part's real projected footprint (not its bounding box), yaw in 15° steps only (print orientation untouched), 8 mm gaps, 5 mm from the bed edge (room for tree supports/brims; Bambu Studio flags path conflicts otherwise), auto-brim room for small-contact parts, first-fit decreasing over plates.
8. **Validation**: volume, reconstruction (assembled parts + connector cavities vs original), pairwise overlap, manifoldness, dowels clear of every body when seated, assembly sequence (planar BSP joins are collision-free by construction, re-checked with a sampled sweep), every part on the bed inside the volume, no overlaps per plate (exact booleans).
9. **Export** (`exporters.ts`): `project_a1mini.3mf` — a Bambu Studio project laid out like Bambu Studio's own exports (multi-plate grid, `model_settings.config` plates, presets A1 mini 0.4 / 0.20 mm Standard / PLA Basic, tree supports on); plus a generic 3MF per plate and an STL per part. `scripts/bbs.ts` reopens and slices it with the Bambu Studio CLI and compares plates/objects/heights.

## Modes: Auto, Target Parts, Guided Split
All three run the same search, joint planner and validation; they only add terms to the search.
- **Auto Split** — as above; the unsplit model is always a candidate.
- **Target Parts** — *Min parts* / *Max parts*. A target, not an order: if no valid split reaches it, the result says so and keeps the best valid one.
- **Guided Split** (`src/core/hints.ts`) — brush on the model (raycast onto the surface, stored in model coordinates, so it stays put when the view rotates):
  - *Own part* (groups via *+ New part group*): the search must end with one part holding ≥ 90 % of the brushed points that is not the bulk of the model and not much larger than the brushed area. Extra candidate planes are generated just below the brushed area (`hintPlanes`), around the direction from the part's centroid to the brush; the search keeps cutting parts that hold an unsatisfied group.
  - *Seam here*: soft bias — seam weight ×0.12 within 6 mm; a loop-like stroke also adds its least-squares plane as a candidate (then curved into nearby folds as usual).
  - *No-cut*: seam weight ×40 within 6 mm (face, strands, chain).
  - *Find Best Cuts* returns up to 3 ranked proposals; *Cut lines* shows their closed seam loops on the original (picked one red). Picking another proposal rebuilds parts, joints, orientation and plates. Changing any hint discards the previous result and export.

## Joint and fragment rules (fail loudly, never fake success)
- Input shells that **touch** (gap ≤ 0.05 mm, e.g. box-built figurines) are welded along their coplanar contact faces into one solid; the contact planes become seam candidates and their rims cheap seams. Shells that do not touch are printed separately and reported as **UNRESOLVED JOINT** (often the link between them is an open mesh dropped at import — the Lantern chain).
- A minor piece on one side of a cut that touches a piece across it (chin tip under a neck plane) is re-attached to that piece; a dowel that then lies inside one part is removed and its hole refilled. A side's largest piece is never moved.
- Thin seam islands next to a keyed island between the same two parts are aligned by that key (glue noted). Otherwise a seam island without a connector is **UNRESOLVED JOINT**: the result is marked **NOT READY** and the check fails.
- The search checks section islands on the full-resolution mesh (the proxy smooths strands away), and glue-only islands cost as much as a large visible seam.

## Known limits

- Cuts are planes, optionally bent into a nearby fold (±12 mm height field). No free-form geodesic seams: a brushed rough seam becomes its best-fit plane; seams follow natural boundaries only where such a surface can.
- Guided *Own part* is geometric: it isolates the brushed region with the cheapest valid seam near it, it does not know what a head is.
- Visibility/detail are geometric proxies; "front" is assumed to be glTF +Z. A face with little relief scores as a smooth visible surface, not as "a face".
- Support/stair/seam numbers in the app are geometric estimates, not slicer output. Slice in Bambu Studio for real support and time.
- Joint fit profile (0.2 mm radial clearance, 0.5 mm chamfer, 0.6 mm end gap) is a baseline, untested on hardware — print a test joint first.
