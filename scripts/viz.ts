// Headless renders for inspection and the report: flat-shaded orthographic images written as PNG (node only).
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { render, type Tris } from '../src/core/raster';
import { triGeom } from '../src/core/analysis';

export interface Obj { t: Tris; color: (tri: number) => number[]; offset?: number[] }

function png(w: number, h: number, rgb: Uint8Array): Buffer {
  const crcT = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
  const crc = (b: Buffer) => { let c = -1; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
  const chunk = (type: string, data: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; Buffer.from(rgb.buffer, rgb.byteOffset + y * w * 3, w * 3).copy(raw, y * (w * 3 + 1) + 1); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** Merge objects (with offsets) into one mesh and render looking along d. Light from the camera-upper-left. */
export function shot(file: string, objs: Obj[], d: number[], size = 640) {
  let nv = 0, ni = 0;
  for (const o of objs) { nv += o.t.pos.length; ni += o.t.idx.length; }
  const pos = new Float32Array(nv), idx = new Uint32Array(ni), owner: [Obj, number][] = [];
  let pv = 0, pi = 0;
  for (const o of objs) {
    const off = o.offset ?? [0, 0, 0];
    for (let i = 0; i < o.t.pos.length; i++) pos[pv + i] = o.t.pos[i] + off[i % 3];
    for (let i = 0; i < o.t.idx.length; i++) idx[pi + i] = o.t.idx[i] + pv / 3;
    for (let k = 0; k < o.t.idx.length / 3; k++) owner.push([o, k]);
    pv += o.t.pos.length; pi += o.t.idx.length;
  }
  const t = { pos, idx };
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i++) { lo[i % 3] = Math.min(lo[i % 3], pos[i]); hi[i % 3] = Math.max(hi[i % 3], pos[i]); }
  const c = lo.map((x, k) => (x + hi[k]) / 2), r = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2 * 1.05;
  const v = render(t, d, size, c, r);
  const g = triGeom(t);
  const L = [-d[0] + v.u[0] * -0.4 + v.v[0] * 0.6, -d[1] + v.u[1] * -0.4 + v.v[1] * 0.6, -d[2] + v.u[2] * -0.4 + v.v[2] * 0.6];
  const ll = Math.hypot(...L);
  const rgb = new Uint8Array(size * size * 3);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const k = (size - 1 - y) * size + x, tri = v.id[y * size + x], o = k * 3;
    if (tri < 0) { rgb[o] = 24; rgb[o + 1] = 26; rgb[o + 2] = 31; continue; }
    const [obj, local] = owner[tri];
    const col = obj.color(local);
    const sh = 0.35 + 0.65 * Math.max(0, (g.nrm[tri * 3] * L[0] + g.nrm[tri * 3 + 1] * L[1] + g.nrm[tri * 3 + 2] * L[2]) / ll);
    for (let ch = 0; ch < 3; ch++) rgb[o + ch] = Math.min(255, col[ch] * sh);
  }
  writeFileSync(file, png(size, size, rgb));
}

export const heat = (x: number) => { x = Math.max(0, Math.min(1, x)); return [255 * Math.min(1, x * 2), 255 * Math.min(1, 2 - x * 2) * (0.4 + 0.6 * x), 255 * (1 - x) * 0.6]; };
export const ISO = (() => { const d = [-0.55, 0.75, -0.45]; const l = Math.hypot(...d); return d.map((x) => x / l); })(); // from front-left-above (front = -Y)
