// Auto Prepare pipeline: decide cuts, cut, add pin joints, verify assembly, orient, pack onto A1 Mini plates.
// Geometry ops are delegated to manifold-3d (booleans, plane split, slicing); this file only decides *where*.
// shortcut: wasm objects are not .delete()'d; the worker is terminated after every run, which frees the heap.
import { Matrix4, Quaternion, Vector3 } from 'three';
import type { Manifold, CrossSection, Vec2 } from 'manifold-3d';
import type { Wasm } from './geom';

export const A1_MINI = { x: 180, y: 180, z: 180 };
const USABLE = 176; // 2 mm safety margin per side
// Internal defaults for 0.4 mm nozzle PLA-class material. Test-print a joint first: printers differ.
export const JOINT = { pinR: 2.5, pinRSmall: 1.5, clearance: 0.15, depth: 6, depthSmall: 4, wall: 1.6, endGap: 0.4 };

export interface Cut { id: number; normal: number[]; offset: number; pins: PinInfo[]; area: number; islands: number; glueOnlyIslands: number }
export interface PinInfo { center: number[]; axis: number[]; r: number; depth: number; shape: 'round' | 'square'; verified: boolean }
export interface PartOut {
  id: number; name: string; role: 'body' | 'pin';
  solid: Manifold;            // in model (assembled) frame
  placed?: Manifold;          // oriented + placed on its plate
  plate: number; orient: Matrix4; place: Matrix4; // assembled -> plate frame = place * orient
  cutFaces: { normal: number[]; offset: number }[]; // planes on this part's boundary (seams), outward normals
  supportArea: number; bedContact: number; height: number; volume: number; insertDir?: number[]; parent?: number; blocked?: boolean;
}
export interface PrepareResult {
  scale: number; parts: PartOut[]; cuts: Cut[]; plates: number; decision: string; warnings: string[]; checks: Record<string, string>;
  assemblyOrder: { part: number; onto: number | null; dir: number[] | null; ok: boolean | null }[];
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
  return [...cutFaces.map((c) => c.normal), ...axes];
}

/** Try orientations putting each candidate direction downward, plus yaw 0/45° for bed fit. Cut faces down are preferred: flat, hidden, support-free. */
function bestOrientation(m: Manifold, cutFaces: { normal: number[] }[]): Orient {
  let best: Orient | null = null;
  const cuts = new Set(cutFaces.map((c) => c.normal.join()));
  for (const d of candidateDirs(cutFaces)) {
    for (const yaw of [0, 45]) {
      const rot = new Matrix4().makeRotationZ((yaw * Math.PI) / 180).multiply(rotTo(d, [0, 0, -1]));
      const tm = m.transform(mat(rot));
      const o = overhang(tm);
      tm.delete();
      const fits = o.d[0] <= USABLE && o.d[1] <= USABLE && o.d[2] <= USABLE;
      // Support touching visible surfaces is the main quality cost; low contact on tall parts risks tipping.
      const tip = o.contact < 1e-6 ? 50 : Math.max(0, o.height / Math.sqrt(o.contact) - 8) * 2;
      const score = (fits ? 0 : 1e9) + o.support + tip * 10 + o.height * 0.5 - (cuts.has(d.join()) ? 30 : 0);
      if (!best || score < best.score) best = { rot, support: o.support, contact: o.contact, height: o.height, fits, score };
    }
  }
  return best!;
}

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
interface Candidate { normal: number[]; offset: number; cost: number; area: number; islands: CrossSection[]; frame: Matrix4 }

const CUT_NORMALS = [[0, 0, 1], [1, 0, 0], [0, 1, 0], [0.5, 0, 0.866], [-0.5, 0, 0.866], [0, 0.5, 0.866], [0, -0.5, 0.866]];

function sections(m: Manifold, n: number[], samples: number) {
  const frame = rotTo(n, [0, 0, 1]);
  const r = m.transform(mat(frame));
  const b = r.boundingBox();
  const out: { h: number; cs: CrossSection; area: number }[] = [];
  for (let i = 1; i < samples; i++) {
    const h = b.min[2] + ((b.max[2] - b.min[2]) * i) / samples;
    const cs = r.slice(h);
    out.push({ h, cs, area: cs.area() });
  }
  return { frame, r, out, len: b.max[2] - b.min[2] };
}

function pinsFit(islands: CrossSection[]): number {
  let glue = 0;
  for (const isl of islands) if (isl.offset(-(JOINT.pinRSmall + JOINT.clearance + JOINT.wall), 'Round').isEmpty()) glue++;
  return glue;
}

function findCut(m: Manifold, onProgress: (f: number) => void): Candidate | null {
  const total = m.volume();
  let best: Candidate | null = null;
  CUT_NORMALS.forEach((n, ni) => {
    onProgress(ni / CUT_NORMALS.length);
    const { frame, r, out, len } = sections(m, n, 24);
    if (len <= 1) return;
    const maxA = Math.max(...out.map((s) => s.area), 1e-9);
    const whole = Math.max(...dims(m));
    out.forEach((s, i) => {
      if (s.area <= 0) return;
      // Seam visibility proxy: relative cross-section (necks, waists, joints are local minima).
      const rel = s.area / maxA;
      const localMin = (out[i - 1]?.area ?? Infinity) >= s.area && (out[i + 1]?.area ?? Infinity) >= s.area;
      const [above, below] = r.splitByPlane([0, 0, 1], s.h);
      const va = above.volume(), vb = below.volume();
      const unfit = (fitsSomehow(above) ? 0 : 1) + (fitsSomehow(below) ? 0 : 1);
      const shrink = Math.max(...dims(above), ...dims(below)) / whole; // progress on the oversize problem
      above.delete(); below.delete();
      if (Math.min(va, vb) < total * 0.03) return; // no slivers
      const islands = s.cs.decompose();
      const glue = pinsFit(islands);
      // Balanced pieces need fewer further cuts; tilted planes cost a little (harder to align visually).
      const cost = rel * 100 + (localMin ? -15 : 0) + unfit * 150 + shrink * 120 + glue * 40 + islands.length * 5 + Math.abs(va - vb) / total * 20 + (n[0] && n[2] ? 8 : 0) + (n[2] === 1 ? 0 : 4);
      if (!best || cost < best.cost) best = { normal: n, offset: s.h, cost, area: s.area, islands, frame };
    });
    r.delete();
  });
  return best;
}

// ---------- pins ----------
function choosePins(islands: CrossSection[]): { p: Vec2; r: number; depth: number; shape: 'round' | 'square' }[] {
  const pins: { p: Vec2; r: number; depth: number; shape: 'round' | 'square' }[] = [];
  for (const isl of islands) {
    for (const [r, depth] of [[JOINT.pinR, JOINT.depth], [JOINT.pinRSmall, JOINT.depthSmall]]) {
      const inset = isl.offset(-(r + JOINT.clearance + JOINT.wall), 'Round');
      if (inset.isEmpty()) continue;
      const pts = inset.toPolygons().flat();
      // Two pins as far apart as possible lock rotation; otherwise one square key.
      let a = pts[0], b = pts[0], dmax = 0;
      for (let i = 0; i < pts.length; i += Math.max(1, Math.floor(pts.length / 200)))
        for (let j = i + 1; j < pts.length; j += Math.max(1, Math.floor(pts.length / 200))) {
          const d = Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]);
          if (d > dmax) { dmax = d; a = pts[i]; b = pts[j]; }
        }
      if (dmax > 2 * r + 4) {
        // pull 25% toward each other to stay away from thin tips of the inset region
        const lerp = (p: Vec2, q: Vec2, t: number): Vec2 => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
        pins.push({ p: lerp(a, b, 0.2), r, depth, shape: 'round' }, { p: lerp(b, a, 0.2), r, depth, shape: 'round' });
      } else {
        const bb = inset.bounds();
        pins.push({ p: [(bb.min[0] + bb.max[0]) / 2, (bb.min[1] + bb.max[1]) / 2], r, depth, shape: 'square' });
      }
      break;
    }
  }
  return pins;
}

function pinSolid(w: Wasm, shape: 'round' | 'square', r: number, len: number): Manifold {
  return shape === 'round' ? w.Manifold.cylinder(len, r, r, 32, true) : w.Manifold.cube([r * 1.6, r * 1.6, len], true);
}

// ---------- main ----------
export function prepare(w: Wasm, input: Manifold, scale: number, maxParts: number, progress: Progress): PrepareResult {
  const warnings: string[] = [];
  const checks: Record<string, string> = {};
  let solid = input.scale(scale);
  const b0 = solid.boundingBox();
  solid = solid.translate([-(b0.min[0] + b0.max[0]) / 2, -(b0.min[1] + b0.max[1]) / 2, -b0.min[2]]);
  const vol0 = solid.volume();

  interface Work { m: Manifold; faces: { normal: number[]; offset: number }[]; cutIds: number[] }
  let work: Work[] = [{ m: solid, faces: [], cutIds: [] }];
  const cuts: Cut[] = [];
  const pinParts: { m: Manifold; cut: number }[] = [];
  let removedHoleVol = 0;
  let decision = fitsSomehow(solid) ? 'Model fits the A1 Mini build volume in one piece: printed whole (no seams).' : '';

  let guard = 0;
  while (!decision && guard++ < maxParts) {
    const idx = work.findIndex((x) => !fitsSomehow(x.m));
    if (idx < 0) break;
    if (work.length >= maxParts) { warnings.push(`Part limit (${maxParts}) reached; some parts may not fit.`); break; }
    const it = work[idx];
    progress(`Searching cut ${cuts.length + 1}`, 0.1 + 0.5 * (cuts.length / maxParts));
    const c = findCut(it.m, () => {});
    if (!c) { warnings.push('No valid cut found for an oversized part.'); break; }
    const inv = c.frame.clone().invert();
    const n = new Vector3(...c.normal).normalize().toArray();
    // Pins: blind holes on both sides of the plane, separate dowel parts. Every hole is verified to stay inside material.
    const pins = choosePins(c.islands);
    const infos: PinInfo[] = [];
    let holes: Manifold | null = null;
    for (const p of pins) {
      const holeLen = 2 * (p.depth + JOINT.endGap / 2);
      const hole = pinSolid(w, p.shape, p.r + JOINT.clearance, holeLen).translate([p.p[0], p.p[1], c.offset]).transform(mat(inv));
      const inside = hole.intersect(it.m).volume() / hole.volume();
      const verified = inside > 0.995;
      const center = new Vector3(p.p[0], p.p[1], c.offset).applyMatrix4(inv).toArray();
      infos.push({ center, axis: n, r: p.r, depth: p.depth, shape: p.shape, verified });
      if (!verified) { warnings.push(`Cut ${cuts.length + 1}: a pin hole would break through the surface (${(inside * 100).toFixed(1)}% inside); pin dropped.`); continue; }
      holes = holes ? holes.add(hole) : hole;
      pinParts.push({ m: pinSolid(w, p.shape, p.r, 2 * p.depth - JOINT.endGap).translate([p.p[0], p.p[1], c.offset]).transform(mat(inv)), cut: cuts.length + 1 });
    }
    const glue = pinsFit(c.islands);
    if (glue) warnings.push(`Cut ${cuts.length + 1}: ${glue} section island(s) too thin for a pin — glue-only, alignment not keyed.`);
    const offsetWorld = c.offset; // frame maps n -> z, so plane offset along n is unchanged
    let body = it.m;
    if (holes) { removedHoleVol += holes.intersect(body).volume(); body = body.subtract(holes); }
    const [above, below] = body.splitByPlane(n, offsetWorld);
    const cut: Cut = { id: cuts.length + 1, normal: n, offset: offsetWorld, pins: infos, area: c.area, islands: c.islands.length, glueOnlyIslands: glue };
    cuts.push(cut);
    const next: Work[] = [];
    for (const [side, sgn] of [[above, -1], [below, 1]] as const)
      for (const piece of side.decompose()) {
        if (piece.volume() < 1) { warnings.push('Dropped a sub-1 mm³ fragment produced by a cut.'); continue; }
        next.push({ m: piece, faces: [...it.faces, { normal: n.map((x) => x * sgn), offset: offsetWorld * sgn }], cutIds: [...it.cutIds, cut.id] });
      }
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

  // ---- assembly order: BFS over shared cut faces from the largest part; each insertion is a straight move along the cut normal. ----
  progress('Checking assembly sequence', 0.72);
  const assemblyOrder: PrepareResult['assemblyOrder'] = [];
  if (bodies.length > 1) {
    const done = new Set<number>();
    const start = bodies.reduce((a, b) => (a.volume > b.volume ? a : b));
    done.add(start.id);
    assemblyOrder.push({ part: start.id, onto: null, dir: null, ok: null });
    let assembled = start.solid;
    let progressMade = true;
    while (done.size < bodies.length && progressMade) {
      progressMade = false;
      for (const p of bodies) {
        if (done.has(p.id)) continue;
        // a face of p whose opposite plane belongs to an assembled part = neighbor along that cut
        const f = p.cutFaces.find((f) => bodies.some((q) => done.has(q.id) && q.cutFaces.some((g) => Math.abs(g.offset + f.offset) < 1e-6 && g.normal.every((v, k) => Math.abs(v + f.normal[k]) < 1e-9)) && p.solid.minGap(q.solid, 0.5) < 0.5));
        if (!f) continue;
        const onto = bodies.find((q) => done.has(q.id) && p.solid.minGap(q.solid, 0.5) < 0.5)!;
        // Insert along the face normal (toward the neighbour): start displaced back by pin depth + 1 mm and sweep in; any collision with assembled parts = blocked.
        const travel = JOINT.depth + 1;
        let ok = true;
        for (const t of [travel, travel * 0.66, travel * 0.33, 0.05]) {
          const moved = p.solid.translate(f.normal.map((v) => -v * t) as [number, number, number]);
          if (moved.intersect(assembled).volume() > 1e-3) { ok = false; break; }
        }
        p.insertDir = f.normal; p.parent = onto.id; p.blocked = !ok;
        assemblyOrder.push({ part: p.id, onto: onto.id, dir: p.insertDir, ok });
        if (!ok) warnings.push(`${p.name}: straight insertion along its cut normal collides with already assembled parts.`);
        done.add(p.id);
        assembled = assembled.add(p.solid);
        progressMade = true;
      }
    }
    checks['Assembly sequence (straight-line insertion, sampled sweep)'] = assemblyOrder.every((a) => a.ok !== false) && done.size === bodies.length ? 'PASS' : 'FAIL';
  }

  // ---- orientation ----
  parts.forEach((p, i) => {
    progress(`Orienting ${p.name}`, 0.75 + 0.15 * (i / parts.length));
    if (p.role === 'pin') { // dowels print standing: round holes stay round, no supports
      p.orient = rotTo(allPinsAxis(cuts, p), [0, 0, 1]);
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
    if (y + H > USABLE + gap) { plate++; x = 0; y = 0; rowH = 0; }
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
  if (cuts.length) warnings.push('Joint clearances are generic defaults (0.15 mm radial). Print one test joint before the full job.');
  warnings.push('Cut placement uses geometric cues (narrow sections, low support). It has no semantic knowledge of faces, clothing or hair: review seams in Exploded view.');
  progress('Done', 1);
  return { scale, parts, cuts, plates: plate + 1, decision, warnings, checks, assemblyOrder };
}

function allPinsAxis(cuts: Cut[], p: PartOut): number[] {
  const m = /cut(\d+)/.exec(p.name);
  return cuts.find((c) => c.id === +(m?.[1] ?? 0))?.normal ?? [0, 0, 1];
}
