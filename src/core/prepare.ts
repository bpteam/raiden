// Auto Prepare pipeline: decide cuts, cut, add pin joints, verify assembly, orient, pack onto A1 Mini plates.
// Geometry ops are delegated to manifold-3d (booleans, plane split, slicing); this file only decides *where*.
// shortcut: wasm objects are not .delete()'d; the worker is terminated after every run, which frees the heap.
import { Matrix4, Quaternion, Vector3 } from 'three';
import type { Manifold, CrossSection, Vec2 } from 'manifold-3d';
import type { Wasm } from './geom';

export const A1_MINI = { x: 180, y: 180, z: 180 };
const USABLE = 176; // 2 mm safety margin per side
// A cut face on the bed is flat, hidden, support-free and keeps dowel holes vertical (round, accurate). Worth ~15 cm² of extra support elsewhere.
const CUT_DOWN_BONUS = 1500;
// Internal defaults for 0.4 mm nozzle PLA-class material. Test-print a joint first: printers differ.
export const JOINT = { minPinR: 1.5, maxPinR: 4, clearance: 0.2, minDepth: 4, maxDepth: 14, wall: 1.6, endGap: 0.6 };

export interface Cut { id: number; normal: number[]; offset: number; pins: PinInfo[]; area: number; islands: number; glueOnlyIslands: number; seamLength: number; hidden: number }
export interface PinInfo { center: number[]; axis: number[]; r: number; depth: number; shape: 'round' | 'square'; verified: boolean }
export interface PartOut {
  id: number; name: string; role: 'body' | 'pin';
  solid: Manifold;            // in model (assembled) frame
  placed?: Manifold;          // oriented + placed on its plate
  plate: number; orient: Matrix4; place: Matrix4; // assembled -> plate frame = place * orient
  cutFaces: { normal: number[]; offset: number }[]; // planes on this part's boundary (seams), outward normals
  supportArea: number; bedContact: number; height: number; volume: number;
}
export interface PrepareResult {
  scale: number; parts: PartOut[]; cuts: Cut[]; plates: number; decision: string; warnings: string[]; checks: Record<string, string>;
  /** Reverse cut order: join sub-assembly `a` (side the normal points to) onto `b` by moving it along -dir. Pins of that cut go into `b` first. */
  assemblyOrder: { cut: number; dir: number[]; a: number[]; b: number[]; pins: number[]; ok: boolean }[];
}
type Progress = (stage: string, frac: number) => void;

const rotTo = (from: number[], to: number[]) => new Matrix4().makeRotationFromQuaternion(new Quaternion().setFromUnitVectors(new Vector3(...from).normalize(), new Vector3(...to).normalize()));
const mat = (m: Matrix4) => m.elements as unknown as Parameters<Manifold['transform']>[0];
const dims = (m: Manifold) => { const b = m.boundingBox(); return [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]]; };

// ---------- orientation ----------
interface Orient { rot: Matrix4; support: number; contact: number; height: number; fits: boolean; score: number }

/** Downward-facing area that would need support (faces steeper than 45° overhang, excluding bed-touching faces). */
function overhang(m: Manifold): { support: number; contact: number; height: number; d: number[] } {
  const mesh = m.getMesh();
  const p = mesh.vertProperties, np = mesh.numProp, tv = mesh.triVerts;
  const b = m.boundingBox();
  const zmin = b.min[2];
  let support = 0, contact = 0;
  const c45 = Math.cos(Math.PI / 4);
  for (let t = 0; t < mesh.numTri; t++) {
    const [a, bb, c] = [0, 1, 2].map((j) => { const v = tv[t * 3 + j] * np; return [p[v], p[v + 1], p[v + 2]]; });
    const u = [bb[0] - a[0], bb[1] - a[1], bb[2] - a[2]], w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    const len = Math.hypot(n[0], n[1], n[2]);
    if (!len) continue;
    const area = len / 2, nz = n[2] / len;
    const onBed = Math.max(a[2], bb[2], c[2]) - zmin < 0.2;
    if (nz < -0.99 && onBed) contact += area;
    else if (nz < -c45) support += area;
  }
  return { support, contact, height: b.max[2] - b.min[2], d: [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]] };
}

function candidateDirs(cutFaces: { normal: number[] }[]): number[][] {
  const axes = [[0, 0, -1], [0, 0, 1], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0]];
  for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) axes.push([x, y, z].map((v) => v / Math.sqrt(3)));
  return [...cutFaces.map((c) => c.normal), ...axes];
}

/** Try orientations putting each candidate direction downward, plus yaw 0/45° for bed fit. Cut faces down are preferred: flat, hidden, support-free. */
function bestOrientation(m: Manifold, cutFaces: { normal: number[] }[]): Orient {
  let best: Orient | null = null;
  const cuts = new Set(cutFaces.map((c) => c.normal.join()));
  const hull = m.hull();
  for (const d of candidateDirs(cutFaces)) {
    const down = rotTo(d, [0, 0, -1]);
    const tm = m.transform(mat(down));
    const o = overhang(tm); // support area does not depend on yaw, so compute once per direction
    tm.delete();
    // Yaw only matters for the bed footprint: search it on the convex hull (5° steps), keep the smallest footprint that fits.
    let rot: Matrix4 | null = null, foot = Infinity;
    for (let yaw = 0; yaw < 180; yaw += 5) {
      const r = new Matrix4().makeRotationZ((yaw * Math.PI) / 180).multiply(down);
      const t = hull.transform(mat(r));
      const e = dims(t);
      t.delete();
      if (e[0] <= USABLE && e[1] <= USABLE && e[2] <= USABLE && e[0] * e[1] < foot) { foot = e[0] * e[1]; rot = r; }
    }
    const fits = !!rot;
    // Support touching visible surfaces is the main quality cost; low contact on tall parts risks tipping.
    const tip = o.contact < 1e-6 ? 50 : Math.max(0, o.height / Math.sqrt(o.contact) - 8) * 2;
    const score = (fits ? 0 : 1e9) + o.support + tip * 10 + o.height * 0.5 - (cuts.has(d.join()) ? CUT_DOWN_BONUS : 0);
    if (!best || score < best.score) best = { rot: rot ?? down, support: o.support, contact: o.contact, height: o.height, fits, score };
  }
  hull.delete();
  return best!;
}

/** Can this piece stand on its seam (outward normal `down`) and still fit the bed, with some yaw? */
function fitsSeamDown(m: Manifold, down: number[]): boolean {
  const h = m.hull();
  const base = rotTo(down, [0, 0, -1]);
  let ok = false;
  for (let yaw = 0; yaw < 180 && !ok; yaw += 15) {
    const t = h.transform(mat(new Matrix4().makeRotationZ((yaw * Math.PI) / 180).multiply(base)));
    ok = dims(t).every((x) => x <= USABLE);
    t.delete();
  }
  h.delete();
  return ok;
}

/** Lower-bound-ish estimate of how many bed-sized pieces this solid needs: Π⌈extent/176⌉ at its best of a few orientations. */
function estParts(m: Manifold): number {
  const h = m.hull();
  let best = Infinity;
  for (const r of EST_ROTS) {
    const t = h.transform(mat(r));
    best = Math.min(best, dims(t).reduce((a, d) => a * Math.max(1, Math.ceil((d - 0.5) / USABLE)), 1));
    t.delete();
  }
  h.delete();
  return best;
}
const EST_ROTS = [new Matrix4(), new Matrix4().makeRotationZ(Math.PI / 4), new Matrix4().makeRotationX(Math.PI / 4), new Matrix4().makeRotationY(Math.PI / 4),
  new Matrix4().makeRotationX(Math.PI / 4).multiply(new Matrix4().makeRotationZ(Math.PI / 4))];

function fitsSomehow(m: Manifold): boolean {
  if (Math.max(...dims(m)) <= USABLE) return true;
  const h = m.hull(); // rotations of the convex hull give the same bounding boxes, much cheaper
  // Sampled rotational check (15° steps).
  for (let ax = 0; ax < 12; ax++) for (let ay = 0; ay < 12; ay++) {
    const r = new Matrix4().makeRotationX((ax * Math.PI) / 12).multiply(new Matrix4().makeRotationY((ay * Math.PI) / 12));
    const t = h.transform(mat(r));
    const e = dims(t);
    t.delete();
    if (e.every((x) => x <= USABLE)) { h.delete(); return true; }
  }
  h.delete();
  return false;
}

// ---------- cut search ----------
interface Candidate { normal: number[]; offset: number; cost: number; area: number; islands: CrossSection[]; frame: Matrix4; seamLength: number; hidden: number }
interface Section { h: number; area: number; per: number; covered: number; big: number; small: number; thin: number }

// Plane normals over a hemisphere: vertical, 20° and 40° tilts at 8 azimuths, horizontal at 8 azimuths.
const CUT_NORMALS: number[][] = [[0, 0, 1]];
for (const tilt of [20, 40, 90]) for (let a = 0; a < 8; a++) {
  const t = (tilt * Math.PI) / 180, az = (a * Math.PI) / 4;
  CUT_NORMALS.push([Math.sin(t) * Math.cos(az), Math.sin(t) * Math.sin(az), Math.cos(t)]);
}
// keep one of each ± pair for horizontal normals (same plane family)
const NORMALS = CUT_NORMALS.filter((n) => !(Math.abs(n[2]) < 1e-9 && (n[0] < -1e-9 || (Math.abs(n[0]) < 1e-9 && n[1] < 0))));

const perimeter = (cs: CrossSection) => cs.toPolygons().reduce((s, poly) => s + poly.reduce((t, p, i) => { const q = poly[(i + 1) % poly.length]; return t + Math.hypot(q[0] - p[0], q[1] - p[1]); }, 0), 0);

/**
 * Fraction of seam length hidden under overlapping geometry: a seam point is hidden when the solid just above or just below
 * extends past it (cape/skirt hem, collar, hair, sleeve cuff). Measured by sampling edge midpoints against neighbouring slices.
 */
export function coveredFraction(cs: CrossSection, upper: CrossSection, lower: CrossSection, delta: number): number {
  const polys = cs.toPolygons() as Vec2[][];
  const U = upper.toPolygons() as Vec2[][], D = lower.toPolygons() as Vec2[][];
  const edges: [Vec2, Vec2, number][] = [];
  for (const poly of polys) for (let i = 0; i < poly.length; i++) { const a = poly[i], b = poly[(i + 1) % poly.length]; edges.push([a, b, Math.hypot(b[0] - a[0], b[1] - a[1])]); }
  const stride = Math.max(1, Math.floor(edges.length / 160));
  const reach = 10; // mm: an overlapping hem/collar/hair lip within this distance hides the seam
  let tot = 0, hid = 0;
  for (let e = 0; e < edges.length; e += stride) {
    const [a, b, l] = edges[e];
    if (!l) continue;
    const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
    let nx = (b[1] - a[1]) / l, ny = -(b[0] - a[0]) / l;
    if (inPolys([mx + nx * 0.05, my + ny * 0.05], polys)) { nx = -nx; ny = -ny; } // make it point outward
    const hiddenBy = (P: Vec2[][]) => {
      // Walk outward from the seam at a neighbouring height. Air then material = a lip overhanging the seam.
      // Material straight away is just the surface sloping; it only hides the seam when it juts out much further than it rises.
      let sawAir = false, solidRun = 0;
      for (let d = 0.5; d <= reach; d += 0.75) {
        const inside = inPolys([mx + nx * d, my + ny * d], P);
        if (inside && sawAir) return true;
        if (!inside) { sawAir = true; if (solidRun) break; } else solidRun = d;
      }
      return !sawAir ? true : solidRun >= 2.5 * delta;
    };
    tot += l;
    if (hiddenBy(U) || hiddenBy(D)) hid += l;
  }
  return tot ? hid / tot : 0;
}

/** Seam statistics of one planar section: seam length, hidden share, island structure, islands that cannot take any keyed joint. */
function sectionStats(cs: CrossSection, h: number, upper?: CrossSection, lower?: CrossSection, delta?: number): Section & { islands: CrossSection[] } {
  const islands = cs.decompose();
  const areas = islands.map((i) => i.area());
  const maxA = Math.max(...areas, 0);
  let big = 0, small = 0, thin = 0;
  islands.forEach((isl, k) => {
    if (areas[k] >= maxA * 0.12) big++; else small++;
    if (isl.offset(-(JOINT.minPinR + JOINT.clearance + JOINT.wall), 'Round').isEmpty()) thin++;
  });
  return { h, area: cs.area(), per: perimeter(cs), covered: upper && lower && delta ? coveredFraction(cs, upper, lower, delta) : 0, big, small, thin, islands };
}

/** Cost of the seam itself (lower = less visible, stronger joint). Pure 2D, cheap. */
function seamCost(s: Section, prev: Section | undefined, next: Section | undefined, whole: number, n: number[]): number {
  // Short seams hide better; a perimeter local minimum is a neck/waist/crease where the eye expects a line anyway.
  const crease = prev && next && s.per <= prev.per && s.per <= next.per ? -10 - 20 * Math.max(0, 1 - s.per / ((prev.per + next.per) / 2)) : 0;
  // Only the visible part of the seam counts fully; a seam tucked under a hem/collar is nearly free.
  return 35 * (s.per / whole) * (1 - 0.85 * s.covered) - 15 * s.covered + crease
    + 40 * s.small     // slicing through a thin limb/strand: extra visible ring, fragile unkeyed joint
    + 12 * Math.max(0, s.big - 1)
    + 50 * s.thin
    + 6 * (1 - Math.abs(n[2]));
}

function findCut(m: Manifold, onProgress: (f: number) => void): Candidate | null {
  const total = m.volume();
  const whole = Math.max(...dims(m));
  // Search on a simplified proxy (fast); the final section is re-sliced on the real mesh.
  const proxy = m.numTri() > 20000 ? m.simplify(whole * 0.0015) : m;
  const SAMPLES = 48;
  const DELTA = Math.min(3, whole / 80); // hem/collar overlap probe distance (mm)
  type Scored = { n: number[]; h: number; seam: number; est: number; frame: Matrix4 };
  const pool: Scored[] = [];
  NORMALS.forEach((n, ni) => {
    onProgress((ni / NORMALS.length) * 0.6);
    const frame = rotTo(n, [0, 0, 1]);
    const r = proxy.transform(mat(frame));
    const b = r.boundingBox();
    const len = b.max[2] - b.min[2];
    if (len <= 1) { r.delete(); return; }
    const secs: Section[] = [];
    for (let i = 1; i < SAMPLES; i++) {
      const h = b.min[2] + (len * i) / SAMPLES;
      const cs = r.slice(h), up = r.slice(h + DELTA), dn = r.slice(h - DELTA);
      const st = sectionStats(cs, h, up, dn, DELTA);
      st.islands.forEach((x) => x.delete()); cs.delete(); up.delete(); dn.delete();
      secs.push(st);
    }
    r.delete();
    // Cheap progress estimate: the longer half along the normal must shrink toward the bed size.
    // Other extents stay roughly as they are, so a cut across the wrong axis earns nothing.
    const ex = b.max[0] - b.min[0], ey = b.max[1] - b.min[1];
    const cp = (...d: number[]) => d.reduce((a, x) => a * Math.max(1, Math.ceil((x - 0.5) / USABLE)), 1);
    const progress1 = (h: number) => 120 * (cp(h - b.min[2], ex, ey) + cp(b.max[2] - h, ex, ey) - 1) * 0.5; // bbox-based, pessimistic: half weight
    const scored = secs.map((s, i) => ({ n, h: s.h, frame, seam: s.area > 0 ? seamCost(s, secs[i - 1], secs[i + 1], whole, n) : Infinity, est: 0 }))
      .filter((x) => Number.isFinite(x.seam));
    scored.forEach((x) => (x.est = x.seam + progress1(x.h)));
    scored.sort((a, b) => a.est - b.est);
    // Best candidates of this direction go to the exact 3D evaluation, plus the best balanced ones (tips have short seams but make no progress).
    const balanced = scored.filter((x) => Math.min(x.h - b.min[2], b.max[2] - x.h) > len * 0.25).slice(0, 4);
    pool.push(...new Set([...scored.slice(0, 8), ...balanced]));
  });

  const full = (n: number[], h: number, frame: Matrix4, sliver = 0.03): number => {
    const r = proxy.transform(mat(frame));
    const [above, below] = r.splitByPlane([0, 0, 1], h);
    const va = above.volume(), vb = below.volume();
    // Expected final part count after this cut: slicing off thin slabs leaves the big problem untouched.
    const parts = estParts(above) + estParts(below);
    // A piece that cannot stand on its own seam must print with the seam (and its holes) sideways: worse fit, more support.
    const notDown = (fitsSeamDown(above, [0, 0, -1]) ? 0 : 1) + (fitsSeamDown(below, [0, 0, 1]) ? 0 : 1);
    const ta = above.boundingBox(), tb = below.boundingBox();
    const slab = Math.min(ta.max[2] - h, h - tb.min[2]) < 25 ? 1 : 0; // thin washers: weak, extra seam for little gain
    above.delete(); below.delete(); r.delete();
    if (Math.min(va, vb) < total * sliver) return Infinity; // no slivers
    return (parts - 1) * 120 + notDown * 60 + slab * 60 + 10 * Math.abs(va - vb) / total;
  };
  const seamAt = (n: number[], h: number, frame: Matrix4, step: number) => {
    const r = proxy.transform(mat(frame));
    const st = [h - step, h, h + step].map((x) => { const cs = r.slice(x), up = r.slice(x + DELTA), dn = r.slice(x - DELTA); const s = sectionStats(cs, x, up, dn, DELTA); s.islands.forEach((i) => i.delete()); [cs, up, dn].forEach((c) => c.delete()); return s; });
    r.delete();
    return st[1].area > 0 ? seamCost(st[1], st[0], st[2], whole, n) : Infinity;
  };
  pool.sort((a, b) => a.est - b.est);
  const evalPool = (sliver: number) => pool.slice(0, 80).map((c, i) => { onProgress(0.6 + 0.25 * (i / 80)); return { ...c, cost: c.seam + full(c.n, c.h, c.frame, sliver) }; })
    .filter((c) => Number.isFinite(c.cost)).sort((a, b) => a.cost - b.cost);
  let ranked = evalPool(0.03);
  if (!ranked.length) ranked = evalPool(0.005);
  if (!ranked.length) { if (proxy !== m) proxy.delete(); return null; }
  // Local refinement around the 3 best: tilt the plane ±8° and slide it ±1.5% of size.
  const refined = [...ranked];
  for (const c of ranked.slice(0, 3)) {
    const t = new Vector3(...c.n);
    const u = new Vector3().crossVectors(t, Math.abs(t.z) < 0.9 ? new Vector3(0, 0, 1) : new Vector3(1, 0, 0)).normalize();
    const v = new Vector3().crossVectors(t, u);
    for (const [du, dv, dh] of [[0, 0, -1], [0, 0, 1], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0]]) {
      const n = t.clone().addScaledVector(u, du * 0.14).addScaledVector(v, dv * 0.14).normalize().toArray();
      const frame = rotTo(n, [0, 0, 1]);
      // re-express the plane offset in the new frame through the same anchor point
      const anchor = new Vector3(0, 0, c.h).applyMatrix4(c.frame.clone().invert());
      const h = anchor.dot(new Vector3(...n)) + dh * whole * 0.015;
      const cost = seamAt(n, h, frame, whole / SAMPLES) + full(n, h, frame);
      if (Number.isFinite(cost)) refined.push({ n, h, frame, seam: 0, est: 0, cost });
    }
  }
  onProgress(0.95);
  ranked = refined.sort((a, b) => a.cost - b.cost);
  const best = ranked[0];
  if (proxy !== m) proxy.delete();
  const r = m.transform(mat(best.frame));
  const cs = r.slice(best.h), up = r.slice(best.h + DELTA), dn = r.slice(best.h - DELTA);
  const st = sectionStats(cs, best.h, up, dn, DELTA);
  r.delete(); up.delete(); dn.delete();
  return { normal: best.n, offset: best.h, cost: best.cost, area: st.area, islands: st.islands, frame: best.frame, seamLength: st.per, hidden: st.covered };
}

// ---------- joints ----------
type Pt = Vec2;
const inPolys = (p: Pt, polys: Pt[][]) => {
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
export function planJoints(w: Wasm, isl: CrossSection, body: Manifold, inv: Matrix4, h: number): PinPlan[] {
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
      const hole = holeSolid(w, shape, r, depth).translate([p[0], p[1], h]).transform(mat(inv));
      const inside = hole.intersect(body).volume() / hole.volume();
      hole.delete();
      if (inside > 0.995) return { p, r, depth, shape };
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
function holeSolid(w: Wasm, shape: 'round' | 'square', r: number, depth: number): Manifold {
  const R = r + JOINT.clearance, len = 2 * (depth + JOINT.endGap / 2);
  if (shape === 'square') return w.Manifold.cube([2 * R * 0.8 + 2 * JOINT.clearance * 0.2, 2 * R * 0.8 + 2 * JOINT.clearance * 0.2, len], true);
  const body = w.Manifold.cylinder(len, R, R, 48, true);
  const up = w.Manifold.cylinder(CHAMFER, R + CHAMFER, R, 48, false);
  const down = w.Manifold.cylinder(CHAMFER, R, R + CHAMFER, 48, false).translate([0, 0, -CHAMFER]);
  return w.Manifold.union([body, up, down]);
}
/** Dowel in local frame (axis = z). Round dowels get chamfered ends and a flat on -y so they print lying down: layers along the axis, no shear failure at the seam. */
function dowelSolid(w: Wasm, shape: 'round' | 'square', r: number, depth: number): Manifold {
  const len = 2 * depth - JOINT.endGap;
  if (shape === 'square') return w.Manifold.cube([2 * r * 0.8, 2 * r * 0.8, len], true);
  const c = Math.min(0.5, r * 0.25);
  const core = w.Manifold.hull([w.Manifold.cylinder(len - 2 * c, r, r, 48, true), w.Manifold.cylinder(len, r - c, r - c, 48, true)]);
  const flat = r * 0.15;
  return core.trimByPlane([0, 1, 0], -(r - flat));
}

// ---------- main ----------
export function prepare(w: Wasm, input: Manifold, scale: number, maxParts: number, progress: Progress): PrepareResult {
  const warnings: string[] = [];
  const checks: Record<string, string> = {};
  let solid = input.scale(scale);
  const b0 = solid.boundingBox();
  solid = solid.translate([-(b0.min[0] + b0.max[0]) / 2, -(b0.min[1] + b0.max[1]) / 2, -b0.min[2]]);
  const vol0 = solid.volume();

  interface Work { m: Manifold; faces: { normal: number[]; offset: number }[]; cutIds: number[]; node: number }
  let work: Work[] = [{ m: solid, faces: [], cutIds: [], node: 0 }];
  // Cut tree: every cut splits one node into child nodes; reversing it gives a sequence of joins between rigid sub-assemblies.
  const children = new Map<number, number[]>();
  const tree: { cut: number; n: number[]; above: number[]; below: number[] }[] = [];
  let nodeSeq = 0;
  const cuts: Cut[] = [];
  const pinParts: { m: Manifold; cut: number; toWorld: Matrix4; shape: 'round' | 'square' }[] = [];
  let removedHoleVol = 0;
  let decision = fitsSomehow(solid) ? 'Model fits the A1 Mini build volume in one piece: printed whole (no seams).' : '';

  let guard = 0;
  while (!decision && guard++ < maxParts) {
    const idx = work.findIndex((x) => !fitsSomehow(x.m));
    if (idx < 0) break;
    if (work.length >= maxParts) { warnings.push(`Part limit (${maxParts}) reached; some parts may not fit.`); break; }
    const it = work[idx];
    progress(`Searching cut ${cuts.length + 1}`, 0.1 + 0.5 * (cuts.length / maxParts));
    const c = findCut(it.m, (f) => progress(`Searching cut ${cuts.length + 1}`, 0.1 + 0.5 * ((cuts.length + f) / maxParts)));
    if (!c) { warnings.push('No valid cut found for an oversized part.'); break; }
    const inv = c.frame.clone().invert();
    const n = new Vector3(...c.normal).normalize().toArray();
    // Joints: blind holes across the plane + separate dowels. Each hole is verified inside material before it is cut.
    const infos: PinInfo[] = [];
    const holeList: Manifold[] = [];
    let glue = 0;
    for (const isl of c.islands) {
      const plans = planJoints(w, isl, it.m, inv, c.offset);
      if (!plans.length) glue++;
      if (plans.length === 1 && plans[0].shape === 'round') warnings.push(`Cut ${cuts.length + 1}: one island holds a single round pin (no room for a key); it can rotate — align by eye.`);
      for (const p of plans) {
        const local = new Matrix4().makeTranslation(p.p[0], p.p[1], c.offset);
        const toWorld = inv.clone().multiply(local);
        holeList.push(holeSolid(w, p.shape, p.r, p.depth).transform(mat(toWorld)));
        infos.push({ center: new Vector3().applyMatrix4(toWorld).toArray(), axis: n, r: p.r, depth: p.depth, shape: p.shape, verified: true });
        pinParts.push({ m: dowelSolid(w, p.shape, p.r, p.depth).transform(mat(toWorld)), cut: cuts.length + 1, toWorld, shape: p.shape });
      }
    }
    const holes = holeList.length ? w.Manifold.union(holeList) : null;
    if (glue) warnings.push(`Cut ${cuts.length + 1}: ${glue} section island(s) too thin for any dowel — glue-only, alignment not keyed.`);
    const offsetWorld = c.offset; // frame maps n -> z, so plane offset along n is unchanged
    let body = it.m;
    if (holes) { removedHoleVol += holes.intersect(body).volume(); body = body.subtract(holes); }
    const [above, below] = body.splitByPlane(n, offsetWorld);
    const cut: Cut = { id: cuts.length + 1, normal: n, offset: offsetWorld, pins: infos, area: c.area, islands: c.islands.length, glueOnlyIslands: glue, seamLength: c.seamLength, hidden: c.hidden };
    cuts.push(cut);
    const next: Work[] = [];
    const sideA: number[] = [], sideB: number[] = [];
    for (const [side, sgn] of [[above, -1], [below, 1]] as const)
      for (const piece of side.decompose()) {
        if (piece.volume() < 1) { warnings.push('Dropped a sub-1 mm³ fragment produced by a cut.'); continue; }
        const node = ++nodeSeq;
        (sgn < 0 ? sideA : sideB).push(node);
        next.push({ m: piece, faces: [...it.faces, { normal: n.map((x) => x * sgn), offset: offsetWorld * sgn }], cutIds: [...it.cutIds, cut.id], node });
      }
    children.set(it.node, [...sideA, ...sideB]);
    tree.push({ cut: cut.id, n, above: sideA, below: sideB });
    work.splice(idx, 1, ...next);
  }
  if (!decision) decision = `Model exceeds ${USABLE} mm usable volume: ${cuts.length} cut(s) → ${work.length} printed body parts + ${pinParts.length} dowel pins.`;

  // Keep only cut faces that actually lie on this part's boundary.
  const parts: PartOut[] = work.map((x, i) => ({
    id: i + 1, name: `part_${i + 1}`, role: 'body' as const, solid: x.m,
    cutFaces: x.faces.filter((f) => { return !x.m.trimByPlane(f.normal as [number, number, number], f.offset - 0.05).isEmpty(); }),
    plate: 0, orient: new Matrix4(), place: new Matrix4(), supportArea: 0, bedContact: 0, height: 0, volume: x.m.volume(),
  }));
  pinParts.forEach((p, i) => parts.push({ id: parts.length + 1, name: `pin_${i + 1}_cut${p.cut}`, role: 'pin', solid: p.m, cutFaces: [], plate: 0, orient: new Matrix4(), place: new Matrix4(), supportArea: 0, bedContact: 0, height: 0, volume: p.m.volume() }));

  // ---- verification ----
  progress('Verifying geometry', 0.65);
  const bodies = parts.filter((p) => p.role === 'body');
  const sumV = bodies.reduce((s, p) => s + p.volume, 0);
  const volErr = Math.abs(sumV + removedHoleVol - vol0) / vol0;
  checks['Volume preserved (parts + pin holes vs original)'] = `${volErr < 1e-3 ? 'PASS' : 'FAIL'} (Δ ${(volErr * 100).toFixed(4)}%)`;
  let maxOverlap = 0;
  for (let i = 0; i < bodies.length; i++) for (let j = i + 1; j < bodies.length; j++) maxOverlap = Math.max(maxOverlap, bodies[i].solid.intersect(bodies[j].solid).volume());
  checks['Parts mutually non-intersecting'] = `${maxOverlap < 1e-3 ? 'PASS' : 'FAIL'} (max overlap ${maxOverlap.toFixed(4)} mm³)`;
  checks['All parts watertight (manifold)'] = parts.every((p) => p.solid.status() === 'NoError' && p.solid.genus() >= -100) ? 'PASS' : 'FAIL';
  const allPins = cuts.flatMap((c) => c.pins);
  checks['Pin holes fully inside material'] = allPins.length ? `${allPins.filter((p) => p.verified).length}/${allPins.length} verified` : 'n/a (no pins)';

  // ---- assembly order: reverse the cut tree. Each step joins two rigid sub-assemblies separated by one plane,
  // moving one along that plane's normal; dowel axes are parallel to that move. Verified with a sampled sweep anyway. ----
  progress('Checking assembly sequence', 0.72);
  const assemblyOrder: PrepareResult['assemblyOrder'] = [];
  const partOfNode = new Map(work.map((x, i) => [x.node, i + 1]));
  const leaves = (node: number): number[] => (partOfNode.has(node) ? [partOfNode.get(node)!] : (children.get(node) ?? []).flatMap(leaves));
  for (const t of [...tree].reverse()) {
    const a = t.above.flatMap(leaves), b = t.below.flatMap(leaves);
    const solidOf = (ids: number[]) => w.Manifold.union(ids.map((id) => parts[id - 1].solid));
    const A = solidOf(a), B = solidOf(b);
    const travel = JOINT.maxDepth + 1;
    let ok = true;
    for (let k = 8; k >= 1 && ok; k--) {
      const moved = A.translate(t.n.map((v) => (v * travel * k) / 8) as [number, number, number]);
      if (moved.intersect(B).volume() > 1e-3) ok = false;
      moved.delete();
    }
    A.delete(); B.delete();
    const pins = parts.filter((p) => p.role === 'pin' && p.name.endsWith(`_cut${t.cut}`)).map((p) => p.id);
    assemblyOrder.push({ cut: t.cut, dir: t.n.map((v) => -v), a, b, pins, ok });
    if (!ok) warnings.push(`Cut ${t.cut}: joining its two sides along the cut normal collides (should not happen for planar cuts; check the model).`);
  }
  if (assemblyOrder.length) checks['Assembly sequence (hierarchical joins along cut normals, sampled sweep)'] = assemblyOrder.every((x) => x.ok) ? 'PASS' : 'FAIL';

  // ---- orientation ----
  parts.forEach((p, i) => {
    progress(`Orienting ${p.name}`, 0.75 + 0.15 * (i / parts.length));
    if (p.role === 'pin') { // dowels print lying on their flat: axis along layers, so they do not snap at the seam
      const pp = pinParts[+/^pin_(\d+)/.exec(p.name)![1] - 1];
      p.orient = (pp.shape === 'round' ? new Matrix4().makeRotationX(Math.PI / 2) : new Matrix4()).multiply(pp.toWorld.clone().invert());
    } else {
      const o = bestOrientation(p.solid, p.cutFaces);
      p.orient = o.rot;
      if (!o.fits) warnings.push(`${p.name} does not fit ${USABLE} mm in its best orientation.`);
    }
    const o = overhang(p.solid.transform(mat(p.orient)));
    p.supportArea = o.support; p.bedContact = o.contact; p.height = o.height;
  });

  // ---- plate packing (shelf packer, with 90° try) ----
  progress('Packing plates', 0.92);
  const gap = 4;
  const items = parts.map((p) => { const m = p.solid.transform(mat(p.orient)); const b = m.boundingBox(); return { p, b, w: b.max[0] - b.min[0] + gap, h: b.max[1] - b.min[1] + gap }; })
    .sort((a, b) => b.h - a.h);
  let plate = 0, x = 0, y = 0, rowH = 0;
  for (const it of items) {
    let rot = false;
    if (it.w > USABLE + gap && it.h <= USABLE + gap) rot = true;
    const W = rot ? it.h : it.w, H = rot ? it.w : it.h;
    if (x + W > USABLE + gap) { x = 0; y += rowH; rowH = 0; }
    if (y + H > USABLE + gap && y > 0) { plate++; x = 0; y = 0; rowH = 0; } // never leave a plate empty
    const off = (A1_MINI.x - USABLE) / 2;
    if (rot) {
      it.p.orient = new Matrix4().makeRotationZ(Math.PI / 2).multiply(it.p.orient);
    }
    const bb = it.p.solid.transform(mat(it.p.orient)).boundingBox();
    it.p.place = new Matrix4().makeTranslation(off + x - bb.min[0], off + y - bb.min[1], -bb.min[2]);
    it.p.plate = plate;
    it.p.placed = it.p.solid.transform(mat(it.p.place.clone().multiply(it.p.orient)));
    x += W; rowH = Math.max(rowH, H);
  }
  const outside = parts.filter((p) => { const b = p.placed!.boundingBox(); return b.min[0] < -1e-6 || b.min[1] < -1e-6 || b.max[0] > A1_MINI.x || b.max[1] > A1_MINI.y || b.max[2] > A1_MINI.z; });
  checks['Every part inside 180×180×180 after orientation'] = outside.length ? `FAIL (${outside.map((p) => p.name).join(', ')})` : 'PASS';
  if (cuts.length) warnings.push('Joint clearances are generic defaults (0.2 mm radial, 0.5 mm mouth chamfer). Print one test joint before the full job.');
  warnings.push('Cut placement uses geometric cues (narrow sections, low support). It has no semantic knowledge of faces, clothing or hair: review seams in Exploded view.');
  progress('Done', 1);
  return { scale, parts, cuts, plates: plate + 1, decision, warnings, checks, assemblyOrder };
}

