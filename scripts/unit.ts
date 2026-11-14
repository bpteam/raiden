// Self-checks for the geometric building blocks on simple solids (function tests; real-model checks live in e2e/report).
import assert from 'node:assert/strict';
import { Matrix4 } from 'three';
import { loadManifold } from '../src/core/geom';
import { planJoints } from '../src/core/joints';
import { analyzeSurface, partMesh, evenOut } from '../src/core/analysis';
import { candidatePlanes } from '../src/core/cuts';
import { bestOrient } from '../src/core/orient';
import { makePart, search, mergeStrays } from '../src/core/search';
import { strokePlane } from '../src/core/hints';
import { pack } from '../src/core/pack';

const w = await loadManifold();
const { Manifold } = w;
const hull = (m: InstanceType<typeof Manifold>) => { const g = m.hull().getMesh(); return Float32Array.from({ length: g.numVert * 3 }, (_, i) => g.vertProperties[Math.floor(i / 3) * g.numProp + (i % 3)]); };

// --- visibility: body surface under a cape hem is hidden, the open body surface is not
{
  const body = Manifold.cylinder(100, 20, 20, 96);
  const cape = body.add(Manifold.cylinder(12, 25, 25, 96).subtract(Manifold.cylinder(12, 23, 23, 96)).translate([0, 0, 50])).add(Manifold.cylinder(2, 25, 25, 96).translate([0, 0, 62]));
  const f = analyzeSurface(cape);
  const pm = partMesh(evenOut(cape), f, []);
  const avg = (z0: number, z1: number) => { let s = 0, a = 0; for (let i = 0; i < pm.nt; i++) { const r = Math.hypot(pm.cx[i * 3], pm.cx[i * 3 + 1]); if (Math.abs(r - 20) < 0.5 && pm.cx[i * 3 + 2] > z0 && pm.cx[i * 3 + 2] < z1 && Math.abs(pm.nrm[i * 3 + 2]) < 0.2) { s += pm.V[i] * pm.area[i]; a += pm.area[i]; } } return s / a; };
  const open = avg(20, 40), under = avg(54, 60);
  assert.ok(under < 0.35 * open, `surface under the cape hem is much less visible (under ${under.toFixed(2)} vs open ${open.toFixed(2)})`);
}

// --- seam candidates: a dumbbell is cut through its neck, not through a ball
{
  const db = Manifold.sphere(25, 64).translate([0, 0, 25]).add(Manifold.cylinder(30, 6, 6, 48).translate([0, 0, 45])).add(Manifold.sphere(25, 64).translate([0, 0, 95]));
  const f = analyzeSurface(db);
  const c = candidatePlanes(partMesh(evenOut(db), f, []), 3, false)[0];
  const zAt = c.h / c.n[2];
  assert.ok(Math.abs(c.n[2]) > 0.9 && zAt > 48 && zAt < 73, `best seam is across the neck or in its crease (n=${c.n.map((x) => x.toFixed(2))}, z≈${zAt.toFixed(1)})`);
}

// --- orientation: a dome prints flat side down
{
  const dome = Manifold.sphere(30, 64).trimByPlane([0, 0, 1], 0);
  const f = analyzeSurface(dome);
  const pm = partMesh(evenOut(dome), f, []);
  const { best } = bestOrient(pm, hull(dome), []);
  assert.ok(best.down[2] < -0.99 && best.supportArea < 1, `dome prints flat face down (down=${best.down.map((x) => x.toFixed(2))}, support ${best.supportArea.toFixed(0)})`);
}

// --- search: a part that fits and prints cleanly is not split
{
  const box = Manifold.cube([40, 40, 60], true).translate([0, 0, 30]);
  const f = analyzeSurface(box);
  const r = search(makePart(box, f, []), f, { beam: 3, perPart: 4, maxParts: 4, qualityCuts: 2 });
  assert.equal(r.best.parts.length, 1, 'clean box stays one piece');
  const tall = Manifold.cube([40, 40, 300], true).translate([0, 0, 150]);
  const f2 = analyzeSurface(tall);
  const r2 = search(makePart(tall, f2, []), f2, { beam: 3, perPart: 4, maxParts: 6, qualityCuts: 0 });
  assert.ok(r2.best.feasible && r2.best.parts.length === 2, `300 mm bar → 2 fitting parts (got ${r2.best.parts.length}, feasible ${r2.best.feasible})`);
}

// --- packing: real footprints, no overlaps, gap respected, multiple plates when needed
{
  const sq = Manifold.cube([70, 70, 10]);
  const soup = (m: InstanceType<typeof Manifold>) => m.project().toPolygons() as number[][][];
  const r = pack(Array.from({ length: 6 }, (_, id) => ({ id, polys: soup(sq), brim: false })), 5);
  assert.equal(r.plates, 2, `6 × 70 mm squares need 2 plates (got ${r.plates})`);
  const boxes = r.placements.map((p) => { const c = Math.cos(p.yaw), s = Math.sin(p.yaw); const xs = [[0, 0], [70, 0], [0, 70], [70, 70]].map(([x, y]) => [c * x - s * y + p.x, s * x + c * y + p.y]); return { p, x0: Math.min(...xs.map((q) => q[0])), x1: Math.max(...xs.map((q) => q[0])), y0: Math.min(...xs.map((q) => q[1])), y1: Math.max(...xs.map((q) => q[1])) }; });
  for (const b of boxes) assert.ok(b.x0 >= 0 && b.y0 >= 0 && b.x1 <= 180 && b.y1 <= 180, 'inside bed');
  for (const a of boxes) for (const b of boxes) if (a !== b && a.p.plate === b.p.plate) assert.ok(a.x1 + 4.9 <= b.x0 || b.x1 + 4.9 <= a.x0 || a.y1 + 4.9 <= b.y0 || b.y1 + 4.9 <= a.y0, 'gap ≥ 5 mm');
  // an L-shape and a square nest into the L's notch only if packing uses the real footprint
  const L = Manifold.cube([150, 40, 10]).add(Manifold.cube([40, 150, 10]));
  const r2 = pack([{ id: 0, polys: soup(L), brim: false }, { id: 1, polys: soup(Manifold.cube([90, 90, 10])), brim: false }], 5);
  assert.equal(r2.plates, 1, 'square nests inside the L (shape-aware, not bounding boxes)');
}

// --- dowels (unchanged behaviour)
{
  const big = Manifold.cylinder(100, 30, 30, 96);
  const pins = planJoints(w, big.slice(50), big, new Matrix4(), 50);
  assert.ok(pins.length >= 2, `wide section gets ≥2 dowels (got ${pins.length})`);
  for (const p of pins) assert.ok(Math.hypot(p.p[0], p.p[1]) + p.r + 1.6 <= 30, 'dowel keeps wall to the surface');
  const thin = Manifold.cylinder(100, 3, 3, 48);
  assert.equal(planJoints(w, thin.slice(50), thin, new Matrix4(), 50).length, 0, 'too-thin island gets no dowel (reported as glue-only)');
  const flat = Manifold.cube([60, 60, 8], true);
  for (const p of planJoints(w, flat.slice(0), flat, new Matrix4(), 0)) assert.ok(p.depth <= 4, `shallow part shrinks hole depth (got ${p.depth})`);
}
// --- stray fragments: a chin lobe that dips below a neck plane goes back to the head, a cut-off hand stays cut
{
  const head = Manifold.sphere(20, 64).translate([0, 0, 40]).add(Manifold.sphere(6, 32).translate([0, 12, 22])); // chin lobe reaches z≈16
  const torso = Manifold.cube([30, 30, 20], true).translate([0, -25, 10]);
  const body = head.add(Manifold.cylinder(30, 6, 6, 32).translate([0, 0, 0])).add(torso);
  const [up, dn] = body.splitByPlane([0, 0, 1], 19);
  const pieces = [...up.decompose().map((m) => ({ m, side: 1 })), ...dn.decompose().map((m) => ({ m, side: -1 }))];
  assert.ok(pieces.length >= 3, `plane leaves a separate chin piece (pieces ${pieces.length})`);
  const r = mergeStrays(pieces);
  assert.equal(r.pieces.length, 2, 'chin re-attached: exactly head + body remain');
  const hand = Manifold.cube([10, 10, 40], true).translate([0, 0, 20]);
  const [a, b] = hand.splitByPlane([0, 0, 1], 30);
  assert.equal(mergeStrays([{ m: a, side: 1 }, { m: b, side: -1 }]).pieces.length, 2, 'a lone small piece (hand) is never merged back');
}

// --- rough seam stroke: noisy ring around z=5 gives the plane z=5; a straight line gives none
{
  const ring = Array.from({ length: 24 }, (_, i) => [10 * Math.cos(i / 4), 10 * Math.sin(i / 4), 5 + 0.3 * Math.sin(i * 7)]);
  const pl = strokePlane(ring)!;
  assert.ok(pl && pl.n[2] > 0.98 && Math.abs(pl.h - 5) < 0.5, `stroke plane z≈5 (n=${pl?.n.map((x) => x.toFixed(2))}, h=${pl?.h.toFixed(2)})`);
  assert.equal(strokePlane([[0, 0, 0], [1, 1, 1], [2, 2, 2], [3, 3, 3]]), null, 'collinear stroke defines no plane');
}
console.log('unit: all checks passed');
