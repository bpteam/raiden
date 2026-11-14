// Print orientation scored by what matters for a figurine: support scars on visible/detailed surfaces, stair-stepping on
// visible gentle slopes, sagging down-skins, tipping risk, height. Yaw (rotation about Z) does not change any of these,
// so it is left to the plate packer; here it is only used to check that the part fits the bed.
// All numbers are GEOMETRIC ESTIMATES from the mesh, not slicer output.
import type { PartMesh } from './analysis';

export const USABLE = 170; // A1 Mini 180 mm minus the 5 mm per side the packer keeps free for supports/brims
const OVERHANG = Math.cos(Math.PI / 4); // faces steeper than 45° past vertical need support (slicer default region)

export interface OrientEval {
  down: number[];          // model-frame direction that points to the bed
  fits: boolean; yaw: number; foot: number[]; height: number;
  supportArea: number;     // mm², downward faces needing support
  supportVisible: number;  // mm², importance-weighted support contact on surfaces seen after assembly
  supportVolume: number;   // mm³, column volume under overhangs down to the bed (upper bound; no model-on-model support)
  stair: number;           // mm², importance-weighted visible area with layer stair-stepping
  sag: number;             // mm², importance-weighted steep-but-unsupported down-skins (droop, rough)
  contact: number; tip: number; cost: number;
}

/** Visual weight of one surface triangle: hidden interfaces (caps, holes) cost nothing. */
const imp = (pm: PartMesh, i: number, detailGain: number) => (pm.iface[i] ? 0 : pm.V[i] * (1 + detailGain * pm.D[i]));

export const W = { supportVisible: 1, supportHidden: 0.08, supportVolume: 0.0015, stair: 0.12, sag: 0.25, tip: 40, height: 0.3 };

export function evalDown(pm: PartMesh, down: number[], hull: Float32Array, stride = 1): OrientEval {
  // z' = -(p·down): height above the bed after rotating `down` to -Z.
  let zmin = Infinity, zmax = -Infinity;
  const P = pm.pos;
  for (let i = 0; i < P.length; i += 3) { const z = -(P[i] * down[0] + P[i + 1] * down[1] + P[i + 2] * down[2]); zmin = Math.min(zmin, z); zmax = Math.max(zmax, z); }
  let supportArea = 0, supportVisible = 0, supportVolume = 0, stair = 0, sag = 0, contact = 0, hidden = 0;
  for (let i = 0; i < pm.nt; i += stride) {
    const a = pm.area[i] * stride; // stride > 1: unbiased subsample for the coarse pass
    const nz = -(pm.nrm[i * 3] * down[0] + pm.nrm[i * 3 + 1] * down[1] + pm.nrm[i * 3 + 2] * down[2]);
    const zc = -(pm.cx[i * 3] * down[0] + pm.cx[i * 3 + 1] * down[1] + pm.cx[i * 3 + 2] * down[2]) - zmin;
    if (nz < -0.985 && zc < 0.3) { contact += a; continue; }
    if (nz < -OVERHANG) {
      supportArea += a;
      const w = imp(pm, i, 1);
      supportVisible += a * w;
      if (!w) hidden += a;
      supportVolume += a * -nz * zc;
    } else if (nz < -0.34) sag += a * imp(pm, i, 0.5) * (-nz - 0.34); // 20–45° down-skin: printable, but droops/roughens
    const anz = Math.abs(nz);
    if (anz > 0.2 && anz < 0.985) stair += a * imp(pm, i, -0.5) * anz; // cusp height ∝ |nz|; strongest on smooth surfaces
  }
  const height = zmax - zmin;
  const { fits, yaw, foot } = fitYaw(hull, down, height);
  // Tipping: tall part on a small footprint. A brim helps, so this is a soft risk, not a hard rule.
  // no flat contact at all = the part stands on support towers only: real print-failure risk, not just a cosmetic cost
  const tip = contact < 4 ? 35 : Math.max(0, height / Math.sqrt(contact) - 6);
  const cost = W.supportVisible * supportVisible + W.supportHidden * supportArea + W.supportVolume * supportVolume
    + W.stair * stair + W.sag * sag + W.tip * tip + W.height * height + (fits ? 0 : 1e7);
  return { down, fits, yaw, foot, height, supportArea, supportVisible, supportVolume, stair, sag, contact, tip, cost };
}

/** Bed fit: yaw sweep (5°) of the convex hull with `down` mapped to -Z; smallest footprint that fits. */
export function fitYaw(hull: Float32Array, down: number[], height: number): { fits: boolean; yaw: number; foot: number[] } {
  const [u, v] = perp(down);
  let fits = false, yaw = 0, foot = [Infinity, Infinity], bestA = Infinity;
  if (height <= USABLE) for (let deg = 0; deg < 180; deg += 5) {
    const c = Math.cos((deg * Math.PI) / 180), s = Math.sin((deg * Math.PI) / 180);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < hull.length; i += 3) {
      const pu = hull[i] * u[0] + hull[i + 1] * u[1] + hull[i + 2] * u[2], pv = hull[i] * v[0] + hull[i + 1] * v[1] + hull[i + 2] * v[2];
      const x = c * pu - s * pv, y = s * pu + c * pv;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    const ex = x1 - x0, ey = y1 - y0;
    if (ex <= USABLE && ey <= USABLE && ex * ey < bestA) { bestA = ex * ey; fits = true; yaw = deg; foot = [ex, ey]; }
  }
  return { fits, yaw, foot };
}

/** Orthonormal u, v with u × v = -down (right-handed after mapping down to -Z). */
export function perp(d: number[]): [number[], number[]] {
  const a = Math.abs(d[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  let u = [a[1] * d[2] - a[2] * d[1], a[2] * d[0] - a[0] * d[2], a[0] * d[1] - a[1] * d[0]];
  const l = Math.hypot(u[0], u[1], u[2]); u = u.map((x) => x / l);
  // v = (-d) × u, so (u, v, -d) is right-handed
  const z = [-d[0], -d[1], -d[2]];
  const v = [z[1] * u[2] - z[2] * u[1], z[2] * u[0] - z[0] * u[2], z[0] * u[1] - z[1] * u[0]];
  return [u, v];
}

const CAND: number[][] = (() => {
  const out: number[][] = [];
  for (const x of [-1, 0, 1]) for (const y of [-1, 0, 1]) for (const z of [-1, 0, 1]) if (x || y || z) { const l = Math.hypot(x, y, z); out.push([x / l, y / l, z / l]); }
  // finer ring around "upright" (down = -Z): small tilts often trade a little stair-stepping for a lot less support
  for (const t of [15, 30]) for (let a = 0; a < 8; a++) { const r = (t * Math.PI) / 180, az = (a * Math.PI) / 4; out.push([Math.sin(r) * Math.cos(az), Math.sin(r) * Math.sin(az), -Math.cos(r)]); }
  return out;
})();

/** Best orientation over 26 axis/diagonal directions, a ring of small tilts from upright, and every cut face pointing down. */
export function bestOrient(pm: PartMesh, hull: Float32Array, cutNormals: number[][]): { best: OrientEval; all: OrientEval[] } {
  // coarse-to-fine: score every direction on a ~3000-triangle subsample, then the 6 best (+ seam faces) exactly
  const stride = Math.max(1, Math.floor(pm.nt / 3000));
  let all = [...cutNormals, ...CAND].map((d) => evalDown(pm, d, hull, stride));
  let exact = all;
  if (stride > 1) {
    const keep = new Set([...[...all].sort((a, b) => a.cost - b.cost).slice(0, 6).map((o) => o.down), ...cutNormals]);
    all = all.map((o) => (keep.has(o.down) ? evalDown(pm, o.down, hull) : o));
    exact = all.filter((o) => keep.has(o.down));
  }
  const best = exact.reduce((a, b) => (b.cost < a.cost ? b : a));
  return { best, all };
}
