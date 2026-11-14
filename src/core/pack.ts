// Plate packing on the real projected footprint (1 mm raster of the part's exact XY shadow outline, grown by the gap),
// not bounding boxes. Only yaw (rotation about Z) is explored: it never changes the chosen print orientation.
// First-fit decreasing over plates, bottom-left position search with prefix sums. Exact overlap is re-checked later
// with mesh booleans, so the raster only has to be conservative.
export const BED = 180;
const MARGIN = 1; // mm along the bed edges, on top of each part's own brim/skirt room (Bambu Studio rejects G-code outside the bed)
const CELL = 1;     // mm per raster cell
const N = Math.floor((BED - 2 * MARGIN) / CELL);

export interface PackItem { id: number; polys: number[][][]; brim: boolean; room?: number } // polys: XY shadow outline of the oriented part (rings)
export interface Placement { brim: boolean; id: number; plate: number; yaw: number; x: number; y: number } // world = T(x,y) · Rz(yaw) · oriented

/** q = cells that must be on free bed (part + brim); m = cells marked occupied after placing (q grown by the gap). */
interface Foot { brim: boolean; yaw: number; w: number; h: number; q: [number, number][][]; m: [number, number][][]; qb: number[]; ox: number; oy: number; area: number }

const spans = (cells: Uint8Array, w: number, h: number) => {
  const rows: [number, number][][] = [];
  for (let y = 0; y < h; y++) { const sp: [number, number][] = []; for (let x = 0; x < w; x++) if (cells[y * w + x]) { const s0 = x; while (x < w && cells[y * w + x]) x++; sp.push([s0, x - 1]); } rows.push(sp); }
  return rows;
};
function dilate(base: Uint8Array, w: number, h: number, r: number): Uint8Array {
  if (r <= 0) return base.slice();
  const out = new Uint8Array(w * h);
  const disk: [number, number][] = [];
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (dx * dx + dy * dy <= r * r + 0.5) disk.push([dx, dy]);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (base[y * w + x]) for (const [dx, dy] of disk) { const u = x + dx, v = y + dy; if (u >= 0 && v >= 0 && u < w && v < h) out[v * w + u] = 1; }
  return out;
}

/** Raster of the shadow outline after yaw, padded by rq + rg cells. ox/oy: model coords of cell (0,0) corner. */
function footprint(polys: number[][][], yaw: number, rq: number, rg: number, brim: boolean): Foot {
  const r = rq + rg;
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const R = polys.map((ring) => ring.map(([x, y]) => [c * x - s * y, s * x + c * y]));
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const ring of R) for (const [x, y] of ring) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  const ox = x0 - r * CELL, oy = y0 - r * CELL;
  const w = Math.ceil((x1 - ox) / CELL) + r + 1, h = Math.ceil((y1 - oy) / CELL) + r + 1;
  const base = new Uint8Array(w * h);
  // conservative scanline fill (even-odd): a cell is set if the outline covers it at its bottom, middle or top edge,
  // and every cell an outline edge passes through is set too
  for (let py = 0; py < h; py++) for (const fy of [0.02, 0.5, 0.98]) {
    const yy = oy + (py + fy) * CELL;
    const xs: number[] = [];
    for (const ring of R) for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [ax, ay] = ring[j], [bx, by] = ring[i];
      if ((ay > yy) !== (by > yy)) xs.push(ax + ((yy - ay) * (bx - ax)) / (by - ay));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const a = Math.max(0, Math.floor((xs[k] - ox) / CELL)), b = Math.min(w - 1, Math.floor((xs[k + 1] - ox) / CELL));
      for (let x = a; x <= b; x++) base[py * w + x] = 1;
    }
  }
  for (const ring of R) for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, ay] = ring[j], [bx, by] = ring[i];
    const n = Math.ceil(Math.hypot(bx - ax, by - ay) / (CELL * 0.5)) + 1;
    for (let k = 0; k <= n; k++) { const x = Math.floor((ax + ((bx - ax) * k) / n - ox) / CELL), y = Math.floor((ay + ((by - ay) * k) / n - oy) / CELL); if (x >= 0 && y >= 0 && x < w && y < h) base[y * w + x] = 1; }
  }
  const q = dilate(base, w, h, rq), m = dilate(q, w, h, rg);
  let qx0 = w, qx1 = -1, qy0 = h, qy1 = -1, area = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (q[y * w + x]) { area++; qx0 = Math.min(qx0, x); qx1 = Math.max(qx1, x); qy0 = Math.min(qy0, y); qy1 = Math.max(qy1, y); }
  return { brim, yaw, w, h, q: spans(q, w, h), m: spans(m, w, h), qb: [qx0, qx1, qy0, qy1], ox, oy, area };
}

class Plate {
  occ = new Uint8Array(N * N);
  pre = new Int32Array(N * (N + 1)); // per-row prefix sums
  /** (px, py) = plate cell of footprint cell (0,0); only the part+brim cells (q) must be on the bed and free. */
  fits(f: Foot, px: number, py: number): boolean {
    const [x0, x1, y0, y1] = f.qb;
    if (px + x0 < 0 || py + y0 < 0 || px + x1 >= N || py + y1 >= N) return false;
    for (let y = y0; y <= y1; y++) {
      const base = (py + y) * (N + 1);
      for (const [a, b] of f.q[y]) if (this.pre[base + px + b + 1] - this.pre[base + px + a] > 0) return false;
    }
    return true;
  }
  put(f: Foot, px: number, py: number) {
    for (let y = 0; y < f.h; y++) { const yy = py + y; if (yy < 0 || yy >= N) continue; for (const [a, b] of f.m[y]) for (let x = Math.max(0, px + a); x <= Math.min(N - 1, px + b); x++) this.occ[yy * N + x] = 1; }
    for (let y = Math.max(0, py); y < Math.min(N, py + f.h); y++) { const base = y * (N + 1); for (let x = 0; x < N; x++) this.pre[base + x + 1] = this.pre[base + x] + this.occ[y * N + x]; }
  }
}

/** gap: clear distance between neighbours' 5 mm brim/support zones (mm). */
export function pack(items: PackItem[], gap = 4, yawStepDeg = 15): { placements: Placement[]; plates: number; unplaced: number[] } {
  const prepared = items.map((it) => {
    // part room: 5 mm for its brim and for tree-support bases, which spread ~4 mm past the outline (measured in Bambu
    // Studio G-code) — must stay on the bed
    const rq = Math.ceil((it.room ?? 5) / CELL), rg = Math.ceil(gap / CELL);
    const feet: Foot[] = [];
    for (let d = 0; d < 360; d += yawStepDeg) feet.push(footprint(it.polys, (d * Math.PI) / 180, rq, rg, it.brim));
    // a part that only fits without its brim gets no brim room rather than no plate
    // a part too big for that room keeps 1 mm and is exported without a brim (supports may still need hand checking)
    if (!feet.some((f) => f.qb[1] - f.qb[0] < N && f.qb[3] - f.qb[2] < N)) for (let d = 0; d < 360; d += yawStepDeg) feet.push(footprint(it.polys, (d * Math.PI) / 180, Math.ceil(1 / CELL), rg, false));
    return { it, feet, area: Math.min(...feet.map((f) => f.area)) };
  }).sort((a, b) => b.area - a.area);
  const plates: Plate[] = [];
  const placements: Placement[] = [];
  const unplaced: number[] = [];
  for (const { it, feet } of prepared) {
    let done = false;
    for (let pi = 0; pi <= plates.length && !done; pi++) {
      if (pi === plates.length) plates.push(new Plate());
      const pl = plates[pi];
      // bottom-left: minimise y extent first, then x; all yaws compete
      let best: { f: Foot; x: number; y: number; key: number } | null = null;
      for (const f of feet) {
        const [x0, x1, y0, y1] = f.qb;
        if (x1 - x0 >= N || y1 - y0 >= N) continue;
        for (let y = -y0; y + y1 < N; y += 2) {
          if (best && y + y1 > best.key / 1e4) break;
          for (let x = -x0; x + x1 < N; x += 2) {
            if (!pl.fits(f, x, y)) continue;
            const key = (y + y1) * 1e4 + x + x1;
            if (!best || key < best.key) best = { f, x, y, key };
            break;
          }
        }
      }
      if (best) {
        pl.put(best.f, best.x, best.y);
        placements.push({ brim: best.f.brim, id: it.id, plate: pi, yaw: best.f.yaw, x: MARGIN + best.x * CELL - best.f.ox, y: MARGIN + best.y * CELL - best.f.oy });
        done = true;
      } else if (pi === plates.length - 1 && plates[pi].occ.every((v) => !v)) { plates.pop(); break; } // does not fit even an empty plate
    }
    if (!done) unplaced.push(it.id);
  }
  return { placements, plates: plates.length, unplaced };
}
