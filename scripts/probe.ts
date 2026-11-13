import { readFileSync } from 'node:fs';
import { importModel } from '../src/core/importers';
import { loadManifold, toManifold } from '../src/core/geom';
const wasm = await loadManifold();
for (const f of process.argv.slice(2)) {
  const b = readFileSync(f); const s = await importModel(f, b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  const r = toManifold(wasm, s.pos);
  console.log(f, s.pos.length / 9, 'tris', JSON.stringify(r.report));
}
