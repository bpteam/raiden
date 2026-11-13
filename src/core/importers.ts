// Format importers -> flat triangle soup (positions, 9 floats per triangle). Works in browser worker and node.
import { WebIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import { unzipSync, strFromU8 } from 'fflate';

export interface TriSoup { pos: Float32Array; warnings: string[] }

export async function importModel(name: string, buf: ArrayBuffer): Promise<TriSoup> {
  const ext = name.toLowerCase().split('.').pop();
  if (buf.byteLength === 0) throw new Error('Empty file');
  if (ext === 'glb' || ext === 'gltf') return importGLB(buf);
  if (ext === 'stl') return importSTL(buf);
  if (ext === '3mf') return import3MF(buf);
  if (ext === 'obj') return importOBJ(new TextDecoder().decode(buf));
  throw new Error(`Unsupported format: .${ext}`);
}

async function importGLB(buf: ArrayBuffer): Promise<TriSoup> {
  await MeshoptDecoder.ready;
  const io = new WebIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
  // Images stay as raw bytes; only geometry is read.
  const doc = await io.readBinary(new Uint8Array(buf));
  const out: number[] = [];
  const warnings: string[] = [];
  const v = [0, 0, 0];
  for (const scene of doc.getRoot().listScenes()) {
    scene.traverse((node) => {
      const mesh = node.getMesh();
      if (!mesh) return;
      const m = node.getWorldMatrix();
      for (const prim of mesh.listPrimitives()) {
        if (prim.getMode() !== 4) { warnings.push(`Skipped non-triangle primitive (mode ${prim.getMode()})`); continue; }
        const P = prim.getAttribute('POSITION');
        if (!P) continue;
        const I = prim.getIndices();
        const n = I ? I.getCount() : P.getCount();
        for (let i = 0; i < n; i++) {
          P.getElement(I ? I.getScalar(i) : i, v);
          const x = v[0], y = v[1], z = v[2];
          // glTF is Y-up; convert to Z-up (printer frame): (x, y, z) -> (x, -z, y)
          const tx = m[0] * x + m[4] * y + m[8] * z + m[12];
          const ty = m[1] * x + m[5] * y + m[9] * z + m[13];
          const tz = m[2] * x + m[6] * y + m[10] * z + m[14];
          out.push(tx, -tz, ty);
        }
        if (prim.getAttribute('JOINTS_0')) warnings.push('Skinned mesh: bind pose used');
      }
    });
  }
  return { pos: new Float32Array(out), warnings: [...new Set(warnings)] };
}

export function importSTL(buf: ArrayBuffer): TriSoup {
  const dv = new DataView(buf);
  const head = new TextDecoder().decode(new Uint8Array(buf, 0, Math.min(512, buf.byteLength)));
  if (buf.byteLength >= 84) {
    const n = dv.getUint32(80, true);
    if (84 + n * 50 === buf.byteLength) {
      const pos = new Float32Array(n * 9);
      for (let i = 0; i < n; i++) for (let j = 0; j < 9; j++) pos[i * 9 + j] = dv.getFloat32(84 + i * 50 + 12 + j * 4, true);
      return { pos, warnings: [] };
    }
  }
  if (!/^\s*solid/.test(head)) throw new Error('Invalid STL: neither binary size match nor ASCII "solid" header');
  const txt = new TextDecoder().decode(buf);
  const nums = [...txt.matchAll(/vertex\s+(\S+)\s+(\S+)\s+(\S+)/g)].flatMap((m) => [+m[1], +m[2], +m[3]]);
  if (!nums.length || nums.length % 9 || nums.some(Number.isNaN)) throw new Error('Invalid ASCII STL');
  return { pos: new Float32Array(nums), warnings: [] };
}

function import3MF(buf: ArrayBuffer): TriSoup {
  const files = unzipSync(new Uint8Array(buf));
  const key = Object.keys(files).find((k) => /\.model$/i.test(k));
  if (!key) throw new Error('3MF: no .model part');
  const xml = strFromU8(files[key]);
  const unit = { micron: 0.001, millimeter: 1, centimeter: 10, inch: 25.4, foot: 304.8, meter: 1000 }[/unit="(\w+)"/.exec(xml)?.[1] ?? 'millimeter'] ?? 1;
  // Objects by id -> triangle soup; then instantiate build items with transforms.
  const objs = new Map<string, number[]>();
  const comps = new Map<string, { id: string; t: number[] }[]>();
  for (const om of xml.matchAll(/<object\b[^>]*\bid="(\d+)"[^>]*>([\s\S]*?)<\/object>/g)) {
    const body = om[2];
    const vs = [...body.matchAll(/<vertex\b[^>]*x="([^"]+)"[^>]*y="([^"]+)"[^>]*z="([^"]+)"/g)].map((m) => [+m[1], +m[2], +m[3]]);
    const tri: number[] = [];
    for (const t of body.matchAll(/<triangle\b[^>]*v1="(\d+)"[^>]*v2="(\d+)"[^>]*v3="(\d+)"/g)) for (const k of [1, 2, 3]) tri.push(...vs[+t[k]]);
    objs.set(om[1], tri);
    comps.set(om[1], [...body.matchAll(/<component\b([^>]*)\/?>/g)].map((c) => ({ id: /objectid="(\d+)"/.exec(c[1])![1], t: parseT(/transform="([^"]+)"/.exec(c[1])?.[1]) })));
  }
  const expand = (id: string, t: number[], out: number[], depth = 0) => {
    if (depth > 16) throw new Error('3MF: component recursion');
    const tri = objs.get(id) ?? [];
    for (let i = 0; i < tri.length; i += 3) out.push(...apply(t, tri[i], tri[i + 1], tri[i + 2]));
    for (const c of comps.get(id) ?? []) expand(c.id, mul(t, c.t), out, depth + 1);
  };
  const out: number[] = [];
  const build = /<build\b[^>]*>([\s\S]*?)<\/build>/.exec(xml)?.[1] ?? '';
  for (const it of build.matchAll(/<item\b([^>]*)\/?>/g)) expand(/objectid="(\d+)"/.exec(it[1])![1], parseT(/transform="([^"]+)"/.exec(it[1])?.[1]), out);
  return { pos: new Float32Array(out.map((x) => x * unit)), warnings: [] };
}
// 3MF transform: 12 numbers m00 m01 m02 m10 m11 m12 m20 m21 m22 m30 m31 m32 (row vectors)
const parseT = (s?: string) => (s ? s.trim().split(/\s+/).map(Number) : [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);
const apply = (t: number[], x: number, y: number, z: number) => [
  x * t[0] + y * t[3] + z * t[6] + t[9], x * t[1] + y * t[4] + z * t[7] + t[10], x * t[2] + y * t[5] + z * t[8] + t[11]];
const mul = (a: number[], b: number[]) => { // child b then parent a
  const r = [...apply(a, b[0], b[1], b[2]), ...apply(a, b[3], b[4], b[5]), ...apply(a, b[6], b[7], b[8]), ...apply(a, b[9], b[10], b[11])];
  for (let i = 0; i < 9; i++) r[i] -= a[9 + (i % 3)];
  return r;
};

function importOBJ(txt: string): TriSoup {
  const v: number[][] = [];
  const out: number[] = [];
  for (const line of txt.split('\n')) {
    const p = line.trim().split(/\s+/);
    if (p[0] === 'v') v.push([+p[1], +p[2], +p[3]]);
    else if (p[0] === 'f') {
      const ids = p.slice(1).map((s) => { const i = parseInt(s); return i < 0 ? v.length + i : i - 1; });
      for (let k = 1; k + 1 < ids.length; k++) for (const i of [ids[0], ids[k], ids[k + 1]]) { const q = v[i]; out.push(q[0], -q[2], q[1]); }
    }
  }
  return { pos: new Float32Array(out), warnings: ['OBJ assumed Y-up'] };
}
