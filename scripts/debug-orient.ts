// Debug: orientation table + top split candidates for a model. usage: tsx scripts/debug-orient.ts model.glb height
import { readFileSync } from 'node:fs';
import { importModel } from '../src/core/importers';
import { loadManifold, toManifold } from '../src/core/geom';
import { analyzeSurface } from '../src/core/analysis';
import { makePart, applyCut, scoreState, rejectWhy } from '../src/core/search';
import { bestOrient } from '../src/core/orient';
import { candidatePlanes } from '../src/core/cuts';

const [file, h] = process.argv.slice(2);
const w = await loadManifold();
const b = readFileSync(file);
const s = await importModel(file, b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
let { solid } = toManifold(w, s.pos);
const bb = solid!.boundingBox();
solid = solid!.scale(+h / (bb.max[2] - bb.min[2]));
const f = analyzeSurface(solid);
const proxy = solid.numTri() > 12000 ? solid.simplify(0.4) : solid;
console.log('proxy tris', proxy.numTri(), 'fits', null);
const root = makePart(proxy, f, []);
const { all } = bestOrient(root.pm!, root.hull, []);
const fmt = (o: typeof all[0]) => `down ${o.down.map((v) => v.toFixed(2)).join(',')} fits ${o.fits} cost ${o.cost.toFixed(0)} supA ${o.supportArea.toFixed(0)} supVis ${o.supportVisible.toFixed(0)} vol ${o.supportVolume.toFixed(0)} stair ${o.stair.toFixed(0)} sag ${o.sag.toFixed(0)} contact ${o.contact.toFixed(0)} tip ${o.tip.toFixed(1)} h ${o.height.toFixed(0)}`;
for (const o of [...all].sort((a, b) => a.cost - b.cost).slice(0, 8)) console.log(fmt(o));
const st = scoreState([root], []);
console.log('root', st.cost.toFixed(0), JSON.stringify(st.terms));
for (const c of candidatePlanes(root.pm!, 8, !root.o.fits)) {
  const ns = applyCut(st, root, c, f);
  console.log(`plane n=${c.n.map((v) => v.toFixed(2))} h=${c.h.toFixed(1)} seam ${c.seam.toFixed(0)} perim ${c.perim.toFixed(0)} neck ${c.neck.toFixed(2)} bal ${c.balance.toFixed(2)} ->`, ns ? `${ns.cost.toFixed(0)} ${JSON.stringify(Object.fromEntries(Object.entries(ns.terms).map(([k, v]) => [k, Math.round(v)])))} parts ${ns.parts.map((p) => fmt(p.o)).join(' | ')}` : `rejected: ${rejectWhy}`);
}
