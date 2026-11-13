# raiden — browser-only auto splitter for Bambu Lab A1 Mini

Load a model, press **Auto Prepare**, get printable parts with dowel joints, oriented and packed on 180×180×180 mm plates. Everything runs client-side (Web Worker + manifold-3d WASM); no backend.

```bash
npm install
npm run dev        # http://localhost:5173
npm run e2e -- models/woman_seated_v16.glb 250   # node E2E: import → split → export → re-import
```

Libraries: [manifold-3d](https://github.com/elalish/manifold) (Apache-2.0: booleans, plane split, slicing), three.js (MIT: view), glTF-Transform + meshoptimizer (MIT: GLB import), fflate (MIT: 3MF/ZIP).

Pipeline (`src/core/prepare.ts`): weld + watertight check (winding repair, open parts reported, never silently fixed) → if it fits, print whole → else greedy plane-cut search over 7 normals × 24 offsets (scores: relative cross-section = necks/waists, progress to fit, pin feasibility, slivers) → blind holes + separate dowels (verified inside material, wall ≥1.6 mm) → checks (volume, overlap, manifold, assembly sweep, bed fit) → orientation (cut face down preferred, minimal >45° overhang area) → shelf packing → STL per part + 3MF per plate.

Known limits: planar cuts only; no semantic seam placement (faces/hair/clothes); support estimate is overhang area, not slicer output; joint clearance 0.15 mm untested on hardware — print a test joint.
