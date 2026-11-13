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

function meshOf(soup: Float32Array, color: number) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(soup, 3));
  g.computeVertexNormals();
  return new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.05, flatShading: false }));
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
        plate.position.set(i * 200, 0, 0);
        const bed = new THREE.Mesh(new THREE.PlaneGeometry(180, 180), new THREE.MeshStandardMaterial({ color: 0x2a2f38 }));
        bed.position.set(90, 90, -0.05); plate.add(bed);
        plate.add(new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(180, 180, 180)), new THREE.LineBasicMaterial({ color: 0x3a4250 })).translateX(90).translateY(90).translateZ(90));
        result.parts.forEach((p: any, j: number) => { if (p.plate === i) plate.add(meshOf(p.placed, colorOf(p, j))); });
        root.add(plate);
      }
    } else {
      const center = new THREE.Box3();
      const bodies = result.parts.filter((p: any) => p.role === 'body');
      const geo = result.parts.map((p: any) => { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(p.assembled, 3)); g.computeBoundingBox(); return g; });
      bodies.forEach((p: any) => center.union(geo[result.parts.indexOf(p)].boundingBox));
      const c = center.getCenter(new THREE.Vector3());
      const size = center.getSize(new THREE.Vector3()).length();
      result.parts.forEach((p: any, j: number) => {
        const m = meshOf(p.assembled, colorOf(p, j));
        if (view === 'Exploded') {
          const pc = geo[j].boundingBox.getCenter(new THREE.Vector3());
          const d = pc.clone().sub(c);
          const off = p.role === 'pin' ? d.multiplyScalar(k * 0.9) : d.multiplyScalar(k * 0.8);
          m.position.copy(off);
          if (p.insertDir && k > 0.05) {
            const dir = new THREE.Vector3(...p.insertDir);
            const a = new THREE.ArrowHelper(dir, pc.clone().add(off).addScaledVector(dir, -size * 0.08), size * 0.07, p.blocked ? 0xff6b6b : 0xffffff, size * 0.02, size * 0.012);
            root.add(a);
          }
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
    const cls = (v: string) => (v.startsWith('PASS') ? 'pass' : v.startsWith('FAIL') ? 'fail' : '');
    $('out').innerHTML += `<section><b>Result</b><p>${esc(m.decision)}</p>
      <a download="${base}_a1mini.zip" href="${url}">⬇ Download ZIP (${d.files.length} files: STL per part + 3MF per plate)</a></section>
      <section><b>Verification</b><ul>${Object.entries(m.checks).map(([k, v]: any) => `<li><span class="k">${esc(k)}:</span> <span class="${cls(v)}">${esc(v)}</span></li>`).join('')}</ul></section>
      <section><b>Parts</b><ul>${d.parts.map((p: any, j: number) => `<li><span class="sw" style="background:#${colorOf(p, j).toString(16).padStart(6, '0')}"></span>${p.name} · plate ${p.plate + 1}${p.role === 'body' ? ` · h ${p.height.toFixed(0)} mm · support ≈ ${(p.supportArea / 100).toFixed(1)} cm²` : ''}</li>`).join('')}</ul></section>
      ${m.assemblyOrder.length ? `<section><b>Assembly sequence</b><ol>${m.assemblyOrder.map((a: any) => `<li>part_${a.part}${a.onto ? ` → onto part_${a.onto}` : ' (base)'}${a.ok === false ? ' <span class="fail">blocked</span>' : ''}</li>`).join('')}</ol><div class="k">Insert dowels into the base side first. Arrows in Exploded view show insertion direction.</div></section>` : ''}
      <section><b>Warnings / not verified</b><ul>${m.warnings.map((w: string) => `<li class="warn">${esc(w)}</li>`).join('')}
      <li class="k">Not verified: print strength, actual fit tolerance, seam visibility to a human eye, slicer support placement.</li></ul></section>`;
    draw(true);
  });
};
renderTabs();
