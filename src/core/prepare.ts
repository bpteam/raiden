// Auto Prepare: analyse the surface, search decompositions jointly with their print orientations, replay the chosen cuts on
// the full mesh with verified dowel joints, pack every part onto A1 Mini plates, then validate the whole result.
// Geometry ops are manifold-3d (booleans, plane split, slicing); this file decides what to do and checks it.
// shortcut: wasm objects are not .delete()'d; the worker is terminated after every run, which frees the heap.
import { Matrix4, Vector3 } from 'three';
import type { Manifold } from 'manifold-3d';
import type { Wasm } from './geom';
import { analyzeSurface, partMesh, evenOut } from './analysis';
import { evalDown, bestOrient, perp, fitYaw, USABLE, type OrientEval } from './orient';
import { curveSeam } from './seam';
import { seamFromCaps } from './cuts';
import { search, makePart, registry, type SState } from './search';
import { JOINT, rotTo, mat, planJoints, holeSolid, dowelSolid } from './joints';
import { pack, BED } from './pack';

export { JOINT };
export const A1_MINI = { x: 180, y: 180, z: 180 };

export interface PinInfo { center: number[]; axis: number[]; r: number; depth: number; shape: 'round' | 'square'; verified: boolean }
export interface Cut { id: number; normal: number[]; offset: number; pins: PinInfo[]; area: number; islands: number; glueOnlyIslands: number; seamLength: number; visibleSeam: number; neck: number; curved?: { gain: number; maxDz: number } }
export interface PartOut {
  id: number; name: string; role: 'body' | 'pin';
  solid: Manifold;            // in model (assembled) frame
  placed?: Manifold;          // oriented + placed on its plate
  plate: number; orient: Matrix4; place: Matrix4; // assembled -> plate frame = place * orient
  cutFaces: { normal: number[]; offset: number }[]; // planes on this part's boundary (seams), outward normals
  supportArea: number; bedContact: number; height: number; volume: number;
  metrics?: OrientEval;       // geometric print-quality estimates in the chosen orientation
  brim?: boolean;             // exported with a 5 mm brim (no room on the bed → none, warned)
  supportTris?: Uint8Array;   // per triangle of `placed`: 1 = needs support and lies on a visible surface, 2 = needs support, hidden surface
}
export interface Alternative { parts: number; cuts: number; cost: number; feasible: boolean; terms: Record<string, number> }
export interface PrepareResult {
  scale: number; parts: PartOut[]; cuts: Cut[]; plates: number; decision: string; warnings: string[]; checks: Record<string, string>;
  /** Reverse cut order: join sub-assembly `a` (side the normal points to) onto `b` by moving it along -dir. Pins of that cut go into `b` first. */
  assemblyOrder: { cut: number; dir: number[]; a: number[]; b: number[]; pins: number[]; ok: boolean }[];
  summary: Record<string, number | string>;
  alternatives: Alternative[]; // unsplit model + Pareto-optimal candidates the search found (for reports)
}
type Progress = (stage: string, frac: number) => void;

/** Rotation taking `down` to -Z (then optional yaw). Rows = (u, v, -down). */
function orientMatrix(down: number[]): Matrix4 {
  const [u, v] = perp(down);
  return new Matrix4().set(u[0], u[1], u[2], 0, v[0], v[1], v[2], 0, -down[0], -down[1], -down[2], 0, 0, 0, 0, 1);
}

/**
 * Split by a curved cutter. Where the bent surface grazes the skin it can shave off crumbs (a few mm³); each crumb joins
 * the touching piece on the other side instead (no geometry is lost; the assembly sweep re-checks the result).
 */
function curvedSplit(w: Wasm, l: Manifold, cutter: Manifold): { above: Manifold; below: Manifold } {
  const up = l.subtract(cutter).decompose(), dn = l.intersect(cutter).decompose();
  const total = l.volume(), crumb = (q: Manifold) => q.volume() < Math.max(30, total * 5e-4);
  const big = (xs: Manifold[]) => xs.filter((q) => !crumb(q));
  const UP = big(up), DN = big(dn);
  const touch = (a: Manifold, xs: Manifold[]) => xs.reduce((best, x) => { const d = a.minGap(x, 0.5); return d < best[0] ? [d, x] as [number, Manifold] : best; }, [Infinity, xs[0]] as [number, Manifold])[1];
  for (const q of up.filter(crumb)) if (DN.length) { const t = touch(q, DN); DN[DN.indexOf(t)] = w.Manifold.union(t, q); } else UP.push(q);
  for (const q of dn.filter(crumb)) if (UP.length) { const t = touch(q, UP); UP[UP.indexOf(t)] = w.Manifold.union(t, q); } else DN.push(q);
  return { above: w.Manifold.union(UP), below: w.Manifold.union(DN) };
}

/** Shadow outline without its holes: nothing may be placed inside a part's loop (arms, legs) — its supports grow there. */
function outerRings(polys: number[][][]): number[][][] {
  const area = (r: number[][]) => r.reduce((s, p, i) => { const q = r[(i + 1) % r.length]; return s + p[0] * q[1] - q[0] * p[1]; }, 0);
  return polys.filter((r) => area(r) > 0); // manifold CrossSection: outer rings CCW, holes CW
}

function simplifyTo(m: Manifold, maxTri: number): Manifold {
  if (m.numTri() <= maxTri) return m;
  const b = m.boundingBox();
  let tol = Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) * 0.0008;
  let s = m.simplify(tol);
  while (s.numTri() > maxTri && tol < 5) { tol *= 1.6; s = m.simplify(tol); }
  return s;
}


export function prepare(w: Wasm, input: Manifold, scale: number, maxParts: number, progress: Progress): PrepareResult {
  const warnings: string[] = [];
  const checks: Record<string, string> = {};
  let solid = input.scale(scale);
  const b0 = solid.boundingBox();
  solid = solid.translate([-(b0.min[0] + b0.max[0]) / 2, -(b0.min[1] + b0.max[1]) / 2, -b0.min[2]]);
  const vol0 = solid.volume();

  // ---- 1. surface analysis (visibility / detail / concavity), once for the assembled model ----
  progress('Analysing surface visibility and detail', 0.02);
  const field = analyzeSurface(solid);

  // ---- 2. joint search over decompositions + orientations on a proxy mesh ----
  progress('Exploring splitting strategies', 0.08);
  // Disconnected shells of the input never touch: they are separate parts from the start (no seam, no joint).
  const shells = solid.decompose().filter((m) => m.volume() >= 1);
  if (shells.length > 1) warnings.push(`Input has ${shells.length} separate closed shells that do not touch each other; each is printed as its own part (position/glue by hand — they float in the original model).`);
  registry.clear();
  const total = shells.reduce((a, m) => a + m.numTri(), 0);
  const roots = shells.map((m) => {
    let proxy = simplifyTo(m, Math.max(1500, Math.round(9000 * m.numTri() / total)));
    if (proxy === m) proxy = m.translate([0, 0, 0]); // the search frees its proxies; never hand it the real solid
    return makePart(proxy, field, []);
  });
  const sr = search(roots, field, { beam: 4, perPart: 6, maxParts, qualityCuts: 2, onProgress: (f) => progress('Exploring splitting strategies', 0.08 + 0.45 * f) });
  const plan: SState = sr.best;
  if (!plan.feasible) warnings.push(`No decomposition within the part limit makes every part fit the ${USABLE} mm usable volume. Result is the best found; oversize parts are flagged.`);

  // ---- 3. replay the plan on the full-resolution mesh, cutting verified dowel holes at every seam ----
  type Work = { m: Manifold; faces: { normal: number[]; offset: number }[]; proxy: number };
  let work: Work[] = shells.map((m, i) => ({ m, faces: [], proxy: roots[i].id }));
  const proxyById = new Map(plan.parts.map((p) => [p.id, p]));
  const cuts: Cut[] = [];
  const pinParts: { m: Manifold; cut: number; toWorld: Matrix4; shape: 'round' | 'square' }[] = [];
  let removedHoleVol = 0, droppedVol = 0;
  for (const c of plan.cuts) {
    progress(`Cutting seam ${c.id} and fitting connectors`, 0.55 + 0.1 * (c.id / Math.max(1, plan.cuts.length)));
    const mine = work.filter((x) => x.proxy === c.parent);
    if (!mine.length) { warnings.push(`Cut ${c.id}: its part vanished on the full mesh; skipped.`); continue; }
    const body = mine.length === 1 ? mine[0].m : w.Manifold.union(mine.map((x) => x.m));
    const faces = mine[0].faces;
    const n = new Vector3(...c.n).normalize().toArray();
    const frame = rotTo(n, [0, 0, 1]);
    const inv = frame.clone().invert();
    const local = body.transform(mat(frame));
    const cs = local.slice(c.h);
    const islands = cs.decompose();
    // Try bending the seam into a nearby fold/hem (height-field cut, still assembled by a straight move along n).
    const rot = new Matrix4().extractRotation(inv);
    let curved = curveSeam(w, local, c.h, field, (p) => new Vector3(...p).applyMatrix4(inv).toArray(), (v) => new Vector3(...v).applyMatrix4(rot).toArray());
    if (curved) {
      // keep it only if it yields the same pieces as the planar cut and every piece still fits the printer
      const count = (m: Manifold) => m.decompose().filter((q) => q.volume() >= 1);
      const [pa, pb] = local.splitByPlane([0, 0, 1], c.h);
      const sp = curvedSplit(w, local, curved.cutter);
      const ca = count(sp.above), cb = count(sp.below);
      const fitsAny = (q: Manifold) => { const g = q.transform(mat(inv)).hull().getMesh(); const hp = Float32Array.from({ length: g.numVert * 3 }, (_, i) => g.vertProperties[Math.floor(i / 3) * g.numProp + (i % 3)]);
        return [...c.above, ...c.below].some((id) => { const k = registry.get(id); if (!k) return false; let lo = Infinity, hi = -Infinity; for (let i = 0; i < hp.length; i += 3) { const z = -(hp[i] * k.o.down[0] + hp[i + 1] * k.o.down[1] + hp[i + 2] * k.o.down[2]); lo = Math.min(lo, z); hi = Math.max(hi, z); } return fitYaw(hp, k.o.down, hi - lo).fits; }); };
      const why = ca.length !== count(pa).length || cb.length !== count(pb).length ? `pieces ${ca.length}/${cb.length} vs planar ${count(pa).length}/${count(pb).length}` : ![...ca, ...cb].every(fitsAny) ? 'a piece no longer fits' : '';
      if (why) curved = null;
    }
    const hAt = curved ? curved.heightAt : () => c.h;
    const infos: PinInfo[] = [];
    const holeList: Manifold[] = [];
    let glue = 0;
    for (const isl of islands) {
      // a hole that pokes (even slightly) through an earlier seam into a neighbouring part would jam its dowel there
      const others = work.filter((x) => x.proxy !== c.parent).map((x) => x.m);
      const plans = planJoints(w, isl, body, inv, c.h, hAt).filter((p) => {
        const hole = holeSolid(w, p.shape, p.r, p.depth).translate([p.p[0], p.p[1], hAt(p.p[0], p.p[1])]).transform(mat(inv));
        return others.every((o) => hole.intersect(o).volume() < 1e-4);
      });
      if (!plans.length) glue++;
      if (plans.length === 1 && plans[0].shape === 'round') warnings.push(`Cut ${c.id}: one island holds a single round dowel (no room for a key); it can rotate — align by eye.`);
      for (const p of plans) {
        const toWorld = inv.clone().multiply(new Matrix4().makeTranslation(p.p[0], p.p[1], hAt(p.p[0], p.p[1])));
        holeList.push(holeSolid(w, p.shape, p.r, p.depth).transform(mat(toWorld)));
        infos.push({ center: new Vector3().applyMatrix4(toWorld).toArray(), axis: n, r: p.r, depth: p.depth, shape: p.shape, verified: true });
        pinParts.push({ m: dowelSolid(w, p.shape, p.r, p.depth).transform(mat(toWorld)), cut: c.id, toWorld, shape: p.shape });
      }
    }
    if (glue) warnings.push(`Cut ${c.id}: ${glue} section island(s) too thin for any dowel — glue-only, alignment not keyed.`);
    let cutBody = body;
    if (holeList.length) { const holes = w.Manifold.union(holeList); removedHoleVol += holes.intersect(body).volume(); cutBody = body.subtract(holes); }
    let above: Manifold, below: Manifold;
    if (curved) { const sp = curvedSplit(w, cutBody.transform(mat(frame)), curved.cutter); above = sp.above.transform(mat(inv)); below = sp.below.transform(mat(inv)); }
    else [above, below] = cutBody.splitByPlane(n as [number, number, number], c.h);

    const next: Work[] = [];
    for (const [side, sgn] of [[above, 1], [below, -1]] as const) for (const piece of side.decompose()) {
      const v = piece.volume();
      if (v < 1) { droppedVol += v; warnings.push(`Cut ${c.id}: dropped a ${v.toFixed(2)} mm³ fragment.`); continue; }
      // map the real piece to its proxy child: same side of the plane, nearest box centre, similar volume
      // (pieces on one side are disjoint; proxy and real mesh differ only by the simplification tolerance)
      const ids = sgn > 0 ? c.above : c.below;
      const pb = piece.boundingBox(), pc = [0, 1, 2].map((k) => (pb.min[k] + pb.max[k]) / 2);
      let bestId = ids[0], bestD = Infinity;
      for (const id of ids) {
        const k = registry.get(id); if (!k) continue;
        const d = Math.hypot(...[0, 1, 2].map((q) => (k.bb[q] + k.bb[q + 3]) / 2 - pc[q])) + Math.abs(k.vol - v) / Math.max(k.vol, v) * 50;
        if (d < bestD) { bestD = d; bestId = id; }
      }
      next.push({ m: piece, faces: [...faces, { normal: n.map((x) => -x * sgn), offset: -c.h * sgn }], proxy: bestId });
    }
    work = [...work.filter((x) => x.proxy !== c.parent), ...next];
    cuts.push({ id: c.id, normal: n, offset: c.h, pins: infos, area: cs.area(), islands: islands.length, glueOnlyIslands: glue, seamLength: 0, visibleSeam: c.seam, neck: c.neck, curved: curved ? { gain: curved.gain, maxDz: curved.maxDz } : undefined });
  }
  // raw seam length on the real mesh, for reporting next to the visibility-weighted one
  for (const c of cuts) { const pr = plan.cuts.find((q) => q.id === c.id)!; c.seamLength = rawSeamLength(solid, pr.n, pr.h); }

  const parts: PartOut[] = work.map((x, i) => ({
    id: i + 1, name: `part_${i + 1}`, role: 'body' as const, solid: x.m,
    cutFaces: x.faces.filter((f) => !x.m.trimByPlane(f.normal as [number, number, number], f.offset - 0.05).isEmpty()),
    plate: 0, orient: new Matrix4(), place: new Matrix4(), supportArea: 0, bedContact: 0, height: 0, volume: x.m.volume(),
  }));
  const proxyOfPart = work.map((x) => x.proxy);
  pinParts.forEach((p, i) => parts.push({ id: parts.length + 1, name: `pin_${i + 1}_cut${p.cut}`, role: 'pin', solid: p.m, cutFaces: [], plate: 0, orient: new Matrix4(), place: new Matrix4(), supportArea: 0, bedContact: 0, height: 0, volume: p.m.volume() }));
  const bodies = parts.filter((p) => p.role === 'body');

  // ---- 4. orientation: reuse the search's choice, re-measured on the real part ----
  let seamRaw = 0, seamVis = 0;
  bodies.forEach((p, i) => {
    progress(`Optimising print orientation (${p.name})`, 0.66 + 0.08 * (i / bodies.length));
    const pm = partMesh(evenOut(p.solid), field, p.cutFaces);
    const sm = seamFromCaps(pm, p.cutFaces); seamRaw += sm.raw / 2; seamVis += sm.weighted / 2; // each seam is shared by two parts
    const hull = p.solid.hull().getMesh();
    const hp = new Float32Array(hull.numVert * 3);
    for (let k = 0; k < hull.numVert; k++) for (let j = 0; j < 3; j++) hp[k * 3 + j] = hull.vertProperties[k * hull.numProp + j];
    const sp = proxyById.get(proxyOfPart[i]);
    // the search chose on the proxy; re-score on the full mesh and keep whichever is better there
    const re = sp ? evalDown(pm, sp.o.down, hp) : null;
    const fresh = bestOrient(pm, hp, p.cutFaces.map((f) => f.normal)).best;
    const o = re && re.fits && re.cost <= fresh.cost ? re : fresh;
    if (!o.fits) warnings.push(`${p.name} does not fit ${USABLE} mm in any tested orientation.`);
    p.orient = orientMatrix(o.down);
    p.metrics = o;
    p.supportArea = o.supportArea; p.bedContact = o.contact; p.height = o.height;
  });
  parts.filter((p) => p.role === 'pin').forEach((p) => {
    const pp = pinParts[+/^pin_(\d+)/.exec(p.name)![1] - 1];
    // dowels print lying on their flat: layers along the axis, so they do not snap at the seam
    p.orient = (pp.shape === 'round' ? new Matrix4().makeRotationX(Math.PI / 2) : new Matrix4()).multiply(pp.toWorld.clone().invert());
    const b = p.solid.transform(mat(p.orient)).boundingBox();
    p.height = b.max[2] - b.min[2];
  });

  // ---- 5. plates: shape-aware packing (yaw only) ----
  progress('Arranging parts on A1 Mini plates', 0.76);
  const oriented = parts.map((p) => { const m = p.solid.transform(mat(p.orient)); const b = m.boundingBox(); return m.translate([0, 0, -b.min[2]]); });
  // Dowels go in ONE tight cluster (4 mm apart) that keeps 30 mm from parts: tall parts' tree-support branches drift far
  // (Bambu Studio flagged path conflicts at 20 mm); one cluster keeps that keep-out from multiplying the plate count.
  const bodyIdx = parts.map((p, i) => (p.role === 'body' ? i : -1)).filter((i) => i >= 0);
  const pinIdx = parts.map((p, i) => (p.role === 'pin' ? i : -1)).filter((i) => i >= 0);
  const pinOff = new Map<number, number[]>(); // cluster-local offset of each dowel (oriented frame, min corner at offset)
  const clusterRings: number[][][] = [];
  { let x = 0, y = 0, rowH = 0;
    for (const i of pinIdx) {
      const b = oriented[i].boundingBox(), w0 = b.max[0] - b.min[0], h0 = b.max[1] - b.min[1];
      if (x > 0 && x + w0 > 60) { x = 0; y += rowH + 4; rowH = 0; }
      pinOff.set(i, [x - b.min[0], y - b.min[1]]);
      clusterRings.push([[x, y], [x + w0, y], [x + w0, y + h0], [x, y + h0]]);
      x += w0 + 4; rowH = Math.max(rowH, h0);
    } }
  // footprint = exact shadow outline of the oriented part (manifold project); placed parts are re-checked with booleans
  const CLUSTER = -1;
  const pk = pack([
    ...bodyIdx.map((i) => ({ id: i, polys: outerRings(oriented[i].project().toPolygons() as number[][][]), brim: true })),
    ...(pinIdx.length ? [{ id: CLUSTER, polys: clusterRings, brim: false, room: 30 }] : []),
  ]);
  const placeOne = (i: number, pl: { x: number; y: number; yaw: number; plate: number; brim: boolean }, local = [0, 0]) => {
    const p = parts[i];
    const b = p.solid.transform(mat(p.orient)).boundingBox();
    p.place = new Matrix4().makeTranslation(pl.x, pl.y, 0).multiply(new Matrix4().makeRotationZ(pl.yaw)).multiply(new Matrix4().makeTranslation(local[0], local[1], -b.min[2]));
    p.plate = pl.plate;
    p.brim = pl.brim;
    if (p.role === 'body' && !pl.brim) warnings.push(`${p.name}: too large for a brim on the A1 Mini bed; exported without one.`);
    p.placed = p.solid.transform(mat(p.place.clone().multiply(p.orient)));
  };
  for (const pl of pk.placements) {
    if (pl.id === CLUSTER) for (const i of pinIdx) placeOne(i, pl, pinOff.get(i));
    else placeOne(pl.id, pl);
  }
  pk.unplaced = pk.unplaced.flatMap((id) => (id === CLUSTER ? pinIdx : [id]));
  for (const id of pk.unplaced) { const p = parts[id]; warnings.push(`${p.name} could not be placed on any plate.`); p.plate = -1; p.placed = oriented[id]; }

  // support-risk map on the placed geometry (for the preview): 1 = support on a visible surface, 2 = support on a hidden one
  for (const p of bodies) {
    if (!p.placed) continue;
    const back = p.place.clone().multiply(p.orient).invert();
    const pm = partMesh(p.placed.transform(mat(back)), field, p.cutFaces);
    const g = p.placed.getMesh();
    const flag = new Uint8Array(g.numTri);
    for (let t = 0; t < g.numTri; t++) {
      const z = [0, 1, 2].map((j) => g.vertProperties[g.triVerts[t * 3 + j] * g.numProp + 2]);
      const a = [0, 1, 2].map((j) => [0, 1].map((k) => g.vertProperties[g.triVerts[t * 3 + j] * g.numProp + k]));
      // signed projected area / true area = nz; reuse the assembled-frame normal for the true area
      const proj = ((a[1][0] - a[0][0]) * (a[2][1] - a[0][1]) - (a[2][0] - a[0][0]) * (a[1][1] - a[0][1])) / 2;
      const nz = pm.area[t] > 0 ? proj / pm.area[t] : 0;
      if (nz < -0.7071 && Math.max(...z) > 0.3) flag[t] = pm.iface[t] || pm.V[t] < 0.15 ? 2 : 1;
    }
    p.supportTris = flag;
  }

  // ---- 6. validation ----
  progress('Validating geometry, connectors, assembly and placement', 0.82);
  const sumV = bodies.reduce((s, p) => s + p.volume, 0);
  const volErr = Math.abs(sumV + removedHoleVol + droppedVol - vol0) / vol0;
  checks['Volume preserved (parts + dowel holes vs original)'] = `${volErr < 1e-3 ? 'PASS' : 'FAIL'} (Δ ${(volErr * 100).toFixed(4)}%)`;
  // Reconstruction: the assembled parts, with the dowel holes filled back in, must reproduce the original solid.
  if (cuts.length) {
    const holesAll = cuts.flatMap((c) => c.pins.map((pi) => {
      const pp = pinParts.find((q) => new Vector3().applyMatrix4(q.toWorld).distanceTo(new Vector3(...pi.center)) < 1e-6)!;
      return holeSolid(w, pi.shape, pi.r, pi.depth).transform(mat(pp.toWorld));
    }));
    const rebuilt = w.Manifold.union([...bodies.map((p) => p.solid), ...holesAll]).intersect(solid);
    const missing = solid.subtract(rebuilt).volume(), extra = w.Manifold.union(bodies.map((p) => p.solid)).subtract(solid).volume();
    checks['Reconstruction: assembled parts vs original (outside connector cavities)'] = `${missing < vol0 * 1e-4 + 1 && extra < 1 ? 'PASS' : 'FAIL'} (missing ${missing.toFixed(2)} mm³, extra ${extra.toFixed(2)} mm³)`;
  }
  let maxOverlap = 0;
  for (let i = 0; i < bodies.length; i++) for (let j = i + 1; j < bodies.length; j++) maxOverlap = Math.max(maxOverlap, bodies[i].solid.intersect(bodies[j].solid).volume());
  checks['Parts mutually non-intersecting (assembled)'] = `${maxOverlap < 1e-3 ? 'PASS' : 'FAIL'} (max overlap ${maxOverlap.toFixed(4)} mm³)`;
  checks['All parts watertight manifolds'] = parts.every((p) => p.solid.status() === 'NoError' && !p.solid.isEmpty()) ? 'PASS' : 'FAIL';
  const tinyBodies = bodies.filter((p) => p.volume < 30);
  if (tinyBodies.length) warnings.push(`Very small parts (<30 mm³): ${tinyBodies.map((p) => p.name).join(', ')} — easy to lose, weak.`);
  if (pinParts.length) {
    // Connector check: every dowel sits inside its hole with clearance, touching no body.
    let bad = 0;
    for (const pp of pinParts) for (const b of bodies) if (pp.m.intersect(b.solid).volume() > 1e-3) bad++;
    checks['Dowels clear of all bodies when seated (radial/end clearance)'] = bad ? `FAIL (${bad} contacts)` : `PASS (${pinParts.length} dowels)`;
  } else checks['Dowels clear of all bodies when seated (radial/end clearance)'] = 'n/a (no dowels)';

  // Assembly order: reverse the cut tree. Each step joins two rigid groups separated by ONE plane, moving one along the
  // plane normal. Both groups lie in opposite closed half-spaces, so that straight translation is collision-free by
  // construction (proved, not sampled); dowel axes are parallel to it. A sampled sweep re-checks it on the real meshes.
  progress('Checking assembly sequence', 0.88);
  const assemblyOrder: PrepareResult['assemblyOrder'] = [];
  const cutByParent = new Map(plan.cuts.map((c) => [c.parent, c]));
  const leaves = (proxy: number): number[] => {
    const own = proxyOfPart.map((x, i) => (x === proxy ? i + 1 : 0)).filter(Boolean);
    const c = cutByParent.get(proxy);
    return [...own, ...(c ? [...c.above, ...c.below].flatMap(leaves) : [])];
  };
  for (const c of [...plan.cuts].reverse()) {
    const a = c.above.flatMap(leaves), b = c.below.flatMap(leaves);
    if (!a.length || !b.length) continue;
    const A = w.Manifold.union(a.map((id) => parts[id - 1].solid)), B = w.Manifold.union(b.map((id) => parts[id - 1].solid));
    const travel = JOINT.maxDepth + 1;
    let ok = true;
    for (let k = 8; k >= 1 && ok; k--) if (A.translate(c.n.map((v) => (v * travel * k) / 8) as [number, number, number]).intersect(B).volume() > 1e-3) ok = false;
    const pins = parts.filter((p) => p.role === 'pin' && p.name.endsWith(`_cut${c.id}`)).map((p) => p.id);
    assemblyOrder.push({ cut: c.id, dir: c.n.map((v) => -v), a, b, pins, ok });
    if (!ok) warnings.push(`Cut ${c.id}: sweep check found a collision while joining (should not happen for one planar seam; check the model).`);
  }
  if (assemblyOrder.length) checks['Assembly sequence (planar BSP: straight joins proved; sampled sweep re-check)'] = assemblyOrder.every((x) => x.ok) ? 'PASS' : 'FAIL';

  // Placement: inside the build volume, on the bed, no overlaps on the same plate (exact mesh booleans).
  const outside = parts.filter((p) => { if (!p.placed) return true; const b = p.placed.boundingBox(); return b.min[0] < -1e-6 || b.min[1] < -1e-6 || b.max[0] > BED + 1e-6 || b.max[1] > BED + 1e-6 || b.max[2] > A1_MINI.z + 1e-6 || Math.abs(b.min[2]) > 1e-4; });
  checks['Every part on the bed, inside 180×180×180'] = outside.length ? `FAIL (${outside.map((p) => p.name).join(', ')})` : 'PASS';
  let clash = 0;
  for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++) if (parts[i].plate === parts[j].plate && parts[i].placed && parts[j].placed) {
    const bi = parts[i].placed!.boundingBox(), bj = parts[j].placed!.boundingBox();
    if (bi.max[0] < bj.min[0] || bj.max[0] < bi.min[0] || bi.max[1] < bj.min[1] || bj.max[1] < bi.min[1]) continue;
    if (parts[i].placed!.intersect(parts[j].placed!).volume() > 1e-6) clash++;
  }
  checks['No overlapping parts on any plate'] = clash ? `FAIL (${clash} pairs)` : 'PASS';

  // ---- summary metrics (geometric estimates) ----
  const sum = (f: (o: OrientEval) => number) => bodies.reduce((s, p) => s + (p.metrics ? f(p.metrics) : 0), 0);
  const summary: Record<string, number | string> = {
    bodyParts: bodies.length, dowels: pinParts.length, plates: pk.plates, cuts: cuts.length,
    seamLengthMm: +seamRaw.toFixed(1), visibleSeamMm: +seamVis.toFixed(1), curvedSeams: cuts.filter((c) => c.curved).length,
    supportAreaMm2: +sum((o) => o.supportArea).toFixed(0),
    supportOnVisibleMm2: +sum((o) => o.supportVisible).toFixed(0),
    supportVolumeMm3: +sum((o) => o.supportVolume).toFixed(0),
    stairVisibleMm2: +sum((o) => o.stair).toFixed(0),
    sagVisibleMm2: +sum((o) => o.sag).toFixed(0),
    minBedContactMm2: +Math.min(...bodies.map((p) => p.bedContact)).toFixed(0),
    searchStatesExplored: sr.explored, totalCost: +plan.cost.toFixed(0), unsplitCost: +sr.root.cost.toFixed(0),
  };
  const alternatives: Alternative[] = [sr.root, ...sr.frontier].map((s) => ({ parts: s.parts.length, cuts: s.cuts.length, cost: +s.cost.toFixed(0), feasible: s.feasible, terms: Object.fromEntries(Object.entries(s.terms).map(([k, v]) => [k, +v.toFixed(0)])) }));

  const rootFits = sr.root.feasible;
  let decision: string;
  if (!cuts.length) decision = rootFits ? `Printed whole: no split improved the result enough to justify a seam (best split candidate explored: ${bestSplitCost(sr) ?? 'none'} vs unsplit ${sr.root.cost.toFixed(0)}).` : 'Model does not fit and no valid cut was found.';
  else decision = `${rootFits ? 'Fits whole, but splitting improves print quality' : 'Exceeds the A1 Mini usable volume'}: ${cuts.length} cut(s) → ${bodies.length} body parts + ${pinParts.length} dowels on ${pk.plates} plate(s). Cost ${plan.cost.toFixed(0)} vs unsplit ${rootFits ? sr.root.cost.toFixed(0) : 'infeasible'}.`;
  if (cuts.length) warnings.push(`Joint clearances are a baseline profile (${JOINT.clearance} mm radial, 0.5 mm mouth chamfer, ${JOINT.endGap} mm end gap). Print one test joint first: fit varies by printer and material.`);
  warnings.push('Support, stair-stepping and seam visibility are geometric estimates from the mesh, not slicer results.');
  progress('Done', 1);
  return { scale, parts, cuts, plates: pk.plates, decision, warnings, checks, assemblyOrder, summary, alternatives };
}

const bestSplitCost = (sr: { frontier: SState[] }) => { const s = sr.frontier.filter((x) => x.cuts.length).sort((a, b) => a.cost - b.cost)[0]; return s ? s.cost.toFixed(0) : null; };

/** Length of the plane ∩ surface curve (raw seam length, mm). */
function rawSeamLength(m: Manifold, n: number[], h: number): number {
  const cs = m.transform(mat(rotTo(n, [0, 0, 1]))).slice(h);
  return cs.toPolygons().reduce((s, poly) => s + poly.reduce((t, p, i) => { const q = poly[(i + 1) % poly.length]; return t + Math.hypot(q[0] - p[0], q[1] - p[1]); }, 0), 0);
}
