// Debug: render the surface field (visibility, detail, concavity) of a model. usage: tsx scripts/field.ts model.glb height outdir
import { readFileSync, mkdirSync } from 'node:fs';
import { basename } from 'node:path';
import { importModel } from '../src/core/importers';
import { loadManifold, toManifold } from '../src/core/geom';
import { analyzeSurface, meshOf } from '../src/core/analysis';
import { shot, heat, ISO } from './viz';

const [file, h, out] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const w = await loadManifold();
const b = readFileSync(file);
const s = await importModel(file, b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
let { solid } = toManifold(w, s.pos);
const bb = solid!.boundingBox();
solid = solid!.scale(+h / (bb.max[2] - bb.min[2]));
const t0 = Date.now();
const f = analyzeSurface(solid);
console.log('analysis ms', Date.now() - t0, 'tris', f.n);
const src = solid.numTri() > 60000 ? solid.simplify(0.15) : solid;
const t = meshOf(src);
const name = basename(file, '.glb');
for (const [k, arr, fn] of [['V', f.V, (x: number) => x], ['D', f.D, (x: number) => x], ['C', f.C, (x: number) => (x + 1) / 2]] as const) {
  shot(`${out}/${name}_${k}_front.png`, [{ t, color: (i) => heat(fn(arr[i])) }], ISO, 480);
  shot(`${out}/${name}_${k}_back.png`, [{ t, color: (i) => heat(fn(arr[i])) }], [-ISO[0], -ISO[1], ISO[2]], 480);
}
const pct = (a: Float32Array) => { const s = [...a].sort((x, y) => x - y); return [0.05, 0.25, 0.5, 0.75, 0.95].map((q) => s[Math.floor(q * (s.length - 1))].toFixed(2)).join(' '); };
console.log(name, 'V pct', pct(f.V), 'D pct', pct(f.D), 'C pct', pct(f.C));
