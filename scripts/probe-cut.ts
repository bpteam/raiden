// Debug: split a model (scaled to height) by one plane and list pieces with volume and gap to the other side.
import { readFileSync } from 'node:fs';
import { importModel } from '../src/core/importers';
import { loadManifold, toManifold } from '../src/core/geom';
import { mergeStrays } from '../src/core/search';
const [file, H, nx, ny, nz, h] = process.argv.slice(2);
const w = await loadManifold(); const b = readFileSync(file);
const soup = await importModel(file, b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
let s = toManifold(w, soup.pos).solid!; const bb = s.boundingBox(); s = s.scale(+H / (bb.max[2] - bb.min[2]));
const b0 = s.boundingBox(); s = s.translate([-(b0.min[0] + b0.max[0]) / 2, -(b0.min[1] + b0.max[1]) / 2, -b0.min[2]]);
const [a, d] = s.splitByPlane([+nx, +ny, +nz], +h);
const pieces = [...a.decompose().map((m) => ({ m, side: 1 })), ...d.decompose().map((m) => ({ m, side: -1 }))];
for (const p of pieces) console.log(p.side, p.m.volume().toFixed(1), 'gap to other side', Math.min(...pieces.filter((q) => q.side !== p.side).map((q) => q.m.minGap(p.m, 1))).toFixed(4));
console.log('after merge', mergeStrays(pieces).pieces.map((p) => `${p.side}:${p.m.volume().toFixed(0)}`).join(' '));
