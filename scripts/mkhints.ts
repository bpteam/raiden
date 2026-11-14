// Test stand-in for a user's brush: sample surface points of a model in a box region (model coordinates) as one part group.
// usage: tsx scripts/mkhints.ts model.glb out.json part|nocut "x0,y0,z0,x1,y1,z1" (fractions of the bbox) [more groups…]
import { readFileSync, writeFileSync } from 'node:fs';
import { importModel } from '../src/core/importers';
const [file, out, ...specs] = process.argv.slice(2);
const b = readFileSync(file);
const { pos } = await importModel(file, b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], pos[i + k]); hi[k] = Math.max(hi[k], pos[i + k]); }
const hints = { parts: [] as number[][][], seams: [] as number[][][], noCut: [] as number[][] };
for (let s = 0; s < specs.length; s += 2) {
  const f = specs[s + 1].split(',').map(Number);
  const pts: number[][] = [];
  for (let i = 0; i < pos.length; i += 3) if ([0, 1, 2].every((k) => pos[i + k] >= lo[k] + f[k] * (hi[k] - lo[k]) && pos[i + k] <= lo[k] + f[k + 3] * (hi[k] - lo[k]))) pts.push([pos[i], pos[i + 1], pos[i + 2]]);
  const pick = pts.filter((_, i) => i % Math.max(1, Math.floor(pts.length / 40)) === 0).slice(0, 40);
  if (specs[s] === 'part') hints.parts.push(pick); else if (specs[s] === 'nocut') hints.noCut.push(...pick); else hints.seams.push(pick);
  console.log(specs[s], pick.length, 'points');
}
writeFileSync(out, JSON.stringify(hints));
console.log('bbox', lo.map((v) => v.toFixed(3)).join(','), hi.map((v) => v.toFixed(3)).join(','));
