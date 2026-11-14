// Joint search over decompositions (Chopper-style beam search over a BSP of planar cuts), where every candidate state is
// scored together with the consequences of its cuts: per-part best print orientation (support scars, stair-stepping,
// tipping), seam visibility, connector feasibility, part count and plate count. The unsplit model is always a candidate.
// Runs on a simplified proxy for speed; the chosen cut sequence is replayed on the full-resolution mesh afterwards.
import type { Manifold } from 'manifold-3d';
import { partMesh, evenOut, type Field, type PartMesh } from './analysis';
import { bestOrient, USABLE, type OrientEval } from './orient';
import { candidatePlanes, type PlaneCand } from './cuts';
import { JOINT, rotTo, mat } from './joints';

export interface SPart { cands?: PlaneCand[]; id: number; m: Manifold | null; pm: PartMesh | null; bb: number[]; hull: Float32Array; faces: { normal: number[]; offset: number }[]; vol: number; o: OrientEval; est: number }
export interface SCut { id: number; parent: number; n: number[]; h: number; above: number[]; below: number[]; seam: number; neck: number; islands: number; glue: number; small: number; slabs?: number; cost: number }
export interface SState { parts: SPart[]; cuts: SCut[]; cost: number; feasible: boolean; terms: Record<string, number> }

export const WS = { seam: 3, part: 250, glue: 200, small: 80, plate: 300, oversize: 6000, slab: 500 };

let seq = 0;
/** Every proxy part created during the search, by id (the replay needs intermediate parts too). */
export const registry = new Map<number, SPart>();
const hullPts = (m: Manifold) => { const h = m.hull(); const g = h.getMesh(); h.delete(); const out = new Float32Array(g.numVert * 3); for (let i = 0; i < g.numVert; i++) for (let k = 0; k < 3; k++) out[i * 3 + k] = g.vertProperties[i * g.numProp + k]; return out; };

/** Lower-bound-ish count of bed-sized pieces a non-fitting part needs (∏⌈extent/USABLE⌉ at its best orientation). */
function estPieces(o: OrientEval[]): number {
  return Math.min(...o.map((e) => [e.height, ...e.foot.map((f) => (Number.isFinite(f) ? f : e.height))].reduce((a, d) => a * Math.max(1, Math.ceil((d - 0.5) / USABLE)), 1)));
}

export function makePart(m: Manifold, f: Field, faces: SPart['faces']): SPart {
  const fine = evenOut(m);
  const pm = partMesh(fine, f, faces);
  if (fine !== m) fine.delete();
  const hull = hullPts(m);
  const b = m.boundingBox();
  const { best, all } = bestOrient(pm, hull, faces.map((x) => x.normal));
  // non-fitting part: still report the orientation with the best quality so its cost is meaningful
  const o = best.fits ? best : all.reduce((a, b) => (b.cost - (b.fits ? 0 : 1e7) < a.cost - (a.fits ? 0 : 1e7) ? b : a));
  const part: SPart = { id: ++seq, m, pm, bb: [...b.min, ...b.max], hull, faces, vol: m.volume(), o, est: best.fits ? 1 : Math.max(2, estPieces(all)) };
  registry.set(part.id, part);
  return part;
}

/** Free a part's wasm solid and mesh arrays once no beam state can expand it (keeps id, bbox, volume, orientation). */
function release(p: SPart) { p.m?.delete(); p.m = null; p.pm = null; }

/** Rough plate count: footprint areas (+gap) packed at ~70 % density, at least one plate per part taller than nothing. */
export function estPlates(parts: SPart[]): number {
  let a = 0;
  for (const p of parts) a += (Math.min(p.o.foot[0], USABLE) + 6) * (Math.min(p.o.foot[1], USABLE) + 6);
  return Math.max(1, Math.ceil(a / (USABLE * USABLE * 0.7)));
}

export function scoreState(parts: SPart[], cuts: SCut[]): SState {
  const feasible = parts.every((p) => p.o.fits);
  const terms: Record<string, number> = { orient: 0, seam: 0, joints: 0, parts: 0, plates: 0, oversize: 0 };
  for (const p of parts) {
    terms.orient += p.o.cost - (p.o.fits ? 0 : 1e7);
    if (!p.o.fits) terms.oversize += WS.oversize * p.est;
  }
  for (const c of cuts) { terms.seam += WS.seam * c.seam * (1 - 0.5 * c.neck); terms.joints += WS.glue * c.glue + WS.small * c.small + WS.slab * (c.slabs ?? 0); }
  terms.parts = WS.part * cuts.length; // parts created by cuts; separate input shells are not a cost
  terms.plates = WS.plate * estPlates(parts);
  const cost = Object.values(terms).reduce((a, b) => a + b, 0);
  return { parts, cuts, cost, feasible, terms };
}

/** Section islands at the plane: islands that cannot hold even the smallest dowel are glue-only; tiny ones are fragile. */
function sectionJoinability(m: Manifold, n: number[], h: number) {
  const r = m.transform(mat(rotTo(n, [0, 0, 1])));
  const cs = r.slice(h);
  r.delete();
  const isl = cs.decompose();
  const areas = isl.map((i) => i.area());
  const maxA = Math.max(0, ...areas);
  let glue = 0, small = 0;
  isl.forEach((i, k) => {
    if (areas[k] < maxA * 0.12) small++;
    const o = i.offset(-(JOINT.minPinR + JOINT.clearance + JOINT.wall), 'Round');
    if (o.isEmpty()) glue++;
    o.delete(); i.delete();
  });
  const res = { islands: isl.length, glue, small, area: cs.area() };
  cs.delete();
  return res;
}

export let rejectWhy = '';
export function applyCut(st: SState, part: SPart, c: PlaneCand, f: Field): SState | null {
  const [above, below] = part.m!.splitByPlane(c.n as [number, number, number], c.h);
  const pieces: { m: Manifold; side: number }[] = [];
  for (const [side, sgn] of [[above, 1], [below, -1]] as const) {
    for (const q of side.decompose()) if (q.volume() >= 1) pieces.push({ m: q, side: sgn }); else q.delete(); // <1 mm³: degenerate shells from pinched input edges (dropped in replay too)
    side.delete();
  }
  const reject = (why: string) => { rejectWhy = why; pieces.forEach((p) => p.m.delete()); return null; };
  if (pieces.length < 2) return reject('one piece');
  const minVol = Math.max(part.vol * 0.003, 100); // < 0.3 % or < 100 mm³: crumb, would get lost or snap
  if (pieces.some((p) => p.m.volume() < minVol)) return reject(`crumb ${Math.min(...pieces.map((p) => p.m.volume())).toFixed(0)} mm³`);
  if (pieces.length > 4) return reject(`${pieces.length} pieces`); // shredding many limbs at once: never a good seam
  // washers: a piece thinner than 20 mm along the cut normal that is bounded by another seam is weak and adds a seam for little gain
  let slabs = 0;
  for (const p of pieces) {
    let lo = Infinity, hi = -Infinity;
    const g = p.m.getMesh();
    for (let i = 0; i < g.numVert; i++) { const d = g.vertProperties[i * g.numProp] * c.n[0] + g.vertProperties[i * g.numProp + 1] * c.n[1] + g.vertProperties[i * g.numProp + 2] * c.n[2]; lo = Math.min(lo, d); hi = Math.max(hi, d); }
    if (hi - lo < 20 && part.faces.length) slabs++;
  }
  const j = sectionJoinability(part.m!, c.n, c.h);
  if (!j.islands) return reject('no section');
  const kids = pieces.map((p) => makePart(p.m, f, [...part.faces, { normal: c.n.map((x) => -x * p.side), offset: -c.h * p.side }]));
  const cut: SCut = { id: st.cuts.length + 1, parent: part.id, n: c.n, h: c.h, above: kids.filter((_, i) => pieces[i].side > 0).map((k) => k.id), below: kids.filter((_, i) => pieces[i].side < 0).map((k) => k.id), seam: c.seam, neck: c.neck, islands: j.islands, glue: j.glue, small: j.small, cost: 0 };
  cut.cost = WS.seam * c.seam * (1 - 0.5 * c.neck) + WS.glue * j.glue + WS.small * j.small + WS.slab * slabs;
  cut.slabs = slabs;
  return scoreState([...st.parts.filter((p) => p !== part), ...kids], [...st.cuts, cut]);
}

export interface SearchResult { best: SState; root: SState; explored: number; frontier: SState[] }

/**
 * Beam search. Oversized parts are always expanded first (hard constraint: everything must fit). Once all parts fit,
 * the most costly parts may still be split if that buys better orientations — capped at `qualityCuts` extra cuts.
 * Selection prefers fewer parts unless more parts are clearly (>10 %) better.
 */
/** roots: the model's own disconnected shells (usually one). They are separate parts from the start, at no seam cost. */
export function search(roots: SPart | SPart[], f: Field, opt: { beam: number; perPart: number; maxParts: number; qualityCuts: number; onProgress?: (x: number) => void }): SearchResult {
  const start = scoreState(Array.isArray(roots) ? roots : [roots], []);
  let beam = [start];
  const seen: SState[] = [start];
  let explored = 1;
  for (let depth = 1; depth + start.parts.length <= opt.maxParts; depth++) {
    const next: SState[] = [];
    for (const s of beam) {
      const over = s.parts.filter((p) => !p.o.fits).sort((a, b) => b.vol - a.vol);
      const qualityDepth = s.cuts.length - countForcedCuts(s);
      let targets: SPart[];
      if (over.length) targets = over.slice(0, 1); // largest oversized part first; the beam keeps alternatives
      else if (qualityDepth < opt.qualityCuts) targets = [...s.parts].sort((a, b) => b.o.cost - a.o.cost).slice(0, 2);
      else continue;
      for (const p of targets) for (const c of (p.cands ??= candidatePlanes(p.pm!, opt.perPart, !p.o.fits))) { // parts are shared by beam states: rank once
        const ns = applyCut(s, p, c, f);
        explored++;
        if (ns) { (ns as SState & { forced?: number }).forced = countForcedCuts(s) + (p.o.fits ? 0 : 1); next.push(ns); }
      }
    }
    if (!next.length) break;
    next.sort((a, b) => a.cost - b.cost);
    // keep the beam diverse: drop states whose cost is within 0.5 % of a better one with the same part count
    beam = [];
    for (const s of next) { if (beam.length >= opt.beam) break; if (!beam.some((b) => b.parts.length === s.parts.length && Math.abs(b.cost - s.cost) < b.cost * 0.005)) beam.push(s); }
    seen.push(...beam);
    // free every solid no surviving state can expand any more (wasm heap is limited; ~MBs per part)
    const live = new Set(beam.flatMap((s) => s.parts));
    for (const p of registry.values()) if (p.m && !live.has(p)) release(p);
    opt.onProgress?.(depth / opt.maxParts);
    if (beam.every((s) => s.feasible) && beam.every((s) => s.cost > bestOf(seen).cost * 1.5)) break;
  }
  for (const p of registry.values()) release(p);
  return { best: bestOf(seen), root: start, explored, frontier: pareto(seen) };
}

const countForcedCuts = (s: SState) => (s as SState & { forced?: number }).forced ?? 0;

/**
 * Best feasible state, biased toward fewer parts: start from the best state with the fewest parts and accept each extra
 * part only if it lowers the total cost by ≥ 8 % of that baseline. The weights only approximate what a seam, a joint and
 * an assembly step really cost, so a marginal gain never justifies another part.
 */
function bestOf(states: SState[]): SState {
  const ok = states.filter((s) => s.feasible);
  if (!ok.length) return states.reduce((a, b) => (b.cost < a.cost ? b : a));
  const minParts = Math.min(...ok.map((s) => s.parts.length));
  const base = ok.filter((s) => s.parts.length === minParts).reduce((a, b) => (b.cost < a.cost ? b : a));
  let best = base;
  for (const s of ok) {
    const need = base.cost * (1 - 0.08 * (s.parts.length - minParts));
    if (s.cost <= need && s.cost < best.cost) best = s;
  }
  return best;
}

/** Non-dominated feasible states over (visual cost, part count, plates) — kept for the report, not shown in the main UI. */
function pareto(states: SState[]): SState[] {
  const ok = states.filter((s) => s.feasible);
  const key = (s: SState) => [s.terms.orient + s.terms.seam, s.parts.length, s.terms.plates];
  return ok.filter((s) => !ok.some((t) => t !== s && key(t).every((v, i) => v <= key(s)[i]) && key(t).some((v, i) => v < key(s)[i])));
}
