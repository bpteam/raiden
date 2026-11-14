// Orthographic z-buffer rasterizer. Used for surface visibility (which triangles can a viewer see from direction d)
// and for headless report renders. Pure JS, no WebGL, works in worker and node.

export interface Tris { pos: Float32Array; idx: Uint32Array } // indexed triangle mesh, xyz per vertex

export interface View { depth: Float32Array; id: Int32Array; n: number; u: number[]; v: number[]; d: number[]; ox: number; oy: number; pix: number }

/** Unit vectors u, v spanning the image plane of a camera looking along d (v roughly "up" = +z when possible). */
export function basis(d: number[]): [number[], number[]] {
  const up = Math.abs(d[2]) > 0.95 ? [0, 1, 0] : [0, 0, 1];
  let u = [up[1] * d[2] - up[2] * d[1], up[2] * d[0] - up[0] * d[2], up[0] * d[1] - up[1] * d[0]];
  const l = Math.hypot(u[0], u[1], u[2]);
  u = u.map((x) => x / l);
  const v = [d[1] * u[2] - d[2] * u[1], d[2] * u[0] - d[0] * u[2], d[0] * u[1] - d[1] * u[0]];
  return [u, v];
}

/** Render triangle ids and depth (p·d, smaller = closer) on an n×n grid covering `extent` (center c, half-size r). */
export function render(m: Tris, d: number[], n: number, c: number[], r: number): View {
  const [u, v] = basis(d);
  const depth = new Float32Array(n * n).fill(Infinity);
  const id = new Int32Array(n * n).fill(-1);
  const pix = (2 * r) / n;
  const ox = c[0] * u[0] + c[1] * u[1] + c[2] * u[2] - r, oy = c[0] * v[0] + c[1] * v[1] + c[2] * v[2] - r;
  const P = m.pos, nv = P.length / 3;
  const X = new Float32Array(nv), Y = new Float32Array(nv), Z = new Float32Array(nv);
  for (let i = 0; i < nv; i++) {
    const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
    X[i] = (x * u[0] + y * u[1] + z * u[2] - ox) / pix - 0.5;
    Y[i] = (x * v[0] + y * v[1] + z * v[2] - oy) / pix - 0.5;
    Z[i] = x * d[0] + y * d[1] + z * d[2];
  }
  const I = m.idx;
  for (let t = 0; t < I.length / 3; t++) {
    const a = I[t * 3], b = I[t * 3 + 1], cc = I[t * 3 + 2];
    const x0 = X[a], y0 = Y[a], x1 = X[b], y1 = Y[b], x2 = X[cc], y2 = Y[cc];
    const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
    if (Math.abs(area) < 1e-12) continue;
    const minx = Math.max(0, Math.ceil(Math.min(x0, x1, x2))), maxx = Math.min(n - 1, Math.floor(Math.max(x0, x1, x2)));
    const miny = Math.max(0, Math.ceil(Math.min(y0, y1, y2))), maxy = Math.min(n - 1, Math.floor(Math.max(y0, y1, y2)));
    for (let py = miny; py <= maxy; py++) for (let px = minx; px <= maxx; px++) {
      const w0 = ((x1 - px) * (y2 - py) - (x2 - px) * (y1 - py)) / area;
      const w1 = ((x2 - px) * (y0 - py) - (x0 - px) * (y2 - py)) / area;
      const w2 = 1 - w0 - w1;
      if (w0 < 0 || w1 < 0 || w2 < 0) continue;
      const z = w0 * Z[a] + w1 * Z[b] + w2 * Z[cc];
      const k = py * n + px;
      if (z < depth[k]) { depth[k] = z; id[k] = t; }
    }
  }
  return { depth, id, n, u, v, d, ox, oy, pix };
}

/** Is point p (not hidden by more than tol) the first surface along d at its pixel? */
export function visibleAt(view: View, p: number[], tol: number): boolean {
  const { u, v, d, ox, oy, pix, n } = view;
  const px = Math.round((p[0] * u[0] + p[1] * u[1] + p[2] * u[2] - ox) / pix - 0.5);
  const py = Math.round((p[0] * v[0] + p[1] * v[1] + p[2] * v[2] - oy) / pix - 0.5);
  if (px < 0 || py < 0 || px >= n || py >= n) return true;
  const z = p[0] * d[0] + p[1] * d[1] + p[2] * d[2];
  // farthest depth of the 3×3 neighbourhood: tolerates sub-pixel misses on silhouettes and thin features
  let far = -Infinity;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const x = px + dx, y = py + dy;
    if (x >= 0 && y >= 0 && x < n && y < n) far = Math.max(far, view.depth[y * n + x]);
  }
  return z <= far + tol;
}

/** Points on a sphere, roughly uniform (Fibonacci). */
export function sphereDirs(k: number): number[][] {
  const out: number[][] = [];
  const ga = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < k; i++) {
    const z = 1 - (2 * (i + 0.5)) / k, r = Math.sqrt(1 - z * z);
    out.push([r * Math.cos(i * ga), r * Math.sin(i * ga), z]);
  }
  return out;
}
