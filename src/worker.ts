// All heavy work runs here; the page stays responsive. Cancel = terminate this worker.
import wasmUrl from 'manifold-3d/manifold.wasm?url';
import { zipSync } from 'fflate';
import { importModel } from './core/importers';
import { loadManifold, toManifold, meshToSoup } from './core/geom';
import { prepare } from './core/prepare';
import { exportAll } from './core/exporters';

const post = (m: unknown, t: Transferable[] = []) => (self as unknown as Worker).postMessage(m, t);

self.onmessage = async (e: MessageEvent) => {
  const { type, name, buf, height } = e.data;
  try {
    post({ type: 'progress', stage: 'Loading geometry kernel', frac: 0.01 });
    const w = await loadManifold(wasmUrl);
    post({ type: 'progress', stage: 'Importing', frac: 0.03 });
    const soup = await importModel(name, buf);
    if (!soup.pos.length) throw new Error('No triangles found in file');
    post({ type: 'progress', stage: 'Checking watertightness', frac: 0.06 });
    const { solid, report } = toManifold(w, soup.pos);
    report.notes.push(...soup.warnings);
    if (type === 'import') { post({ type: 'imported', soup: soup.pos, report }, [soup.pos.buffer]); return; }
    if (!solid) throw new Error('Mesh has no closed (watertight) component; cannot cut it safely. See import diagnostics.');
    const bb = solid.boundingBox();
    const scale = height / (bb.max[2] - bb.min[2]);
    const r = prepare(w, solid, scale, 12, (stage, frac) => post({ type: 'progress', stage, frac: 0.08 + frac * 0.85 }));
    post({ type: 'progress', stage: 'Exporting STL / 3MF', frac: 0.95 });
    const files = exportAll(r);
    const zip = zipSync({ ...files, 'README.txt': new TextEncoder().encode(readme(r)) });
    const parts = r.parts.map((p) => ({
      id: p.id, name: p.name, role: p.role, plate: p.plate, volume: p.volume, height: p.height, supportArea: p.supportArea, bedContact: p.bedContact,
      cutFaces: p.cutFaces, supportVisible: p.metrics?.supportVisible ?? 0, supportTris: p.supportTris,
      assembled: meshToSoup(p.solid), placed: meshToSoup(p.placed!),
    }));
    post({
      type: 'result', report, parts, zip, files: Object.keys(files),
      meta: { scale: r.scale, decision: r.decision, checks: r.checks, warnings: r.warnings, cuts: r.cuts, plates: r.plates, assemblyOrder: r.assemblyOrder, summary: r.summary },
    }, [zip.buffer, ...parts.flatMap((p) => [p.assembled.buffer, p.placed.buffer])]);
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};

function readme(r: ReturnType<typeof prepare>): string {
  return [
    'Auto Splitter output — Bambu Lab A1 Mini (180×180×180 mm, 0.4 mm nozzle)', '',
    r.decision, '',
    'Files: project.3mf (Bambu Studio project: every part on its plate, A1 Mini selected), plate_N.3mf (generic 3MF per plate), part_*.stl / pin_*.stl (oriented, plate coordinates).', '',
    'Estimates (geometric, from the mesh; slice in Bambu Studio for real support/time):', ...Object.entries(r.summary).map(([k, v]) => `  ${k}: ${v}`), '',
    'Checks:', ...Object.entries(r.checks).map(([k, v]) => `  ${k}: ${v}`), '',
    'Assembly (each step joins two rigid groups across one flat seam; seat that cut\'s dowels in the second group first):',
    ...r.assemblyOrder.map((a, i) => `  ${i + 1}. cut ${a.cut}: dowels ${a.pins.map((id) => r.parts[id - 1].name).join(', ') || 'none'} into ${a.b.map((id) => r.parts[id - 1].name).join(' + ')}; slide ${a.a.map((id) => r.parts[id - 1].name).join(' + ')} on along (${a.dir.map((v) => v.toFixed(2)).join(', ')})${a.ok ? '' : ' (COLLIDES in sweep check)'}`),
    '', 'Warnings:', ...r.warnings.map((w) => `  - ${w}`),
  ].join('\n');
}
