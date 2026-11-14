// Dowel joints: blind holes across a planar seam plus separate printed dowels. Every hole is verified to stay inside
// material on both sides before it is cut. Baseline fit profile (0.4 mm nozzle, PLA-class, untested on hardware):
//   radial clearance 0.2 mm, 0.5 mm 45° mouth chamfer, 0.6 mm total end gap, ≥1.6 mm wall to any surface.
// Adjust JOINT for your printer/material after printing one test joint; no nominal tolerance fits every machine.
import { Matrix4, Quaternion, Vector3 } from 'three';
import type { Manifold, CrossSection, Vec2 } from 'manifold-3d';
import type { Wasm } from './geom';

export const JOINT = { minPinR: 1.5, maxPinR: 4, clearance: 0.2, minDepth: 4, maxDepth: 14, wall: 1.6, endGap: 0.6 };
export const rotTo = (from: number[], to: number[]) => new Matrix4().makeRotationFromQuaternion(new Quaternion().setFromUnitVectors(new Vector3(...from).normalize(), new Vector3(...to).normalize()));
export const mat = (m: Matrix4) => m.elements as unknown as Parameters<Manifold['transform']>[0];

type Pt = Vec2;
export const inPolys = (p: Pt, polys: Pt[][]) => {
  let inside = false;
  for (const poly of polys) for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
};
const distToPolys = (p: Pt, polys: Pt[][]) => {
  let d = Infinity;
  for (const poly of polys) for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const abx = b[0] - a[0], aby = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / (abx * abx + aby * aby || 1)));
    d = Math.min(d, Math.hypot(p[0] - a[0] - t * abx, p[1] - a[1] - t * aby));
  }
  return d;
};

/** Largest inscribed circle radius of an island (binary search on inward offset). */
function inscribedRadius(isl: CrossSection): number {
  const b = isl.bounds();
  let lo = 0, hi = Math.min(b.max[0] - b.min[0], b.max[1] - b.min[1]) / 2;
  for (let i = 0; i < 12; i++) { const mid = (lo + hi) / 2; const o = isl.offset(-mid, 'Round'); if (o.isEmpty()) hi = mid; else lo = mid; o.delete(); }
  return lo;
}

export interface PinPlan { p: Pt; r: number; depth: number; shape: 'round' | 'square' }

/**
 * Dowel layout for one section island: radius from the inscribed circle, 2–3 pins spread far apart (locks rotation),
 * each hole depth shrunk until the hole is verified to stay inside material on both sides. A single surviving pin becomes a square key.
 */
/** hAt: height of the cutting surface at (x, y) in the cut frame (curved seams); default: the plane z = h. */
export function planJoints(w: Wasm, isl: CrossSection, body: Manifold, inv: Matrix4, h: number, hAt: (x: number, y: number) => number = () => h): PinPlan[] {
  const Rin = inscribedRadius(isl);
  const maxR = Rin - JOINT.clearance - JOINT.wall - 0.2;
  if (maxR < JOINT.minPinR) return [];
  const r = Math.min(JOINT.maxPinR, Math.max(JOINT.minPinR, Math.round(Math.min(maxR, Rin * 0.3) * 2) / 2));
  const inset = isl.offset(-(r + JOINT.clearance + JOINT.wall), 'Round');
  const ipolys = inset.toPolygons() as Pt[][];
  const polys = isl.toPolygons() as Pt[][];
  const bb = inset.bounds();
  const step = Math.max(r * 0.75, Math.sqrt(Math.max(inset.area(), 1)) / 14);
  const cand: { p: Pt; edge: number }[] = [];
  for (let x = bb.min[0]; x <= bb.max[0] + 1e-9; x += step) for (let y = bb.min[1]; y <= bb.max[1] + 1e-9; y += step) {
    const p: Pt = [x, y];
    if (inPolys(p, ipolys)) cand.push({ p, edge: distToPolys(p, polys) });
  }
  if (!cand.length) { const c: Pt = [(bb.min[0] + bb.max[0]) / 2, (bb.min[1] + bb.max[1]) / 2]; if (inPolys(c, ipolys)) cand.push({ p: c, edge: distToPolys(c, polys) }); }
  inset.delete();
  const want = isl.area() > 2500 && Rin > 12 ? 3 : 2;
  const spacing = 2 * (r + JOINT.clearance) + 4;
  const depth0 = Math.min(JOINT.maxDepth, Math.max(JOINT.minDepth, r * 3));
  const tryHole = (p: Pt, shape: 'round' | 'square'): PinPlan | null => {
    for (const f of [1, 0.8, 0.65, 0.5]) {
      const depth = Math.max(JOINT.minDepth * 0.75, depth0 * f);
      const hole = holeSolid(w, shape, r, depth).translate([p[0], p[1], hAt(p[0], p[1])]).transform(mat(inv));
      const inside = hole.intersect(body).volume() / hole.volume();
      hole.delete();
      if (inside > 0.9995) return { p, r, depth, shape }; // must not break through the visible surface
    }
    return null;
  };
  const chosen: PinPlan[] = [];
  const pool = [...cand];
  while (chosen.length < want && pool.length) {
    // First pin at the deepest point; next ones maximise distance to chosen pins (rotation lock), with a preference for thick material.
    pool.sort((a, b) => score(b) - score(a));
    const c = pool.shift()!;
    if (chosen.some((q) => Math.hypot(q.p[0] - c.p[0], q.p[1] - c.p[1]) < spacing)) continue;
    const plan = tryHole(c.p, 'round');
    if (plan) chosen.push(plan);
  }
  function score(c: { p: Pt; edge: number }) {
    if (!chosen.length) return c.edge;
    return Math.min(...chosen.map((q) => Math.hypot(q.p[0] - c.p[0], q.p[1] - c.p[1]))) + 0.5 * c.edge;
  }
  if (chosen.length === 1) { const key = tryHole(chosen[0].p, 'square'); if (key) chosen[0] = key; }
  return chosen;
}

const CHAMFER = 0.5;
/** Blind hole spanning both sides of the plane at z=0, with a 45° mouth chamfer (absorbs elephant foot, guides the pin). */
export function holeSolid(w: Wasm, shape: 'round' | 'square', r: number, depth: number): Manifold {
  const R = r + JOINT.clearance, len = 2 * (depth + JOINT.endGap / 2);
  if (shape === 'square') return w.Manifold.cube([2 * R * 0.8 + 2 * JOINT.clearance * 0.2, 2 * R * 0.8 + 2 * JOINT.clearance * 0.2, len], true);
  const body = w.Manifold.cylinder(len, R, R, 48, true);
  const up = w.Manifold.cylinder(CHAMFER, R + CHAMFER, R, 48, false);
  const down = w.Manifold.cylinder(CHAMFER, R, R + CHAMFER, 48, false).translate([0, 0, -CHAMFER]);
  return w.Manifold.union([body, up, down]);
}
/** Dowel in local frame (axis = z). Round dowels get chamfered ends and a flat on -y so they print lying down: layers along the axis, no shear failure at the seam. */
export function dowelSolid(w: Wasm, shape: 'round' | 'square', r: number, depth: number): Manifold {
  const len = 2 * depth - JOINT.endGap;
  if (shape === 'square') return w.Manifold.cube([2 * r * 0.8, 2 * r * 0.8, len], true);
  const c = Math.min(0.5, r * 0.25);
  const core = w.Manifold.hull([w.Manifold.cylinder(len - 2 * c, r, r, 48, true), w.Manifold.cylinder(len, r - c, r - c, 48, true)]);
  const flat = r * 0.15;
  return core.trimByPlane([0, 1, 0], -(r - flat));
}

