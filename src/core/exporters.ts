// STL per part and one 3MF per A1 Mini plate (parts already oriented and placed in plate coordinates, mm).
import { zipSync, strToU8 } from 'fflate';
import type { Manifold } from 'manifold-3d';
import type { PrepareResult } from './prepare';

export function stl(m: Manifold): Uint8Array {
  const mesh = m.getMesh();
  const buf = new ArrayBuffer(84 + mesh.numTri * 50);
  const dv = new DataView(buf);
  dv.setUint32(80, mesh.numTri, true);
  const p = mesh.vertProperties, np = mesh.numProp;
  for (let t = 0; t < mesh.numTri; t++) {
    const o = 84 + t * 50;
    const v = [0, 1, 2].map((j) => { const i = mesh.triVerts[t * 3 + j] * np; return [p[i], p[i + 1], p[i + 2]]; });
    const u = v[1].map((x, k) => x - v[0][k]), w = v[2].map((x, k) => x - v[0][k]);
    const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    const l = Math.hypot(...n) || 1;
    n.forEach((x, k) => dv.setFloat32(o + k * 4, x / l, true));
    v.flat().forEach((x, k) => dv.setFloat32(o + 12 + k * 4, x, true));
  }
  return new Uint8Array(buf);
}

export function threeMF(objects: { name: string; m: Manifold }[]): Uint8Array {
  let res = '', items = '';
  objects.forEach(({ name, m }, i) => {
    const mesh = m.getMesh();
    const p = mesh.vertProperties, np = mesh.numProp;
    const vs: string[] = [], ts: string[] = [];
    for (let v = 0; v < mesh.numVert; v++) vs.push(`<vertex x="${p[v * np].toFixed(5)}" y="${p[v * np + 1].toFixed(5)}" z="${p[v * np + 2].toFixed(5)}"/>`);
    for (let t = 0; t < mesh.numTri; t++) ts.push(`<triangle v1="${mesh.triVerts[t * 3]}" v2="${mesh.triVerts[t * 3 + 1]}" v3="${mesh.triVerts[t * 3 + 2]}"/>`);
    res += `<object id="${i + 1}" name="${name}" type="model"><mesh><vertices>${vs.join('')}</vertices><triangles>${ts.join('')}</triangles></mesh></object>`;
    items += `<item objectid="${i + 1}"/>`;
  });
  const model = `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><metadata name="Application">Auto Splitter (A1 Mini)</metadata><resources>${res}</resources><build>${items}</build></model>`;
  return zipSync({
    '[Content_Types].xml': strToU8('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>'),
    '_rels/.rels': strToU8('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>'),
    '3D/3dmodel.model': strToU8(model),
  });
}

export function exportAll(r: PrepareResult): Record<string, Uint8Array> {
  const files: Record<string, Uint8Array> = {};
  for (const p of r.parts) files[`${p.name}.stl`] = stl(p.placed!);
  for (let i = 0; i < r.plates; i++) files[`plate_${i + 1}.3mf`] = threeMF(r.parts.filter((p) => p.plate === i).map((p) => ({ name: p.name, m: p.placed! })));
  return files;
}
