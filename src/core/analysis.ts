// Surface analysis of the assembled model, computed once per run and looked up by every candidate part.
//   V  visibility: from how many ordinary viewing directions (side/above, not from well below) the surface is seen
//      head-on (within 60°) and unoccluded. Saturates at 8 of 96 directions, so a face recessed in a bonnet or hair —
//      visible only from a frontal cone — still counts as fully visible. Low = under skirts, inside sleeves, under the
//      chin, in folds, on the underside. Orthographic z-buffer per direction. No "front" is assumed.
//   D  detail: normal variation in a 2.5 mm ball (faces, fingers, hair strands, ornaments are high; smooth panels low).
//   C  concavity: >0 where the surface curves toward its normal (creases, necks, folds), <0 on convex bumps.
// These are geometric proxies for "visually important"; they need no semantic labels.
import type { Manifold } from 'manifold-3d';
import { render, visibleAt, sphereDirs, type Tris } from './raster';

export interface Field {
  n: number; cx: Float32Array; nrm: Float32Array; V: Float32Array; D: Float32Array; C: Float32Array;
  cell: number; grid: Map<number, number[]>;
  memo: Map<number, number>; // quantised triangle centroid → lookup result (cut pieces share most triangles with their parent)
}

const R_DETAIL = 2.5; // mm
const VIEWS = 96;
const HEAD_ON = 8;  // head-on unoccluded views (of 96) that make a surface fully visible

export function meshOf(m: Manifold): Tris {
  const g = m.getMesh();
  const np = g.numProp;
  const pos = new Float32Array(g.numVert * 3);
  for (let i = 0; i < g.numVert; i++) for (let k = 0; k < 3; k++) pos[i * 3 + k] = g.vertProperties[i * np + k];
  return { pos, idx: new Uint32Array(g.triVerts) };
}

/** Per-triangle centroid, unit normal and area. */
export function triGeom(t: Tris) {
  const nt = t.idx.length / 3;
  const cx = new Float32Array(nt * 3), nrm = new Float32Array(nt * 3), area = new Float32Array(nt);
  const P = t.pos;
  for (let i = 0; i < nt; i++) {
    const a = t.idx[i * 3] * 3, b = t.idx[i * 3 + 1] * 3, c = t.idx[i * 3 + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const wx = P[c] - P[a], wy = P[c + 1] - P[a + 1], wz = P[c + 2] - P[a + 2];
    const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    const l = Math.hypot(nx, ny, nz);
    area[i] = l / 2;
    if (l > 0) { nrm[i * 3] = nx / l; nrm[i * 3 + 1] = ny / l; nrm[i * 3 + 2] = nz / l; }
    for (let k = 0; k < 3; k++) cx[i * 3 + k] = (P[a + k] + P[b + k] + P[c + k]) / 3;
  }
  return { nt, cx, nrm, area };
}

/** Low-poly meshes only: split long edges (≤ diag/150, ≥ 1.5 mm) so one triangle cannot be half hidden, half visible. */
export function evenOut(m: Manifold): Manifold {
  const b = m.boundingBox();
  const L = Math.max(1.5, Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) / 150);
  if (m.numTri() > 3000) return m; // only genuinely low-poly meshes need it; dense proxies are fine and much faster
  const r = m.refineToLength(L);
  return r.numTri() <= 120000 ? r : m;
}

const key = (x: number, y: number, z: number) => ((x + 1024) * 2048 + (y + 1024)) * 2048 + (z + 1024);

export function analyzeSurface(m: Manifold): Field {
  // Analysis mesh: dense scans simplified (0.15 mm is below one layer height); coarse low-poly meshes refined so one long
  // triangle cannot be half hidden, half visible.
  const src = m.numTri() > 60000 ? m.simplify(0.15) : evenOut(m);
  const t = meshOf(src);
  const { nt, cx, nrm, area } = triGeom(t);
  const b = src.boundingBox();
  const c = [0, 1, 2].map((k) => (b.min[k] + b.max[k]) / 2);
  const r = Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) / 2 + 1;
  const N = 384;
  const V = new Float32Array(nt);
  for (const d of sphereDirs(VIEWS)) {
    if (d[2] > 0.35) continue; // viewer at -d: skip views from well below (figurines stand on a shelf)
    const view = render(t, d, N, c, r);
    const tol = 1.5 * view.pix;
    for (let i = 0; i < nt; i++) {
      const facing = nrm[i * 3] * d[0] + nrm[i * 3 + 1] * d[1] + nrm[i * 3 + 2] * d[2];
      if (facing > -0.5) continue; // not head-on: grazing views do not show surface quality
      if (visibleAt(view, [cx[i * 3], cx[i * 3 + 1], cx[i * 3 + 2]], tol)) V[i] += 1;
    }
  }
  for (let i = 0; i < nt; i++) V[i] = Math.min(1, V[i] / HEAD_ON);

  const cell = R_DETAIL;
  const grid = new Map<number, number[]>();
  for (let i = 0; i < nt; i++) {
    const k = key(Math.floor(cx[i * 3] / cell), Math.floor(cx[i * 3 + 1] / cell), Math.floor(cx[i * 3 + 2] / cell));
    let l = grid.get(k); if (!l) grid.set(k, (l = [])); l.push(i);
  }
  const D = new Float32Array(nt), C = new Float32Array(nt);
  for (let i = 0; i < nt; i++) {
    const x = cx[i * 3], y = cx[i * 3 + 1], z = cx[i * 3 + 2];
    const gx = Math.floor(x / cell), gy = Math.floor(y / cell), gz = Math.floor(z / cell);
    let sa = 0, mx = 0, my = 0, mz = 0, conc = 0;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      for (const j of grid.get(key(gx + dx, gy + dy, gz + dz)) ?? []) {
        const ex = cx[j * 3] - x, ey = cx[j * 3 + 1] - y, ez = cx[j * 3 + 2] - z;
        if (ex * ex + ey * ey + ez * ez > R_DETAIL * R_DETAIL) continue;
        const a = area[j];
        sa += a; mx += a * nrm[j * 3]; my += a * nrm[j * 3 + 1]; mz += a * nrm[j * 3 + 2];
        conc += a * (nrm[i * 3] * ex + nrm[i * 3 + 1] * ey + nrm[i * 3 + 2] * ez);
      }
    }
    if (sa > 0) { D[i] = 1 - Math.hypot(mx, my, mz) / sa; C[i] = Math.max(-1, Math.min(1, (conc / sa / R_DETAIL) * 2)); }
  }
  // normalise so the most detailed ~10% of a typical figurine saturate at 1
  for (let i = 0; i < nt; i++) D[i] = Math.min(1, D[i] / 0.6);
  // Lookup samples: every triangle contributes its centroid, corners and edge midpoints (same attributes), so any point
  // of the original surface has a sample within ~¼ triangle size — the "is this original surface?" distance test needs it.
  const ns = nt * 7, scx = new Float32Array(ns * 3), snrm = new Float32Array(ns * 3), sV = new Float32Array(ns), sD = new Float32Array(ns), sC = new Float32Array(ns);
  const P = t.pos, I = t.idx;
  for (let i = 0; i < nt; i++) {
    const a = I[i * 3] * 3, b = I[i * 3 + 1] * 3, c = I[i * 3 + 2] * 3;
    const pts = [[cx[i * 3], cx[i * 3 + 1], cx[i * 3 + 2]], [P[a], P[a + 1], P[a + 2]], [P[b], P[b + 1], P[b + 2]], [P[c], P[c + 1], P[c + 2]],
      [(P[a] + P[b]) / 2, (P[a + 1] + P[b + 1]) / 2, (P[a + 2] + P[b + 2]) / 2], [(P[b] + P[c]) / 2, (P[b + 1] + P[c + 1]) / 2, (P[b + 2] + P[c + 2]) / 2], [(P[c] + P[a]) / 2, (P[c + 1] + P[a + 1]) / 2, (P[c + 2] + P[a + 2]) / 2]];
    pts.forEach((q, k) => { const j = i * 7 + k; scx.set(q, j * 3); snrm.set(nrm.subarray(i * 3, i * 3 + 3), j * 3); sV[j] = V[i]; sD[j] = D[i]; sC[j] = C[i]; });
  }
  const sgrid = new Map<number, number[]>();
  for (let j = 0; j < ns; j++) { const k = key(Math.floor(scx[j * 3] / cell), Math.floor(scx[j * 3 + 1] / cell), Math.floor(scx[j * 3 + 2] / cell)); let l = sgrid.get(k); if (!l) sgrid.set(k, (l = [])); l.push(j); }
  return { n: ns, cx: scx, nrm: snrm, V: sV, D: sD, C: sC, cell, grid: sgrid, memo: new Map() };
}

/** Field values at a surface point with normal nr, or null when no original surface is nearby (new internal surface: cut cap, hole). */
export function lookup(f: Field, p: ArrayLike<number>, nr: ArrayLike<number>, tol: number): number {
  // "is this original surface?" is decided by distance alone (noisy scan normals must not turn surface into "cap");
  // the normal only picks which nearby sample's attributes to use (front vs back of a thin sheet)
  const gx = Math.floor(p[0] / f.cell), gy = Math.floor(p[1] / f.cell), gz = Math.floor(p[2] / f.cell);
  let best = -1, bd = tol * tol, any = -1, ad = tol * tol;
  const reach = Math.ceil(tol / f.cell);
  for (let dx = -reach; dx <= reach; dx++) for (let dy = -reach; dy <= reach; dy++) for (let dz = -reach; dz <= reach; dz++) {
    for (const j of f.grid.get(key(gx + dx, gy + dy, gz + dz)) ?? []) {
      const ex = f.cx[j * 3] - p[0], ey = f.cx[j * 3 + 1] - p[1], ez = f.cx[j * 3 + 2] - p[2];
      const d2 = ex * ex + ey * ey + ez * ez;
      if (d2 >= ad && d2 >= bd) continue;
      if (d2 < ad) { ad = d2; any = j; }
      if (d2 < bd && f.nrm[j * 3] * nr[0] + f.nrm[j * 3 + 1] * nr[1] + f.nrm[j * 3 + 2] * nr[2] >= 0.3) { bd = d2; best = j; if (d2 < 0.04) return j; }
    }
  }
  return best >= 0 ? best : any;
}

/** A part's triangles with surface attributes. iface = 1 on cut caps / joint holes (hidden after assembly). */
export interface PartMesh extends Tris {
  nt: number; cx: Float32Array; nrm: Float32Array; area: Float32Array;
  V: Float32Array; D: Float32Array; C: Float32Array; iface: Uint8Array;
}

export function partMesh(m: Manifold, f: Field, planes: { normal: number[]; offset: number }[], tol = 2): PartMesh {
  const t = meshOf(m);
  const g = triGeom(t);
  const V = new Float32Array(g.nt), D = new Float32Array(g.nt), C = new Float32Array(g.nt), iface = new Uint8Array(g.nt);
  const { cx, nrm } = g;
  const p = [0, 0, 0], nr = [0, 0, 0];
  for (let i = 0; i < g.nt; i++) {
    p[0] = cx[i * 3]; p[1] = cx[i * 3 + 1]; p[2] = cx[i * 3 + 2];
    nr[0] = nrm[i * 3]; nr[1] = nrm[i * 3 + 1]; nr[2] = nrm[i * 3 + 2];
    let cap = false;
    for (const pl of planes) {
      const n = pl.normal;
      if (Math.abs(p[0] * n[0] + p[1] * n[1] + p[2] * n[2] - pl.offset) < 0.05 && nr[0] * n[0] + nr[1] * n[1] + nr[2] * n[2] > 0.99) { cap = true; break; }
    }
    if (cap) { iface[i] = 1; continue; }
    // 1/64 mm grid, ±512 mm range: < 2^48, exact as a JS number; the normal's sign octant guards against coincident centroids
    const k = ((Math.round(p[0] * 64) + 32768) * 65536 + (Math.round(p[1] * 64) + 32768)) * 65536 + (Math.round(p[2] * 64) + 32768) + (nr[2] > 0 ? 0.5 : 0) + (nr[0] > 0 ? 0.25 : 0);
    let j = f.memo.get(k);
    if (j === undefined) { j = lookup(f, p, nr, tol); f.memo.set(k, j); }
    if (j < 0) { iface[i] = 1; continue; }
    V[i] = f.V[j]; D[i] = f.D[j]; C[i] = f.C[j];
  }
  return { ...t, ...g, V, D, C, iface };
}
