// Node E2E: import real model -> prepare -> export STL/3MF -> re-import exports and verify.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename } from 'node:path';
import { importModel } from '../src/core/importers';
import { loadManifold, toManifold } from '../src/core/geom';
import { prepare } from '../src/core/prepare';
import { exportAll } from '../src/core/exporters';

const [file, heightArg] = process.argv.slice(2);
const w = await loadManifold();
const b = readFileSync(file);
const soup = await importModel(file, b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
const { solid, report } = toManifold(w, soup.pos);
console.log('import', JSON.stringify(report));
if (!solid) { console.log('RESULT: not printable (no solid), diagnosed'); process.exit(0); }
const bb = solid!.boundingBox();
const scale = +(heightArg ?? 150) / (bb.max[2] - bb.min[2]);
const t0 = Date.now();
const r = prepare(w, solid!, scale, 12, (s, f) => process.stdout.write(`\r${(f * 100).toFixed(0)}% ${s}            `));
console.log(`\nprepare ${Date.now() - t0} ms\n${r.decision}`);
console.log(r.checks, r.warnings, r.assemblyOrder);
for (const p of r.parts) console.log(p.name, p.role, 'plate', p.plate + 1, 'h', p.height.toFixed(1), 'support mm²', p.supportArea.toFixed(0), 'contact', p.bedContact.toFixed(0));
const out = `${process.env.OUT ?? 'out'}/${basename(file)}`;
mkdirSync(out, { recursive: true });
const files = exportAll(r);
for (const [name, data] of Object.entries(files)) writeFileSync(`${out}/${name}`, data);
// Re-import every export and verify it is a closed solid with the same volume.
let fail = 0;
for (const [name, data] of Object.entries(files)) {
  const s = await importModel(name, data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer);
  const re = toManifold(w, s.pos);
  const expect = name.endsWith('.stl') ? r.parts.find((p) => `${p.name}.stl` === name)!.volume : r.parts.filter((p) => `plate_${p.plate + 1}.3mf` === name).reduce((a, p) => a + p.volume, 0);
  const ok = re.report.ok && Math.abs(re.report.volume - expect) / expect < 1e-3;
  if (!ok) fail++;
  console.log('reimport', name, ok ? 'OK' : 'FAIL', re.report.volume.toFixed(1), expect.toFixed(1));
}
console.log(fail ? `RESULT: FAIL (${fail})` : 'RESULT: PASS');
process.exit(fail ? 1 : 0);
