// Export validation with the real target slicer (Bambu Studio CLI, flatpak com.bambulab.BambuStudio).
// Opens our project 3MF, slices every plate with supports ON (tree auto, A1 Mini 0.4, 0.20 mm Standard, PLA Basic) and
// compares the slicer's per-plate object boxes with our placement. Reports REAL slicer support/time numbers.
// usage: tsx scripts/bbs.ts <project.3mf> <summary.json> [--no-settings]
// Dev tool only (node + local Bambu Studio); the app itself never needs it.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, copyFileSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { plateOrigin } from '../src/core/exporters';

const [proj, summaryPath, flag] = process.argv.slice(2);
const work = resolve(dirname(proj), `bbs_${basename(proj, '.3mf')}`);
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
const loc = execFileSync('flatpak', ['info', '--show-location', 'com.bambulab.BambuStudio']).toString().trim();
const prof = `${loc}/files/share/BambuStudio/profiles/BBL`;
copyFileSync(`${prof}/machine/Bambu Lab A1 mini 0.4 nozzle.json`, `${work}/machine.json`);
const proc = JSON.parse(readFileSync(`${prof}/process/0.20mm Standard @BBL A1M.json`, 'utf8'));
Object.assign(proc, { enable_support: '1', support_type: 'tree(auto)', name: 'raiden validate (supports on)', from: 'User' });
writeFileSync(`${work}/process.json`, JSON.stringify(proc, null, 1));
copyFileSync(`${prof}/filament/Bambu PLA Basic @BBL A1M.json`, `${work}/fil.json`);
copyFileSync(proj, `${work}/in.3mf`);
const args = ['run', `--filesystem=${work}`, '--command=bambu-studio', 'com.bambulab.BambuStudio', '--debug', '1',
  ...(flag === '--no-settings' ? [] : ['--load-settings', `${work}/machine.json;${work}/process.json`, '--load-filaments', `${work}/fil.json`]),
  '--slice', '0', '--outputdir', `${work}/o`, `${work}/in.3mf`];
let log = '';
try { log = execFileSync('flatpak', args, { maxBuffer: 1 << 28, timeout: 1200000 }).toString(); } catch (e) { log = String((e as { stdout?: Buffer }).stdout ?? e); }
writeFileSync(`${work}/cli.log`, log);
const resPath = `${work}/o/result.json`;
if (!existsSync(resPath)) { console.log(JSON.stringify({ ok: false, error: 'no result.json', log: log.slice(-800) })); process.exit(1); }
const res = JSON.parse(readFileSync(resPath, 'utf8'));
const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
const ours = summary.parts.filter((p: { plate: number }) => p.plate >= 0);
const plates = (res.sliced_plates ?? []) as { id: number; objects: { name: string; bbox: { x: number; y: number; width: number; depth: number; height: number } }[]; feature_type_times?: Record<string, number> }[];
// support filament from G-code: relative E under "; FEATURE: Support*"
const filamentArea = Math.PI * 0.875 * 0.875;
const perPlate = plates.map((pl) => {
  const g = `${work}/o/plate_${pl.id}.gcode`;
  let supE = 0, allE = 0, feat = '';
  if (existsSync(g)) for (const line of readFileSync(g, 'utf8').split('\n')) {
    if (line.startsWith('; FEATURE:')) { feat = line.slice(10).trim(); continue; }
    if (line.startsWith('G1') || line.startsWith('G2') || line.startsWith('G3')) { const m = / E(-?[\d.]+)/.exec(line); if (m && +m[1] > 0) { allE += +m[1]; if (/support/i.test(feat)) supE += +m[1]; } }
  }
  const t = pl.feature_type_times ?? {};
  const supT = Object.entries(t).filter(([k]) => /support/i.test(k)).reduce((s, [, v]) => s + v, 0);
  return { plate: pl.id, objects: pl.objects.map((o) => o.name), supportFilamentMm3: +(supE * filamentArea).toFixed(0), totalFilamentMm3: +(allE * filamentArea).toFixed(0), supportTimeS: +supT.toFixed(0), totalTimeS: +Object.values(t).reduce((s, v) => s + v, 0).toFixed(0) };
});
// object placement agreement: slicer bbox (plate-local) vs our placed bbox
const mism: string[] = [];
for (const pl of plates) for (const o of pl.objects) {
  const mine = ours.find((p: { name: string }) => p.name === o.name);
  if (!mine) { mism.push(`${o.name}: unknown object`); continue; }
  if (mine.plate + 1 !== pl.id) mism.push(`${o.name}: slicer plate ${pl.id}, ours ${mine.plate + 1}`);
  if (Math.abs(o.bbox.height - mine.height) > 0.3) mism.push(`${o.name}: height ${o.bbox.height.toFixed(2)} vs ${mine.height.toFixed(2)}`);
  // result.json reports boxes in Bambu's multi-plate world frame: subtract the plate origin
  const org = plateOrigin(pl.id - 1, Math.max(...ours.map((p: { plate: number }) => p.plate)) + 1), x = o.bbox.x - org[0], y = o.bbox.y - org[1];
  if (x < -0.01 || y < -0.01 || x + o.bbox.width > 180.01 || y + o.bbox.depth > 180.01) mism.push(`${o.name}: off the plate per slicer (${x.toFixed(1)},${y.toFixed(1)} ${o.bbox.width.toFixed(1)}×${o.bbox.depth.toFixed(1)})`);
}
const seen = plates.flatMap((p) => p.objects.map((o) => o.name));
for (const p of ours) if (!seen.includes(p.name)) mism.push(`${p.name}: missing in slicer`);
const out = { ok: res.return_code === 0 && !mism.length, returnCode: res.return_code, error: res.error_string, slicedPlates: plates.length, expectedPlates: Math.max(...ours.map((p: { plate: number }) => p.plate)) + 1, objects: seen.length, expectedObjects: ours.length, mismatches: mism, perPlate };
writeFileSync(`${work}/validation.json`, JSON.stringify(out, null, 1));
console.log(JSON.stringify(out));
