// Visual + numeric report for one model: runs Auto Prepare (current, or the legacy pipeline with --legacy=<dir of old
// src/core>) and renders six views with the same headless renderer:
//   1 original · 2 seams highlighted (front + back) · 3 assembled · 4 exploded with dowels · 5 plates · 6 support risk
// usage: tsx scripts/report.ts <model> <height> <outdir> [--legacy=out/legacy/src/core]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { Matrix4, Vector3 } from 'three';
import type { Manifold } from 'manifold-3d';
import { importModel } from '../src/core/importers';
import { loadManifold, toManifold } from '../src/core/geom';
import { analyzeSurface, meshOf, triGeom, lookup, partMesh, evenOut, type Field } from '../src/core/analysis';
import { evalDown } from '../src/core/orient';
import { seamFromCaps } from '../src/core/cuts';
import { shot, ISO, type Obj } from './viz';

const [file, hArg, outDir, legacyArg] = process.argv.slice(2);
const legacy = legacyArg?.startsWith('--legacy=') ? resolve(legacyArg.slice(9)) : null;
const { prepare } = await import(legacy ? `${legacy}/prepare.ts` : '../src/core/prepare');
const tag = process.env.TAG ?? (legacy ? 'before' : 'after');
const name = basename(file).replace(/\.[^.]+$/, '');
mkdirSync(outDir, { recursive: true });
const w = await loadManifold();
const b = readFileSync(file);
const soup = await importModel(file, b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
const { solid } = toManifold(w, soup.pos);
const bb = solid!.boundingBox();
const scale = +hArg / (bb.max[2] - bb.min[2]);
const t0 = Date.now();
// env HINTS=<json> / MIN_PARTS=<n>: Guided Split / Target Parts (ignored by the legacy pipeline); TAG overrides the file suffix
const r = prepare(w, solid!, scale, 12, () => {}, { hints: process.env.HINTS ? JSON.parse(readFileSync(process.env.HINTS, 'utf8')) : undefined, minParts: process.env.MIN_PARTS ? +process.env.MIN_PARTS : undefined });
const ms = Date.now() - t0;
// the assembled frame of `prepare` is the scaled model centred in XY, standing on z = 0
const s0 = solid!.scale(scale), b0 = s0.boundingBox();
const orig = s0.translate([-(b0.min[0] + b0.max[0]) / 2, -(b0.min[1] + b0.max[1]) / 2, -b0.min[2]]);
const field: Field = analyzeSurface(orig);

const PAL = [[79, 179, 255], [255, 159, 67], [95, 209, 138], [199, 125, 255], [255, 107, 129], [246, 224, 94], [72, 219, 251], [163, 203, 56], [253, 121, 168], [116, 185, 255], [225, 112, 85], [129, 236, 236]];
const GREY = [190, 196, 205], SEAM = [255, 40, 70], PIN = [235, 235, 235];
type P = { name: string; role: string; solid: Manifold; placed?: Manifold; plate: number; cutFaces: { normal: number[]; offset: number }[]; place: Matrix4; orient: Matrix4 };
const parts: P[] = r.parts;
const bodies = parts.filter((p) => p.role === 'body');
const col = (p: P) => (p.role === 'pin' ? PIN : PAL[bodies.indexOf(p) % PAL.length]);
const views = { front: ISO, back: [-ISO[0], -ISO[1], ISO[2]] };
const out = (k: string) => `${outDir}/${name}_${hArg}_${tag}_${k}.png`;

// 1 original
const ot = meshOf(orig);
shot(out('1_original'), [{ t: ot, color: () => GREY }], views.front);

// 2 seams: surface triangles bordering a cut cap (planar or curved), on a finely refined copy so the line shows
const seamObjs = (): Obj[] => bodies.map((p) => {
  const pm = partMesh(p.solid.refineToLength(1.5), field, p.cutFaces);
  const { seamTri } = seamFromCaps(pm, p.cutFaces);
  // widen the one-triangle seam line to ~3 rings so it is visible at report resolution (caps excluded)
  for (let ring = 0; ring < 3; ring++) {
    const hot = new Uint8Array(pm.pos.length / 3);
    for (let i = 0; i < pm.nt; i++) if (seamTri[i]) for (let k = 0; k < 3; k++) hot[pm.idx[i * 3 + k]] = 1;
    for (let i = 0; i < pm.nt; i++) if (!pm.iface[i] && (hot[pm.idx[i * 3]] || hot[pm.idx[i * 3 + 1]] || hot[pm.idx[i * 3 + 2]])) seamTri[i] = 1;
  }
  return { t: pm, color: (i: number) => (seamTri[i] ? SEAM : GREY) };
});
shot(out('2_seams_front'), seamObjs(), views.front);
shot(out('2_seams_back'), seamObjs(), views.back);

// 3 assembled (parts coloured)
shot(out('3_assembled'), bodies.map((p) => ({ t: meshOf(p.solid), color: () => col(p) })), views.front);

// 4 exploded along the assembly tree (same rule as the app's Exploded view), dowels included
const size = Math.hypot(b0.max[0] - b0.min[0], b0.max[1] - b0.min[1], b0.max[2] - b0.min[2]);
const step = size * 0.12;
const contrib = (id: number, skipCut = -1) => {
  const v = new Vector3();
  for (const st of r.assemblyOrder) { if (st.cut === skipCut) continue; const n = new Vector3(...st.dir).negate(); if (st.a.includes(id)) v.addScaledVector(n, step); else if (st.b.includes(id)) v.addScaledVector(n, -step); }
  return v;
};
const exploded: Obj[] = parts.map((p, i) => {
  let off = contrib(i + 1);
  if (p.role === 'pin') { const st = r.assemblyOrder.find((x: { pins: number[] }) => x.pins.includes(i + 1)); off = st ? contrib(st.b[0], st.cut).addScaledVector(new Vector3(...st.dir).negate(), step * 0.5) : off; }
  return { t: meshOf(p.solid), color: () => col(p), offset: off.toArray() };
});
shot(out('4_exploded'), exploded, views.front);

// 5 plates side by side (actual placed geometry) with bed slabs; 6 support risk on the same layout
const nPl = r.plates;
const bed = (i: number): Obj => ({ t: meshOf(w.Manifold.cube([180, 180, 1]).translate([i * 200, 0, -1.01])), color: () => [60, 66, 78] });
const plateObjs = (risk: boolean): Obj[] => [...(risk ? [] : Array.from({ length: nPl }, (_, i) => bed(i))), ...parts.filter((p) => p.placed && p.plate >= 0).map((p) => {
  const t = meshOf(p.placed!), g = triGeom(t);
  const back = p.place.clone().multiply(p.orient).invert();
  const at = meshOf(p.placed!.transform(back.elements as never)), ag = triGeom(at);
  const flags = new Uint8Array(g.nt);
  if (risk) for (let i = 0; i < g.nt; i++) {
    if (g.nrm[i * 3 + 2] >= -0.7071) continue;
    const zs = [0, 1, 2].map((k) => t.pos[t.idx[i * 3 + k] * 3 + 2]);
    if (Math.max(...zs) < 0.3) continue; // on the bed
    const j = lookup(field, ag.cx.subarray(i * 3, i * 3 + 3), ag.nrm.subarray(i * 3, i * 3 + 3), 2);
    flags[i] = j >= 0 && field.V[j] >= 0.15 ? 1 : 2;
  }
  return { t, offset: [p.plate * 200, 0, 0], color: (i: number) => (flags[i] === 1 ? [255, 30, 30] : flags[i] === 2 ? [255, 176, 32] : risk ? [150, 156, 165] : col(p)) };
})];
const plateView = (() => { const d = [-0.25, 0.75, -0.62]; const l = Math.hypot(...d); return d.map((x) => x / l); })();
shot(out('5_plates'), plateObjs(false), plateView, 900);
// support faces point down: look at the plates from below (no bed slab)
shot(out('6_support_risk'), plateObjs(true), [plateView[0], plateView[1], -plateView[2]], 900);

// ---- identical metrics for both pipelines (same field, same evaluator) ----
let supportArea = 0, supportVisible = 0, supportVolume = 0, stair = 0, sag = 0, minContact = Infinity, maxTip = 0, seamRaw = 0, seamVis = 0;
for (const p of bodies) {
  const pm = partMesh(evenOut(p.solid), field, p.cutFaces);
  const g = p.solid.hull().getMesh();
  const hull = Float32Array.from({ length: g.numVert * 3 }, (_, i) => g.vertProperties[Math.floor(i / 3) * g.numProp + (i % 3)]);
  const R = new Matrix4().extractRotation(p.orient);
  const down = new Vector3(0, 0, -1).applyMatrix4(R.clone().transpose()).normalize().toArray();
  const o = evalDown(pm, down, hull);
  supportArea += o.supportArea; supportVisible += o.supportVisible; supportVolume += o.supportVolume; stair += o.stair; sag += o.sag;
  minContact = Math.min(minContact, o.contact); maxTip = Math.max(maxTip, o.tip);
  const sm = seamFromCaps(pm, p.cutFaces); seamRaw += sm.raw / 2; seamVis += sm.weighted / 2;
}
const eval_ = { supportAreaMm2: Math.round(supportArea), supportOnVisibleMm2: Math.round(supportVisible), supportVolumeMm3: Math.round(supportVolume), stairVisibleMm2: Math.round(stair), sagVisibleMm2: Math.round(sag), minBedContactMm2: Math.round(minContact), maxTipRisk: +maxTip.toFixed(1), seamLengthMm: Math.round(seamRaw), seamVisibilityWeightedMm: Math.round(seamVis) };

const metrics = { curved: r.cuts.map((c: { curved?: unknown }) => c.curved ?? null), model: name, height: +hArg, pipeline: tag, ms, plates: r.plates, bodies: bodies.length, dowels: parts.length - bodies.length, cuts: r.cuts.length, decision: r.decision, checks: r.checks, eval: eval_, summary: r.summary ?? null };
writeFileSync(`${outDir}/${name}_${hArg}_${tag}.json`, JSON.stringify(metrics, null, 1));
console.log(JSON.stringify(metrics));
