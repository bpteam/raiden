import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

const SAMPLES: [string, string][] = [
  ['woman_seated_v16.glb', 'Seated woman in dress (GLB, 141k tris)'],
  ['m1.glb', 'm1 — Tripo character (GLB, 71k tris)'],
  ['Fox.glb', 'Fox — Khronos (GLB, CC BY 4.0)'],
  ['prototype-kit-figurine.glb', 'Figurine — prototype kit (GLB, CC0)'],
  ['prototype-kit-animal-bison.glb', 'Bison — prototype kit (GLB, CC0; open meshes)'],
  ['Lantern.glb', 'Lantern — Khronos (GLB, CC0; open meshes)'],
];
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const sel = $<HTMLSelectElement>('sample');
sel.innerHTML = '<option value="">— choose —</option>' + SAMPLES.map(([f, l]) => `<option value="${f}">${l}</option>`).join('');

// ---------- 3D view ----------
const host = $('view');
let renderer: THREE.WebGLRenderer | null = null;
try {
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(devicePixelRatio);
  host.appendChild(renderer.domElement);
} catch {
  host.innerHTML = '<p style="padding:60px 20px;color:#ffc35a">3D preview unavailable: WebGL could not start in this browser. Auto Prepare, checks and export still work.</p>';
}
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x14161a);
const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 1e5);
camera.up.set(0, 0, 1);
const controls = new OrbitControls(camera, renderer?.domElement ?? host);
scene.add(new THREE.HemisphereLight(0xffffff, 0x334455, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.position.set(1, -2, 3);
scene.add(sun);
const root = new THREE.Group();
scene.add(root);
function resize() { const r = host.getBoundingClientRect(); renderer?.setSize(r.width, r.height); camera.aspect = r.width / r.height; camera.updateProjectionMatrix(); }
addEventListener('resize', resize); resize();
renderer?.setAnimationLoop(() => { controls.update(); renderer!.render(scene, camera); });

/** Mesh with seam (cut-plane) triangles tinted, so every joint surface is visible at a glance. */
/** supportRisk (optional, per triangle): 1 = needs support on a visible surface (red), 2 = needs support, hidden surface (amber). */
function meshOf(soup: Float32Array, color: number, seams: { normal: number[]; offset: number }[] = [], supportRisk?: Uint8Array) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(soup, 3));
  g.computeVertexNormals();
  const base = new THREE.Color(color), seam = new THREE.Color(0xff3b5c), riskVis = new THREE.Color(0xff2020), riskHid = new THREE.Color(0xffb020);
  const col = new Float32Array(soup.length);
  for (let t = 0; t < soup.length; t += 9) {
    const on = seams.some((f) => [0, 3, 6].every((o) => Math.abs(soup[t + o] * f.normal[0] + soup[t + o + 1] * f.normal[1] + soup[t + o + 2] * f.normal[2] - f.offset) < 0.05));
    const risk = supportRisk?.[t / 9];
    const c = on ? seam : risk === 1 ? riskVis : risk === 2 ? riskHid : base;
    for (let k = 0; k < 9; k += 3) { col[t + k] = c.r; col[t + k + 1] = c.g; col[t + k + 2] = c.b; }
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.05 }));
}
function frame(obj: THREE.Object3D) {
  const b = new THREE.Box3().setFromObject(obj);
  const c = b.getCenter(new THREE.Vector3()), r = b.getSize(new THREE.Vector3()).length() || 1;
  controls.target.copy(c);
  camera.position.copy(c).add(new THREE.Vector3(0.9, -1.4, 0.8).multiplyScalar(r));
  camera.near = r / 1000; camera.far = r * 100; camera.updateProjectionMatrix();
}
const clear = () => { for (const c of [...root.children]) { root.remove(c); c.traverse((o) => { if (o instanceof THREE.Mesh) { o.geometry.dispose(); } }); } };

// ---------- state ----------
type View = 'Original' | 'Assembled' | 'Exploded' | 'Print Plates';
let original: Float32Array | null = null;
let result: any = null;
let view: View = 'Original';
let current: { name: string; buf: ArrayBuffer } | null = null;
let worker: Worker | null = null;
const tabs = $('tabs');
function renderTabs() {
  const avail: View[] = result ? ['Original', 'Assembled', 'Exploded', 'Print Plates'] : ['Original'];
  tabs.innerHTML = '';
  for (const v of avail) {
    const b = document.createElement('button');
    b.textContent = v; b.className = v === view ? 'on' : '';
    b.onclick = () => { view = v; draw(true); };
    tabs.appendChild(b);
  }
}
const COLORS = [0x4fb3ff, 0xff9f43, 0x5fd18a, 0xc77dff, 0xff6b81, 0xf6e05e, 0x48dbfb, 0xa3cb38, 0xfd79a8, 0x74b9ff, 0xe17055, 0x81ecec];
const colorOf = (p: any, i: number) => (p.role === 'pin' ? 0xdddddd : COLORS[i % COLORS.length]);

function draw(refit = false) {
  renderTabs();
  clear();
  $('sliderBox').hidden = view !== 'Exploded';
  if (view === 'Original' && original) root.add(meshOf(original, 0xb8c0cc));
  if (result && view !== 'Original') {
    const k = +$<HTMLInputElement>('explode').value;
    if (view === 'Print Plates') {
      const n = result.meta.plates;
      for (let i = 0; i < n; i++) {
        const plate = new THREE.Group();
        plate.position.set((i % 3) * 200, -Math.floor(i / 3) * 200, 0);
        const bed = new THREE.Mesh(new THREE.PlaneGeometry(180, 180), new THREE.MeshStandardMaterial({ color: 0x2a2f38 }));
        bed.position.set(90, 90, -0.05); plate.add(bed);
        plate.add(new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(180, 180, 180)), new THREE.LineBasicMaterial({ color: 0x3a4250 })).translateX(90).translateY(90).translateZ(90));
        result.parts.forEach((p: any, j: number) => { if (p.plate === i) plate.add(meshOf(p.placed, colorOf(p, j), [], p.supportTris)); });
        root.add(plate);
      }
    } else {
      const center = new THREE.Box3();
      const bodies = result.parts.filter((p: any) => p.role === 'body');
      const geo = result.parts.map((p: any) => { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(p.assembled, 3)); g.computeBoundingBox(); return g; });
      bodies.forEach((p: any) => center.union(geo[result.parts.indexOf(p)].boundingBox));
      const c = center.getCenter(new THREE.Vector3());
      const size = center.getSize(new THREE.Vector3()).length();
      // Explode along the cut tree: at every cut both sides back off along its normal, so the picture is the real assembly path.
      const step = k * size * 0.18;
      const contrib = (id: number, skipCut = -1) => {
        const v = new THREE.Vector3();
        for (const st of result.meta.assemblyOrder) {
          if (st.cut === skipCut) continue;
          const n = new THREE.Vector3(...st.dir).negate();
          if (st.a.includes(id)) v.addScaledVector(n, step); else if (st.b.includes(id)) v.addScaledVector(n, -step);
        }
        return v;
      };
      const offs = new Map<number, THREE.Vector3>(bodies.map((p: any) => [p.id, contrib(p.id)]));
      const pinOff = (p: any) => {
        const st = result.meta.assemblyOrder.find((x: any) => x.pins.includes(p.id));
        return st ? contrib(st.a[0], st.cut) : new THREE.Vector3();
      };
      if (view === 'Exploded' && k > 0.05) for (const st of result.meta.assemblyOrder) {
        const bb = new THREE.Box3();
        st.a.forEach((id: number) => bb.union(geo[result.parts.findIndex((q: any) => q.id === id)].boundingBox.clone().translate(offs.get(id)!)));
        const dir = new THREE.Vector3(...st.dir);
        root.add(new THREE.ArrowHelper(dir, bb.getCenter(new THREE.Vector3()).addScaledVector(dir, -size * 0.12), size * 0.1, st.ok ? 0xffffff : 0xff6b6b, size * 0.025, size * 0.015));
      }
      result.parts.forEach((p: any, j: number) => {
        const m = meshOf(p.assembled, colorOf(p, j), view === 'Exploded' ? p.cutFaces : []);
        if (view === 'Exploded') {
          const pc = geo[j].boundingBox.getCenter(new THREE.Vector3());
          const off = p.role === 'pin' ? pinOff(p) : offs.get(p.id) ?? pc.clone().sub(c).multiplyScalar(k * 0.8);
          m.position.copy(off);
        }
        root.add(m);
      });
    }
  }
  if (refit) frame(root);
}
$<HTMLInputElement>('explode').oninput = () => draw();

// ---------- worker plumbing ----------
function startWorker(msg: any, onDone: (d: any) => void) {
  worker?.terminate();
  worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  $<HTMLButtonElement>('cancel').disabled = false;
  $<HTMLButtonElement>('go').disabled = true;
  worker.onmessage = (e) => {
    const d = e.data;
    if (d.type === 'progress') { $('stage').textContent = d.stage; $('bar').style.width = `${(d.frac * 100).toFixed(0)}%`; return; }
    worker!.terminate(); worker = null; // frees the wasm heap
    $<HTMLButtonElement>('cancel').disabled = true;
    $<HTMLButtonElement>('go').disabled = !current;
    if (d.type === 'error') { $('stage').innerHTML = `<span class="fail">Error: ${esc(d.message)}</span>`; $('bar').style.width = '0'; return; }
    $('bar').style.width = '100%';
    onDone(d);
  };
  worker.onerror = (e) => { $('stage').innerHTML = `<span class="fail">Worker error: ${esc(e.message)}</span>`; worker?.terminate(); worker = null; $<HTMLButtonElement>('cancel').disabled = true; $<HTMLButtonElement>('go').disabled = !current; };
  worker.postMessage({ ...msg, buf: msg.buf.slice(0) });
}
$('cancel').onclick = () => { worker?.terminate(); worker = null; $('stage').textContent = 'Cancelled.'; $('bar').style.width = '0'; $<HTMLButtonElement>('cancel').disabled = true; $<HTMLButtonElement>('go').disabled = !current; };
const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);

function load(name: string, buf: ArrayBuffer) {
  current = { name, buf }; result = null; original = null; view = 'Original'; $('out').innerHTML = '';
  startWorker({ type: 'import', name, buf }, (d) => {
    original = d.soup;
    const r = d.report, b = r.bbox;
    const dimsTxt = [0, 1, 2].map((k) => (b[k + 3] - b[k]).toPrecision(4)).join(' × ');
    $('stage').textContent = `Loaded ${name}`;
    $('out').innerHTML = `<section><b>Import diagnostics</b><ul>
      <li><span class="k">Triangles:</span> ${r.inputTris}</li>
      <li><span class="k">Size (file units):</span> ${dimsTxt}</li>
      <li><span class="k">Components:</span> ${r.components} (${r.manifoldComponents} watertight)</li>
      <li><span class="k">Non-manifold/open edges:</span> ${r.openEdges}</li>
      <li class="${r.ok ? 'pass' : r.manifoldComponents ? 'warn' : 'fail'}">${r.ok ? 'Solid: OK for cutting' : r.manifoldComponents ? 'Partially solid: open components will be excluded' : 'Not printable as-is: no closed component'}</li>
      ${r.notes.map((n: string) => `<li class="warn">${esc(n)}</li>`).join('')}</ul></section>`;
    draw(true);
  });
}
sel.onchange = async () => {
  if (!sel.value) return;
  $('stage').textContent = 'Fetching sample…';
  const res = await fetch(`${import.meta.env.BASE_URL}samples/${sel.value}`);
  if (!res.ok) { $('stage').textContent = `Sample fetch failed: HTTP ${res.status}`; return; }
  load(sel.value, await res.arrayBuffer());
};
$<HTMLInputElement>('file').onchange = async (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (f) { sel.value = ''; load(f.name, await f.arrayBuffer()); }
};

$('go').onclick = () => {
  if (!current) return;
  const height = +$<HTMLInputElement>('height').value;
  if (!(height > 0)) { $('stage').textContent = 'Enter a positive height.'; return; }
  startWorker({ type: 'run', ...current, height }, (d) => {
    result = d; view = d.parts.length > 1 ? 'Exploded' : 'Assembled';
    $('stage').textContent = 'Done.';
    const m = d.meta;
    const url = URL.createObjectURL(new Blob([d.zip], { type: 'application/zip' }));
    const base = current!.name.replace(/\.[^.]+$/, '');
    const names = (ids: number[]) => ids.map((id) => d.parts.find((p: any) => p.id === id).name).join(' + ');
    const cls = (v: string) => (v.startsWith('PASS') ? 'pass' : v.startsWith('FAIL') ? 'fail' : '');
    $('out').innerHTML += `<section><b>Result</b><p>${esc(m.decision)}</p>
      <a download="${base}_a1mini.zip" href="${url}">⬇ Download ZIP (${d.files.length} files: Bambu Studio project 3MF with all plates, 3MF per plate, STL per part)</a></section>
      <section><b>Estimates (geometric, not slicer output)</b><ul>${Object.entries(m.summary).map(([k, v]: any) => `<li><span class="k">${esc(k)}:</span> ${esc(String(v))}</li>`).join('')}</ul></section>
      ${m.cuts.length ? `<section><b>Seams</b><ul>${m.cuts.map((c: any) => `<li>Cut ${c.id}: seam ${c.seamLength.toFixed(0)} mm, visibility-weighted ${c.visibleSeam.toFixed(0)} mm${c.neck > 0.2 ? ' · at a neck/crease' : ''}${c.curved ? ` · curved into a fold (±${c.curved.maxDz} mm, ${(c.curved.gain * 100).toFixed(0)}% less visible)` : ''} · ${c.pins.length ? c.pins.map((p: any) => `${p.shape} ⌀${(2 * p.r).toFixed(1)}×${(2 * p.depth).toFixed(0)} mm`).join(', ') : '<span class="warn">no dowel</span>'}</li>`).join('')}</ul></section>` : ''}
      <section><b>Verification</b><ul>${Object.entries(m.checks).map(([k, v]: any) => `<li><span class="k">${esc(k)}:</span> <span class="${cls(v)}">${esc(v)}</span></li>`).join('')}</ul></section>
      <section><b>Parts</b><ul>${d.parts.map((p: any, j: number) => `<li><span class="sw" style="background:#${colorOf(p, j).toString(16).padStart(6, '0')}"></span>${p.name} · plate ${p.plate + 1}${p.role === 'body' ? ` · h ${p.height.toFixed(0)} mm · support ≈ ${(p.supportArea / 100).toFixed(1)} cm² (${(p.supportVisible / 100).toFixed(1)} on visible surfaces)` : ''}</li>`).join('')}</ul></section>
      ${m.assemblyOrder.length ? `<section><b>Assembly sequence</b><ol>${m.assemblyOrder.map((a: any) => `<li>Seat ${a.pins.length} dowel(s) of cut ${a.cut} in ${names(a.b)}, then slide ${names(a.a)} onto them${a.ok ? '' : ' <span class="fail">collides</span>'}</li>`).join('')}</ol><div class="k">Each step joins two rigid groups across one flat seam; white arrows in Exploded view show the move. Dry-fit before glue.</div></section>` : ''}
      <section><b>Warnings / not verified</b><ul>${m.warnings.map((w: string) => `<li class="warn">${esc(w)}</li>`).join('')}
      <li class="k">Not verified: print strength, actual fit tolerance, seam visibility to a human eye. Support numbers are mesh estimates; slice in Bambu Studio for real support.</li></ul></section>`;
    draw(true);
  });
};
renderTabs();
