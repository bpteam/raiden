// Candidate cut planes for one part, ranked by how visible the resulting seam would be on the ASSEMBLED model.
// Seam cost = ∫ over the plane/surface intersection curve of (visibility × detail × anti-crease) — a seam hidden under a
// skirt, inside a sleeve or in a fold is nearly free; one across a smooth visible surface or through a face is expensive.
// Necks (local minima of the section perimeter) get a bonus: the eye already expects a line there.
import type { PartMesh } from './analysis';
import { sphereDirs } from './raster';

export interface PlaneCand { n: number[]; h: number; seam: number; perim: number; neck: number; score: number; balance: number }

/** Seam weight per mm of seam on triangle i. A 0.15 floor keeps fully hidden seams from being totally free (assembly gap, glue). */
export const seamWeight = (pm: PartMesh, i: number) =>
  pm.iface[i] ? 0 : 0.15 + pm.V[i] * (1 + 0.5 * pm.D[i]) * (1 - 0.6 * Math.max(0, pm.C[i]));

// Hemisphere of plane normals (± give the same plane family).
const DIRS = sphereDirs(64).filter((d) => d[2] > 0 || (d[2] === 0 && d[1] >= 0));

export function principalAxes(pm: PartMesh): number[][] {
  let sa = 0; const m = [0, 0, 0];
  for (let i = 0; i < pm.nt; i++) { sa += pm.area[i]; for (let k = 0; k < 3; k++) m[k] += pm.area[i] * pm.cx[i * 3 + k]; }
  m.forEach((_, k) => (m[k] /= sa || 1));
  const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < pm.nt; i++) for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) C[a][b] += pm.area[i] * (pm.cx[i * 3 + a] - m[a]) * (pm.cx[i * 3 + b] - m[b]);
  // power iteration with deflation: three axes are enough here
  const axes: number[][] = [];
  const M = C.map((r) => r.slice());
  for (let k = 0; k < 3; k++) {
    let v = [1, 0.7, 0.3];
    for (let it = 0; it < 50; it++) { const w = M.map((r) => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]); const l = Math.hypot(...w) || 1; v = w.map((x) => x / l); }
    const lam = v.reduce((s, x, a) => s + x * M[a].reduce((t, y, b) => t + y * v[b], 0), 0);
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) M[a][b] -= lam * v[a] * v[b];
    axes.push(v[2] < 0 ? v.map((x) => -x) : v);
  }
  return axes;
}

/** Seam profile along one normal: visible-seam integral and raw perimeter for planes every `step` mm. */
export function seamProfile(pm: PartMesh, n: number[], step: number) {
  const P = pm.pos, I = pm.idx;
  let lo = Infinity, hi = -Infinity;
  const s = new Float32Array(P.length / 3);
  for (let i = 0; i < s.length; i++) { s[i] = P[i * 3] * n[0] + P[i * 3 + 1] * n[1] + P[i * 3 + 2] * n[2]; lo = Math.min(lo, s[i]); hi = Math.max(hi, s[i]); }
  const bins = Math.max(3, Math.floor((hi - lo) / step));
  const st = (hi - lo) / bins;
  const seam = new Float64Array(bins + 1), perim = new Float64Array(bins + 1), below = new Float64Array(bins + 1);
  const cx = pm.cx;
  for (let t = 0; t < pm.nt; t++) {
    // sort the three corners by s (no allocations: this loop runs for every triangle × direction)
    let a = I[t * 3], b = I[t * 3 + 1], c = I[t * 3 + 2], x;
    if (s[a] > s[b]) { x = a; a = b; b = x; }
    if (s[b] > s[c]) { x = b; b = c; c = x; }
    if (s[a] > s[b]) { x = a; a = b; b = x; }
    const sa = s[a], sb = s[b], sc = s[c];
    const bc = Math.ceil((cx[t * 3] * n[0] + cx[t * 3 + 1] * n[1] + cx[t * 3 + 2] * n[2] - lo) / st);
    below[bc < 0 ? 0 : bc > bins ? bins : bc] += pm.area[t];
    const j0 = Math.max(1, Math.ceil((sa - lo) / st)), j1 = Math.min(bins - 1, Math.floor((sc - lo) / st));
    if (j1 < j0 || sc - sa < 1e-9) continue;
    const w = seamWeight(pm, t);
    const ax = P[a * 3], ay = P[a * 3 + 1], az = P[a * 3 + 2];
    const dacx = P[c * 3] - ax, dacy = P[c * 3 + 1] - ay, dacz = P[c * 3 + 2] - az, dac = sc - sa;
    for (let j = j0; j <= j1; j++) {
      const h = lo + j * st;
      const f = (h - sa) / dac;
      const px = ax + f * dacx, py = ay + f * dacy, pz = az + f * dacz;
      let qx, qy, qz;
      if (h < sb) { const g = (h - sa) / (sb - sa || 1e-12); qx = ax + g * (P[b * 3] - ax); qy = ay + g * (P[b * 3 + 1] - ay); qz = az + g * (P[b * 3 + 2] - az); }
      else { const g = (h - sb) / (sc - sb || 1e-12), bx = P[b * 3], by = P[b * 3 + 1], bz = P[b * 3 + 2]; qx = bx + g * (P[c * 3] - bx); qy = by + g * (P[c * 3 + 1] - by); qz = bz + g * (P[c * 3 + 2] - bz); }
      const len = Math.hypot(px - qx, py - qy, pz - qz);
      seam[j] += len * w; perim[j] += len;
    }
  }
  for (let j = 1; j <= bins; j++) below[j] += below[j - 1];
  const total = below[bins] || 1;
  return { lo, st, bins, seam, perim, frac: Array.from(below, (x) => x / total) };
}

/** Rank planes: per direction, local minima of seam score; then a diverse top-k across directions. */
export function candidatePlanes(pm: PartMesh, k: number, needProgress: boolean): PlaneCand[] {
  const out: PlaneCand[] = [];
  const dirs = [...DIRS, ...principalAxes(pm)];
  for (const n of dirs) {
    const p = seamProfile(pm, n, 1.5);
    const win = Math.max(3, Math.round(p.bins * 0.12));
    const local: PlaneCand[] = [];
    for (let j = 1; j < p.bins; j++) {
      if (p.perim[j] <= 0) continue;
      const balance = Math.min(p.frac[j], 1 - p.frac[j]);
      if (balance < 0.03) continue; // slivers: no seam is worth a crumb-sized part
      let lmax = 0, rmax = 0;
      for (let q = Math.max(0, j - win); q < j; q++) lmax = Math.max(lmax, p.perim[q]);
      for (let q = j + 1; q <= Math.min(p.bins, j + win); q++) rmax = Math.max(rmax, p.perim[q]);
      const side = Math.min(lmax, rmax); // a neck needs wider surface on BOTH sides (an end cap is not a neck)
      const neck = side > 0 ? Math.max(0, 1 - p.perim[j] / side) : 0;
      const score = 3 * p.seam[j] * (1 - 0.5 * neck);
      local.push({ n, h: p.lo + j * p.st, seam: p.seam[j], perim: p.perim[j], neck, score, balance });
    }
    // local minima of the score over ±3 bins
    const mins = local.filter((c, i) => local.slice(Math.max(0, i - 3), i + 4).every((d) => d.score >= c.score));
    mins.sort((a, b) => a.score - b.score);
    out.push(...mins.slice(0, 3));
    if (needProgress && p.bins * p.st > 170) { // only directions along which the part is too long can make progress
      // For an oversized part, also offer the best seams inside the window where the cut actually makes progress:
      // both sides ≤ 170 mm along n when possible, else one bed-sized piece off either end.
      const lo = p.lo, hi = p.lo + p.bins * p.st, len = hi - lo;
      const win: [number, number][] = len <= 340 ? [[Math.max(lo + 5, hi - 170), Math.min(hi - 5, lo + 170)]] : [[lo + 100, lo + 170], [hi - 170, hi - 100]];
      for (const [a, b] of win) out.push(...local.filter((c) => c.h >= a && c.h <= b).sort((x, y) => x.score - y.score).slice(0, 2).map((c) => ({ ...c, balance: Math.max(c.balance, 0.21), score: c.score - 20 * (len - 170) }))); // longer = more progress
    }
  }
  out.sort((a, b) => a.score - b.score);
  const pick: PlaneCand[] = [];
  const pickBal: PlaneCand[] = [];
  for (const c of out) {
    const dup = (q: PlaneCand) => Math.abs(q.n[0] * c.n[0] + q.n[1] * c.n[1] + q.n[2] * c.n[2]) > 0.97 && Math.abs(q.h - c.h * Math.sign(q.n[0] * c.n[0] + q.n[1] * c.n[1] + q.n[2] * c.n[2])) < 6;
    if (pick.length < k && !pick.some(dup)) pick.push(c);
    else if (needProgress && c.balance > 0.2 && pickBal.length < Math.ceil(k / 2) && !pick.some(dup) && !pickBal.some(dup)) pickBal.push(c);
  }
  return [...pick, ...pickBal];
}

/**
 * Realised seam of one finished part, planar or curved: edges between cut-cap triangles (iface) and original surface.
 * Returns raw length and visibility-weighted length (mm). Each seam belongs to two parts, so callers halve the sum.
 */
export function seamFromCaps(pm: PartMesh, planes: { normal: number[]; offset: number }[]): { raw: number; weighted: number; seamTri: Uint8Array } {
  const owner = new Map<number, number>();
  const nv = pm.pos.length / 3;
  let raw = 0, weighted = 0;
  const seamTri = new Uint8Array(pm.nt);
  for (let t = 0; t < pm.nt; t++) for (let k = 0; k < 3; k++) {
    const a = pm.idx[t * 3 + k], b = pm.idx[t * 3 + ((k + 1) % 3)];
    const key = a < b ? a * nv + b : b * nv + a;
    const o = owner.get(key);
    if (o === undefined) { owner.set(key, t); continue; }
    if (pm.iface[o] === pm.iface[t]) continue;
    const surf = pm.iface[o] ? t : o;
    // only real seams: within the ±13 mm slab a (possibly curved) cut can occupy around one of the part's cut planes
    const x = pm.cx[surf * 3], y = pm.cx[surf * 3 + 1], z = pm.cx[surf * 3 + 2];
    if (!planes.some((p) => Math.abs(x * p.normal[0] + y * p.normal[1] + z * p.normal[2] - p.offset) <= 13)) continue;
    const L = Math.hypot(pm.pos[a * 3] - pm.pos[b * 3], pm.pos[a * 3 + 1] - pm.pos[b * 3 + 1], pm.pos[a * 3 + 2] - pm.pos[b * 3 + 2]);
    raw += L; weighted += L * seamWeight(pm, surf); seamTri[surf] = 1;
  }
  return { raw, weighted, seamTri };
}
