// Manifold wrapper: load wasm, build a solid from a triangle soup with honest diagnostics.
import Module from 'manifold-3d';
import type { ManifoldToplevel, Manifold } from 'manifold-3d';

export type Wasm = ManifoldToplevel;
let cached: Promise<Wasm> | null = null;

export function loadManifold(wasmUrl?: string): Promise<Wasm> {
  cached ??= (Module as any)(wasmUrl ? { locateFile: () => wasmUrl } : {}).then((w: Wasm) => { w.setup(); return w; });
  return cached!;
}

export interface SolidReport {
  inputTris: number; components: number; manifoldComponents: number; droppedComponents: number;
  openEdges: number; volume: number; bbox: number[]; genus: number; ok: boolean; notes: string[];
}

/** Weld vertices, then build the largest valid solid possible. Never silently "fixes" geometry: every drop is reported. */
export function toManifold(w: Wasm, soup: Float32Array): { solid: Manifold | null; report: SolidReport } {
  const nT = soup.length / 9;
  const notes: string[] = [];
  let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < soup.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], soup[i + k]); hi[k] = Math.max(hi[k], soup[i + k]); }
  const eps = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) * 1e-6 || 1e-9;
  const map = new Map<string, number>();
  const verts: number[] = [];
  const tris: number[] = [];
  for (let t = 0; t < nT; t++) {
    const id = [0, 1, 2].map((j) => {
      const o = t * 9 + j * 3;
      const key = `${Math.round(soup[o] / eps)},${Math.round(soup[o + 1] / eps)},${Math.round(soup[o + 2] / eps)}`;
      let i = map.get(key);
      if (i === undefined) { i = verts.length / 3; map.set(key, i); verts.push(soup[o], soup[o + 1], soup[o + 2]); }
      return i;
    });
    if (id[0] !== id[1] && id[1] !== id[2] && id[0] !== id[2]) tris.push(...id);
  }
  if (tris.length / 3 < nT) notes.push(`${nT - tris.length / 3} degenerate triangles removed`);
  // Connected components by shared vertices (union-find).
  const par = new Int32Array(verts.length / 3).map((_, i) => i);
  const find = (a: number): number => (par[a] === a ? a : (par[a] = find(par[a])));
  for (let i = 0; i < tris.length; i += 3) { par[find(tris[i])] = find(tris[i + 1]); par[find(tris[i])] = find(tris[i + 2]); }
  const groups = new Map<number, number[]>();
  for (let i = 0; i < tris.length; i += 3) { const r = find(tris[i]); if (!groups.has(r)) groups.set(r, []); groups.get(r)!.push(tris[i], tris[i + 1], tris[i + 2]); }
  // Open/non-manifold edge count over whole mesh.
  const edges = new Map<string, number>();
  for (let i = 0; i < tris.length; i += 3) for (let k = 0; k < 3; k++) {
    const a = tris[i + k], b = tris[i + ((k + 1) % 3)];
    const key = a < b ? `${a}_${b}` : `${b}_${a}`;
    edges.set(key, (edges.get(key) ?? 0) + 1);
  }
  let openEdges = 0;
  for (const c of edges.values()) if (c !== 2) openEdges++;

  const vp = new Float32Array(verts);
  const good: Manifold[] = [];
  let dropped = 0;
  let reoriented = 0;
  const attempt = (g: number[]) => {
    try {
      const m = new w.Manifold(new w.Mesh({ numProp: 3, vertProperties: vp, triVerts: new Uint32Array(g) }));
      if (m.status() === 'NoError' && !m.isEmpty()) return m;
    } catch { /* not manifold */ }
    return null;
  };
  for (const g of groups.values()) {
    let m = attempt(g);
    if (!m) { const fixed = orientConsistently(g); if (fixed && (m = attempt(flipIfInverted(fixed, vp)))) reoriented++; }
    if (m && m.volume() < 0) m = null;
    if (m && m.volume() === 0) m = null;
    if (m) good.push(m); else dropped++;
  }
  if (reoriented) notes.push(`${reoriented} component(s) had inconsistent face winding; re-oriented`);
  if (dropped) notes.push(`${dropped} non-watertight component(s) excluded from solid`);
  const solid = good.length ? w.Manifold.union(good) : null;
  const bb = solid?.boundingBox();
  const report: SolidReport = {
    inputTris: nT, components: groups.size, manifoldComponents: good.length, droppedComponents: dropped, openEdges,
    volume: solid?.volume() ?? 0, genus: solid?.genus() ?? 0,
    bbox: bb ? [...bb.min, ...bb.max] : [...lo, ...hi], ok: !!solid && dropped === 0, notes,
  };
  return { solid, report };
}

/** BFS over edge-adjacent triangles, flipping so shared edges run opposite. Then make signed volume positive. Null if edges are not 2-manifold. */
function orientConsistently(g: number[]): number[] | null {
  const t = g.slice();
  const n = t.length / 3;
  const adj = new Map<string, number[]>();
  const key = (a: number, b: number) => (a < b ? `${a}_${b}` : `${b}_${a}`);
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) {
    const kk = key(t[i * 3 + k], t[i * 3 + ((k + 1) % 3)]);
    if (!adj.has(kk)) adj.set(kk, []);
    adj.get(kk)!.push(i);
  }
  for (const v of adj.values()) if (v.length !== 2) return null;
  const seen = new Uint8Array(n);
  const dir = (i: number, a: number, b: number) => { for (let k = 0; k < 3; k++) if (t[i * 3 + k] === a && t[i * 3 + ((k + 1) % 3)] === b) return true; return false; };
  for (let s = 0; s < n; s++) {
    if (seen[s]) continue;
    seen[s] = 1;
    const q = [s];
    while (q.length) {
      const i = q.pop()!;
      for (let k = 0; k < 3; k++) {
        const a = t[i * 3 + k], b = t[i * 3 + ((k + 1) % 3)];
        for (const j of adj.get(key(a, b))!) {
          if (j === i || seen[j]) continue;
          if (dir(j, a, b)) { const x = t[j * 3 + 1]; t[j * 3 + 1] = t[j * 3 + 2]; t[j * 3 + 2] = x; }
          seen[j] = 1;
          q.push(j);
        }
      }
    }
  }
  return t;
}

export function flipIfInverted(t: number[], vp: Float32Array): number[] {
  let vol = 0;
  for (let i = 0; i < t.length; i += 3) {
    const [a, b, c] = [t[i], t[i + 1], t[i + 2]].map((v) => [vp[v * 3], vp[v * 3 + 1], vp[v * 3 + 2]]);
    vol += a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
  }
  if (vol >= 0) return t;
  const r = t.slice();
  for (let i = 0; i < r.length; i += 3) [r[i + 1], r[i + 2]] = [r[i + 2], r[i + 1]];
  return r;
}

export function meshToSoup(m: Manifold): Float32Array {
  const mesh = m.getMesh();
  const out = new Float32Array(mesh.numTri * 9);
  for (let t = 0; t < mesh.numTri; t++) for (let j = 0; j < 3; j++) {
    const v = mesh.triVerts[t * 3 + j];
    for (let k = 0; k < 3; k++) out[t * 9 + j * 3 + k] = mesh.vertProperties[v * mesh.numProp + k];
  }
  return out;
}
