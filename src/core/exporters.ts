// Exports: one Bambu Studio project 3MF holding every plate, a generic 3MF per plate, and an STL per part.
// The project layout mirrors what Bambu Studio 02.09 itself writes (checked against a CLI-exported reference project):
//   3D/3dmodel.model         build items = objects placed in Bambu's multi-plate world (plate i at col*216, -row*216 mm)
//   3D/Objects/object_k.model  meshes (3MF production extension, p:path components)
//   Metadata/model_settings.config  object names + <plate> membership
//   Metadata/project_settings.config  preset names only (A1 Mini 0.4, 0.20 mm Standard, Bambu PLA Basic); Bambu Studio
//                                     fills every other value from its own system presets.
// It is NOT sliced: open it in Bambu Studio and slice; support/time numbers come from there.
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

const xmlEsc = (s: string) => s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]!);

/** Mesh XML with vertices shifted by -c (so each object is centred like Bambu Studio's own exports). */
function meshXml(m: Manifold, c = [0, 0, 0]): string {
  const mesh = m.getMesh();
  const p = mesh.vertProperties, np = mesh.numProp;
  const vs: string[] = [], ts: string[] = [];
  for (let v = 0; v < mesh.numVert; v++) vs.push(`<vertex x="${(p[v * np] - c[0]).toFixed(5)}" y="${(p[v * np + 1] - c[1]).toFixed(5)}" z="${(p[v * np + 2] - c[2]).toFixed(5)}"/>`);
  for (let t = 0; t < mesh.numTri; t++) ts.push(`<triangle v1="${mesh.triVerts[t * 3]}" v2="${mesh.triVerts[t * 3 + 1]}" v3="${mesh.triVerts[t * 3 + 2]}"/>`);
  return `<mesh><vertices>${vs.join('')}</vertices><triangles>${ts.join('')}</triangles></mesh>`;
}

const CT = '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/><Default Extension="config" ContentType="text/xml"/></Types>';
const rels = (targets: string[]) => `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${targets.map((t, i) => `<Relationship Target="${t}" Id="rel-${i + 1}" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>`).join('')}</Relationships>`;

/** Generic single-plate 3MF (core spec only): any slicer, no plate/preset metadata. */
export function threeMF(objects: { name: string; m: Manifold }[]): Uint8Array {
  let res = '', items = '';
  objects.forEach(({ name, m }, i) => { res += `<object id="${i + 1}" name="${xmlEsc(name)}" type="model">${meshXml(m)}</object>`; items += `<item objectid="${i + 1}"/>`; });
  const model = `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><metadata name="Application">raiden auto splitter</metadata><resources>${res}</resources><build>${items}</build></model>`;
  return zipSync({ '[Content_Types].xml': strToU8(CT), '_rels/.rels': strToU8(rels(['/3D/3dmodel.model'])), '3D/3dmodel.model': strToU8(model) });
}

export const PLATE_STRIDE = 180 * 1.2; // Bambu Studio LOGICAL_PART_PLATE_GAP = 1/5 of the bed size
/** Bambu Studio's plate grid: columns = ceil-ish sqrt(count). Plate i sits at (col·216, −row·216). */
export function plateOrigin(i: number, count: number): number[] {
  const v = Math.sqrt(count), r = Math.round(v), cols = v > r ? r + 1 : r;
  return [(i % cols) * PLATE_STRIDE, -Math.floor(i / cols) * PLATE_STRIDE, 0];
}

export const PRESETS = { printer: 'Bambu Lab A1 mini 0.4 nozzle', process: '0.20mm Standard @BBL A1M', filament: 'Bambu PLA Basic @BBL A1M' };

export function bambuProject(r: PrepareResult): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  const placed = r.parts.filter((p) => p.placed && p.plate >= 0);
  let res = '', build = '', objCfg = '';
  const objPaths: string[] = [];
  const plates: number[][] = Array.from({ length: r.plates }, () => []);
  placed.forEach((p, i) => {
    const meshId = 2 * i + 1, objId = 2 * i + 2;
    const b = p.placed!.boundingBox();
    const c = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
    const path = `/3D/Objects/object_${i + 1}.model`;
    objPaths.push(path);
    files[path.slice(1)] = strToU8(`<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" requiredextensions="p"><resources><object id="${meshId}" type="model">${meshXml(p.placed!, c)}</object></resources><build/></model>`);
    const o = plateOrigin(p.plate, r.plates);
    res += `<object id="${objId}" type="model"><components><component p:path="${path}" objectid="${meshId}" transform="1 0 0 0 1 0 0 0 1 0 0 0"/></components></object>`;
    build += `<item objectid="${objId}" transform="1 0 0 0 1 0 0 0 1 ${(o[0] + c[0]).toFixed(5)} ${(o[1] + c[1]).toFixed(5)} ${c[2].toFixed(5)}" printable="1"/>`;
    objCfg += `<object id="${objId}"><metadata key="name" value="${xmlEsc(p.name)}"/><metadata key="extruder" value="1"/>${p.role === 'pin' || !p.brim ? '<metadata key="brim_type" value="no_brim"/>' : ''}<part id="${meshId}" subtype="normal_part"><metadata key="name" value="${xmlEsc(p.name)}"/><metadata key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/></part></object>`;
    plates[p.plate].push(objId);
  });
  const plateCfg = plates.map((ids, i) => `<plate><metadata key="plater_id" value="${i + 1}"/><metadata key="plater_name" value=""/><metadata key="locked" value="false"/>${ids.map((id) => `<model_instance><metadata key="object_id" value="${id}"/><metadata key="instance_id" value="0"/></model_instance>`).join('')}</plate>`).join('');
  const model = `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" requiredextensions="p"><metadata name="Application">BambuStudio-02.09.01.70</metadata><metadata name="BambuStudio:3mfVersion">1</metadata><metadata name="Title">raiden auto split</metadata><resources>${res}</resources><build>${build}</build></model>`;
  // Bambu Studio only reads plate metadata from files whose Application starts with "BambuStudio"; otherwise it loads
  // geometry only and drops the plate layout. The marker is a format-compatibility flag, verified with the 02.09 CLI.
  const settings = JSON.stringify({
    printer_settings_id: PRESETS.printer, print_settings_id: PRESETS.process, filament_settings_id: [PRESETS.filament],
    printer_model: 'Bambu Lab A1 mini', printer_variant: '0.4', nozzle_diameter: ['0.4'], printable_area: ['0x0', '180x0', '180x180', '0x180'], printable_height: '180',
    // parts were oriented assuming supports where overhangs remain; tree supports touch the least surface
    enable_support: '1', support_type: 'tree(auto)',
    // fixed 5 mm brim (auto brim can grow wider than the packer's spacing on tall parts); dowels override to no brim
    brim_type: 'outer_only', brim_width: '5',
    skirt_loops: '0', // per-object skirts wrap the support base and collide with neighbours; the A1 Mini primes its own purge line
    inherits_group: [PRESETS.process, PRESETS.filament, PRESETS.printer], from: 'project', version: '02.09.01.70',
  }, null, 4);
  Object.assign(files, {
    '[Content_Types].xml': strToU8(CT),
    '_rels/.rels': strToU8(rels(['/3D/3dmodel.model'])),
    '3D/_rels/3dmodel.model.rels': strToU8(rels(objPaths)),
    '3D/3dmodel.model': strToU8(model),
    'Metadata/model_settings.config': strToU8(`<?xml version="1.0" encoding="UTF-8"?><config>${objCfg}${plateCfg}</config>`),
    'Metadata/project_settings.config': strToU8(settings),
  });
  return zipSync(files);
}

export function exportAll(r: PrepareResult): Record<string, Uint8Array> {
  const files: Record<string, Uint8Array> = { 'project_a1mini.3mf': bambuProject(r) };
  for (const p of r.parts) if (p.placed) files[`${p.name}.stl`] = stl(p.placed);
  for (let i = 0; i < r.plates; i++) files[`plate_${i + 1}.3mf`] = threeMF(r.parts.filter((p) => p.plate === i).map((p) => ({ name: p.name, m: p.placed! })));
  return files;
}
