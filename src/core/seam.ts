// Curved seams: let a planar cut bend so its seam follows a nearby fold, hem, cuff or crease instead of a straight line.
//
// Work in the cut frame (cut normal = +Z, plane z = h). The seam is re-routed inside a ±BAND mm slab: for every sample
// along each section loop we pick a height, minimising (visibility-weighted seam length) with dynamic programming over
// the loop — the same seam weight the search uses, so a seam tucked under a hem or into a crease is cheap.
// The cutting surface is a HEIGHT FIELD z = f(x, y): equal to the snapped seam heights at the surface, fading back to the
// flat plane within a few mm inwards. Consequences that keep it robust:
//   - the two parts still separate by a straight move along the normal (upper = {z > f}, moving it +Z never re-enters
//     {z ≤ f}), so the BSP assembly proof still holds;
//   - the centre of the section stays flat: dowels are planned there exactly as for planar cuts;
//   - slope between neighbouring seam samples is capped, so no knife-edge lips.
// The curved seam is used only if it lowers the seam cost by ≥ 15 % against the planar one; otherwise planar is kept.
import type { Manifold, Vec2 } from 'manifold-3d';
import type { Wasm } from './geom';
import { lookup, type Field } from './analysis';
import { inPolys } from './joints';

const BAND = 12;   // mm the seam may move along the normal
const DZ = 0.5;    // mm height step
const STEP = 1.5;  // mm between seam samples along a loop
const MAXJUMP = 2; // height steps between neighbouring samples (≤ 1 mm per 1.5 mm ≈ 34°)
const MAXSLIDE = 6; // mm the surface may move sideways inside the band before the sample is considered lost

export interface CurvedSeam { cutter: Manifold; heightAt: (x: number, y: number) => number; gain: number; maxDz: number; samples: number }

const segDist = (p: Vec2, a: Vec2, b: Vec2): [number, Vec2] => {
  const abx = b[0] - a[0], aby = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / (abx * abx + aby * aby || 1)));
  const q: Vec2 = [a[0] + t * abx, a[1] + t * aby];
  return [Math.hypot(p[0] - q[0], p[1] - q[1]), q];
};

/** Nearest point on a set of polygons, with the outward edge normal there. */
function nearest(p: Vec2, polys: Vec2[][]): { d: number; q: Vec2; n: Vec2 } {
  let best = { d: Infinity, q: p, n: [0, 0] as Vec2 };
  for (const poly of polys) for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const [d, q] = segDist(p, a, b);
    if (d < best.d) { const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; best = { d, q, n: [(b[1] - a[1]) / l, -(b[0] - a[0]) / l] }; } // CCW outer loops: right normal = outward
  }
  return best;
}

/** Resample a closed polygon every `step` mm. */
function resample(poly: Vec2[], step: number): Vec2[] {
  const out: Vec2[] = [];
  let carry = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    let t = carry;
    while (t < l) { out.push([a[0] + ((b[0] - a[0]) * t) / l, a[1] + ((b[1] - a[1]) * t) / l]); t += step; }
    carry = t - l;
  }
  return out;
}

/**
 * body: the part in the CUT FRAME (normal = +Z). toWorld maps cut-frame points to model coords (for field lookups).
 * Returns the lower-side cutter solid (cut frame) or null when the planar seam is as good.
 */
export function curveSeam(w: Wasm, body: Manifold, h: number, f: Field, toWorld: (p: number[]) => number[], nWorld: (v: number[]) => number[]): CurvedSeam | null {
  const bb = body.boundingBox();
  const kLo = -Math.min(BAND, h - bb.min[2] - 2) / DZ | 0, kHi = Math.min(BAND, bb.max[2] - h - 2) / DZ | 0;
  if (kHi - kLo < 4) return null;
  const K = kHi - kLo + 1;
  const slices: Vec2[][][] = [];
  for (let k = kLo; k <= kHi; k++) slices.push(body.slice(h + k * DZ).toPolygons() as Vec2[][]);
  const base = slices[-kLo];
  // seam weight of a surface point (cut frame) with horizontal outward normal n
  const weight = (x: number, y: number, z: number, n: Vec2) => {
    const P = toWorld([x, y, z]), N = nWorld([n[0], n[1], 0]);
    const j = lookup(f, P, N, 2.5);
    return j < 0 ? 1 : (0.15 + f.V[j] * (1 + 0.5 * f.D[j]) * (1 - 0.6 * Math.max(0, f.C[j]))) * f.W[j];
  };
  const samples: { x: number; y: number; dz: number }[] = [];
  const seamLoops: Vec2[][] = [];
  let planarCost = 0, curvedCost = 0, maxDz = 0;
  for (const loop of base) {
    const q = resample(loop, STEP);
    const m = q.length;
    if (m < 8) { for (const p of q) samples.push({ x: p[0], y: p[1], dz: 0 }); continue; }
    // candidate seam point for (sample i, height k): nearest surface point on slice k
    const pts = new Float64Array(m * K * 3), cost = new Float64Array(m * K).fill(Infinity);
    for (let i = 0; i < m; i++) for (let k = 0; k < K; k++) {
      const r = nearest(q[i], slices[k]);
      // the surface must be steep between the plane and this height (sideways slide ≤ rise + 1.5 mm): on near-flat skin
      // the bent cut would run almost tangent to it and shave off a sliver
      if (r.d > MAXSLIDE || r.d > Math.abs((k + kLo) * DZ) + 1.5) continue;
      const z = h + (k + kLo) * DZ;
      pts.set([r.q[0], r.q[1], z], (i * K + k) * 3);
      cost[i * K + k] = weight(r.q[0], r.q[1], z, r.n);
    }
    const edge = (i: number, k: number, j: number, l: number) => {
      const a = (i * K + k) * 3, b = (j * K + l) * 3;
      return Math.hypot(pts[a] - pts[b], pts[a + 1] - pts[b + 1], pts[a + 2] - pts[b + 2]) * (cost[i * K + k] + cost[j * K + l]) / 2;
    };
    const k0 = -kLo;
    let planar = 0;
    for (let i = 0; i < m; i++) planar += Number.isFinite(cost[i * K + k0]) && Number.isFinite(cost[((i + 1) % m) * K + k0]) ? edge(i, k0, (i + 1) % m, k0) : 0;
    // closed-loop DP: fix the start height, require the end to return to it (try every 4th start height)
    let bestCost = planar, bestPath: number[] | null = null;
    const D = new Float64Array(m * K), from = new Int32Array(m * K);
    for (let s = 0; s < K; s += 4) {
      if (!Number.isFinite(cost[s])) continue;
      D.fill(Infinity); D[s] = 0;
      for (let i = 1; i <= m; i++) {
        const ii = i % m;
        for (let k = 0; k < K; k++) {
          if (!Number.isFinite(cost[ii * K + k])) continue;
          if (i === m && k !== s) continue;
          let bv = Infinity, bk = -1;
          for (let l = Math.max(0, k - MAXJUMP); l <= Math.min(K - 1, k + MAXJUMP); l++) {
            const prev = D[(i - 1) * K + l];
            if (!Number.isFinite(prev)) continue;
            const v = prev + edge(i - 1, l, ii, k);
            if (v < bv) { bv = v; bk = l; }
          }
          if (i < m) { D[i * K + k] = bv; from[i * K + k] = bk; } else if (bv < bestCost) {
            bestCost = bv;
            const path = new Array<number>(m); path[0] = s; let kk = bk;
            for (let j = m - 1; j >= 1; j--) { path[j] = kk; kk = from[j * K + kk]; }
            bestPath = path;
          }
        }
      }
    }
    planarCost += planar; curvedCost += bestPath ? bestCost : planar;
    const sl: Vec2[] = [];
    for (let i = 0; i < m; i++) {
      const k = bestPath ? bestPath[i] : k0;
      const a = (i * K + k) * 3;
      const dz = (k + kLo) * DZ;
      maxDz = Math.max(maxDz, Math.abs(dz));
      samples.push(bestPath && Number.isFinite(cost[i * K + k]) ? { x: pts[a], y: pts[a + 1], dz } : { x: q[i][0], y: q[i][1], dz: 0 });
      sl.push([samples[samples.length - 1].x, samples[samples.length - 1].y]);
    }
    seamLoops.push(sl);
  }
  const gain = planarCost > 0 ? 1 - curvedCost / planarCost : 0;
  if (gain < 0.15 || maxDz < 1) return null;

  // Height field over a 1 mm grid covering the slab: IDW of nearby samples, faded to the plane within `fade` mm inwards.
  const fade = maxDz + 3; // ≤ ~45° inward slope back to the plane
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const sl of slices) for (const poly of sl) for (const [x, y] of poly) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  x0 -= 3; y0 -= 3; x1 += 3; y1 += 3;
  const G = 1, nx = Math.ceil((x1 - x0) / G) + 1, ny = Math.ceil((y1 - y0) / G) + 1;
  const cell = fade + 2, buckets = new Map<number, number[]>();
  samples.forEach((s, i) => { const k = Math.floor(s.x / cell) * 100003 + Math.floor(s.y / cell); let l = buckets.get(k); if (!l) buckets.set(k, (l = [])); l.push(i); });
  const zBot = h + kLo * DZ - 1;
  const Z = new Float64Array(nx * ny);
  for (let iy = 0; iy < ny; iy++) for (let ix = 0; ix < nx; ix++) {
    const x = x0 + ix * G, y = y0 + iy * G;
    let ws = 0, acc = 0, dmin = Infinity;
    const cx = Math.floor(x / cell), cy = Math.floor(y / cell);
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (const i of buckets.get((cx + a) * 100003 + cy + b) ?? []) {
      const d = Math.hypot(samples[i].x - x, samples[i].y - y);
      dmin = Math.min(dmin, d);
      const wt = 1 / Math.pow(d + 1e-3, 4);
      ws += wt; acc += wt * samples[i].dz;
    }
    // Outside both the section and the re-routed seam outline (other limbs, a cape hem hanging in the slab) the cutter
    // stays on the plane, so it never slices geometry the planar cut would not have touched.
    const outside = dmin > 1 && !inPolys([x, y], base) && !inPolys([x, y], seamLoops);
    const s = outside ? 0 : dmin <= 1.5 ? 1 : Math.max(0, 1 - (dmin - 1.5) / fade);
    Z[iy * nx + ix] = h + (ws ? acc / ws : 0) * s;
  }
  // closed prism: top = height field, bottom = z = zBot, side walls; then everything below zBot (huge box) joins it
  const vert: number[] = [], tri: number[] = [];
  for (let iy = 0; iy < ny; iy++) for (let ix = 0; ix < nx; ix++) vert.push(x0 + ix * G, y0 + iy * G, Z[iy * nx + ix]);
  const B = nx * ny;
  for (let iy = 0; iy < ny; iy++) for (let ix = 0; ix < nx; ix++) vert.push(x0 + ix * G, y0 + iy * G, zBot);
  const id = (ix: number, iy: number, bot = 0) => iy * nx + ix + bot * B;
  for (let iy = 0; iy + 1 < ny; iy++) for (let ix = 0; ix + 1 < nx; ix++) {
    const a = id(ix, iy), b = id(ix + 1, iy), c = id(ix + 1, iy + 1), d = id(ix, iy + 1);
    tri.push(a, b, c, a, c, d); // top, facing +Z
    tri.push(a + B, c + B, b + B, a + B, d + B, c + B); // bottom, facing -Z
  }
  const ring: [number, number][] = [];
  for (let ix = 0; ix < nx - 1; ix++) ring.push([ix, 0]);
  for (let iy = 0; iy < ny - 1; iy++) ring.push([nx - 1, iy]);
  for (let ix = nx - 1; ix > 0; ix--) ring.push([ix, ny - 1]);
  for (let iy = ny - 1; iy > 0; iy--) ring.push([0, iy]);
  for (let i = 0; i < ring.length; i++) {
    const [ax, ay] = ring[i], [bx, by] = ring[(i + 1) % ring.length];
    const a = id(ax, ay), b = id(bx, by);
    tri.push(a, a + B, b + B, a, b + B, b); // outward walls (ring runs CCW seen from +Z)
  }
  let prism = new w.Manifold(new w.Mesh({ numProp: 3, vertProperties: new Float32Array(vert), triVerts: new Uint32Array(tri) }));
  if (prism.status() !== 'NoError' || prism.volume() <= 0) return null;
  const big = Math.max(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]) * 4 + 100;
  const below = w.Manifold.cube([big, big, big], true).translate([(x0 + x1) / 2, (y0 + y1) / 2, zBot + 0.5 - big / 2]);
  prism = w.Manifold.union(prism, below);
  const heightAt = (x: number, y: number) => {
    const fx = Math.max(0, Math.min(nx - 1.001, (x - x0) / G)), fy = Math.max(0, Math.min(ny - 1.001, (y - y0) / G));
    const ix = Math.floor(fx), iy = Math.floor(fy), tx = fx - ix, ty = fy - iy;
    const z = (a: number, b: number) => Z[(iy + b) * nx + ix + a];
    return (z(0, 0) * (1 - tx) + z(1, 0) * tx) * (1 - ty) + (z(0, 1) * (1 - tx) + z(1, 1) * tx) * ty;
  };
  return { cutter: prism, heightAt, gain, maxDz, samples: samples.length };
}
