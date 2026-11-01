// ClaudeOS front end: the brain cloud, memory dots, and skill "employees".
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { events } from '/events.js';

const TYPE_COLORS = { brain: 0xc9a7ff, user: 0xffc861, feedback: 0xff7aa8, project: 0x5fd4ff, reference: 0x7dff9e };
const SOURCE_COLORS = { personal: 0xd97757, plugin: 0x7b8cff, project: 0x4fd1a5, contractor: 0x8a8fa8 };
const FIRST_NAMES = ['Ada', 'Bram', 'Cleo', 'Dax', 'Esme', 'Finn', 'Gia', 'Hugo', 'Iris', 'Jude', 'Kai', 'Lena',
  'Milo', 'Nova', 'Otto', 'Pia', 'Quinn', 'Rhea', 'Sol', 'Tess', 'Uma', 'Vik', 'Wren', 'Xan', 'Yara', 'Zed'];
const BUSY_WINDOW_MS = 30 * 60 * 1000;   // a session with no Stop for 30 min counts as finished
const CLOUD = new THREE.Vector3(5.2, 3.2, 4.2); // brain cloud radii

// ---------- helpers ----------
function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function rng(seed) {
  let s = seed || 1;
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) % 100000) / 100000; };
}
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const hex = n => '#' + n.toString(16).padStart(6, '0');
const easeOutBack = t => { const c = 1.7; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); };
function ago(ts) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(ts).toLocaleDateString();
}

// ---------- scene ----------
const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05060d);
scene.fog = new THREE.FogExp2(0x05060d, 0.018);
const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 400);
camera.position.set(0, 11, 23);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.autoRotate = true;
controls.autoRotateSpeed = 0.35;
controls.minDistance = 8;
controls.maxDistance = 60;

scene.add(new THREE.AmbientLight(0x8890c0, 0.55));
const key = new THREE.DirectionalLight(0xffffff, 1.6);
key.position.set(6, 12, 10);
scene.add(key);
const brainLight = new THREE.PointLight(0x9fb4ff, 30, 40, 1.6);
scene.add(brainLight);

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.7, 0.5, 0.6);
composer.addPass(bloom);
composer.addPass(new OutputPass());

function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  composer.setSize(w, h);
  camera.aspect = w / h;
  // keep the brain centred in the space left of the side panel
  if (w > 760) camera.setViewOffset(w, h, 206, 0, w, h); else camera.clearViewOffset();
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

// ---------- textures ----------
function radialTexture(stops, size = 128) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [o, col] of stops) grad.addColorStop(o, col);
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const puffTex = radialTexture([[0, 'rgba(255,255,255,0.9)'], [0.35, 'rgba(255,255,255,0.45)'], [1, 'rgba(255,255,255,0)']]);
const glowTex = radialTexture([[0, 'rgba(255,255,255,1)'], [0.2, 'rgba(255,255,255,0.6)'], [1, 'rgba(255,255,255,0)']]);
const ringTex = radialTexture([[0, 'rgba(255,255,255,0)'], [0.7, 'rgba(255,255,255,0)'], [0.85, 'rgba(255,255,255,0.9)'], [1, 'rgba(255,255,255,0)']]);

// ---------- stars ----------
{
  const r = rng(7), pts = [];
  for (let i = 0; i < 1400; i++) {
    const v = new THREE.Vector3(r() - 0.5, r() - 0.5, r() - 0.5).normalize().multiplyScalar(90 + r() * 120);
    pts.push(v.x, v.y, v.z);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  scene.add(new THREE.Points(g, new THREE.PointsMaterial({ color: 0x6670a0, size: 0.6, sizeAttenuation: true, fog: false })));
}

// ---------- the brain cloud ----------
const cloud = new THREE.Group();
scene.add(cloud);
const puffs = [];
{
  const r = rng(42);
  for (let i = 0; i < 110; i++) {
    const m = new THREE.SpriteMaterial({ map: puffTex, color: new THREE.Color().setHSL(0.63 + r() * 0.06, 0.35, 0.42 + r() * 0.14),
      transparent: true, opacity: 0.025 + r() * 0.035, depthWrite: false });
    const s = new THREE.Sprite(m);
    // bias puffs toward the shell so the inside reads as space for memories
    const dir = new THREE.Vector3(r() - 0.5, r() - 0.5, r() - 0.5).normalize();
    const rad = 0.55 + Math.pow(r(), 0.5) * 0.55;
    s.position.set(dir.x * CLOUD.x * rad, dir.y * CLOUD.y * rad, dir.z * CLOUD.z * rad);
    const sc = 2.6 + r() * 3.6;
    s.scale.setScalar(sc);
    s.userData = { base: s.position.clone(), phase: r() * Math.PI * 2, speed: 0.15 + r() * 0.25, op: m.opacity };
    cloud.add(s);
    puffs.push(s);
  }
}
const core = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: 0x7f95ff, transparent: true, opacity: 0.12,
  depthWrite: false, blending: THREE.AdditiveBlending }));
core.scale.setScalar(9);
cloud.add(core);

// ---------- memory dots ----------
const dotGeo = new THREE.SphereGeometry(0.075, 12, 12);
const memories = new Map(); // id -> { mesh, halo, data, born, flash }
const memoryGroup = new THREE.Group();
cloud.add(memoryGroup);
const projectCenters = new Map();

function projectCenter(slug) {
  if (projectCenters.has(slug)) return projectCenters.get(slug);
  const r = rng(hash(slug));
  const v = new THREE.Vector3(r() - 0.5, (r() - 0.5) * 0.7, r() - 0.5).normalize().multiplyScalar(1.4 + r() * 1.2);
  projectCenters.set(slug, v);
  return v;
}

function memoryPosition(m) {
  const r = rng(hash(m.id));
  const c = projectCenter(m.project);
  for (let i = 0; i < 12; i++) {
    const p = new THREE.Vector3((r() - 0.5) * 3.4, (r() - 0.5) * 2.4, (r() - 0.5) * 3.4).add(c);
    const k = (p.x / CLOUD.x) ** 2 + (p.y / CLOUD.y) ** 2 + (p.z / CLOUD.z) ** 2;
    if (k < 0.62) return p;
  }
  return c.clone();
}

function addMemory(m, delay, big) {
  const color = TYPE_COLORS[m.type] ?? TYPE_COLORS.project;
  const mesh = new THREE.Mesh(dotGeo, new THREE.MeshBasicMaterial({ color }));
  mesh.position.copy(memoryPosition(m));
  mesh.scale.setScalar(0.0001);
  mesh.userData.kind = 'memory';
  mesh.userData.id = m.id;
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color, transparent: true, opacity: 0.55,
    depthWrite: false, blending: THREE.AdditiveBlending }));
  halo.scale.setScalar(0.0001);
  mesh.add(halo);
  const ring = new THREE.Sprite(new THREE.SpriteMaterial({ map: ringTex, color, transparent: true, opacity: 0,
    depthWrite: false, blending: THREE.AdditiveBlending }));
  mesh.add(ring);
  memoryGroup.add(mesh);
  memories.set(m.id, { mesh, halo, ring, data: m, born: performance.now() + delay, big, twinkle: Math.random() * 6 });
}

function removeMemory(id) {
  const e = memories.get(id);
  if (!e) return;
  memoryGroup.remove(e.mesh);
  e.mesh.material.dispose();
  memories.delete(id);
}

// ---------- employees (skills) ----------
const employees = new Map(); // id -> { root, body, sphere, eyes, label, data, ... }
const empGroup = new THREE.Group();
scene.add(empGroup);
const bodyGeo = new THREE.SphereGeometry(0.62, 40, 40);
const eyeGeo = new THREE.SphereGeometry(0.12, 16, 16);
const pupilGeo = new THREE.SphereGeometry(0.06, 12, 12);
const eyeMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.25 });
const pupilMat = new THREE.MeshBasicMaterial({ color: 0x11131c });

// Each employee gets a unique first name; oldest skills pick first so names stay stable.
const names = new Map();
function assignNames(skills) {
  const used = new Set(skills.filter(s => names.has(s.id)).map(s => names.get(s.id)));
  for (const s of [...skills].sort((a, b) => (a.created || 0) - (b.created || 0) || a.id.localeCompare(b.id))) {
    if (names.has(s.id)) continue;
    let i = hash(s.id) % FIRST_NAMES.length, n = 0, name;
    do { name = FIRST_NAMES[(i + n) % FIRST_NAMES.length] + (n >= FIRST_NAMES.length ? ' ' + (Math.floor(n / FIRST_NAMES.length) + 1) : ''); n++; }
    while (used.has(name));
    used.add(name);
    names.set(s.id, name);
  }
}
function employeeName(skill) {
  return names.get(skill.id) || FIRST_NAMES[hash(skill.id) % FIRST_NAMES.length];
}

function labelSprite(first, role, color) {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 128;
  const g = c.getContext('2d');
  g.textAlign = 'center';
  g.font = '600 46px system-ui, Segoe UI, sans-serif';
  g.fillStyle = '#e9ecff';
  g.fillText(first, 256, 52);
  g.font = '30px system-ui, Segoe UI, sans-serif';
  g.fillStyle = hex(color);
  g.fillText(role.length > 26 ? role.slice(0, 25) + '…' : role, 256, 98);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthWrite: false, opacity: 0.62 }));
  s.scale.set(3.2, 0.8, 1);
  s.position.y = 1.25;
  return s;
}

function addEmployee(skill, delay) {
  const color = SOURCE_COLORS[skill.source] ?? SOURCE_COLORS.plugin;
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.35, metalness: 0.1, emissive: color, emissiveIntensity: 0.08,
    transparent: skill.source === 'contractor', opacity: skill.source === 'contractor' ? 0.7 : 1 });
  const sphere = new THREE.Mesh(bodyGeo, mat);
  sphere.userData = { kind: 'employee', id: skill.id };
  body.add(sphere);
  const eyes = new THREE.Group();
  for (const x of [-0.2, 0.2]) {
    const eye = new THREE.Mesh(eyeGeo, eyeMat);
    eye.position.set(x, 0.12, 0.55);
    const pupil = new THREE.Mesh(pupilGeo, pupilMat);
    pupil.position.z = 0.08;
    eye.add(pupil);
    eyes.add(eye);
  }
  body.add(eyes);
  const label = labelSprite(employeeName(skill), skill.name, color);
  root.add(label);
  const aura = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color, transparent: true, opacity: 0,
    depthWrite: false, blending: THREE.AdditiveBlending }));
  aura.scale.setScalar(3.4);
  root.add(aura);
  // beam: a faint line plus sparks travelling from the brain to the employee
  const beamGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
  const beam = new THREE.Line(beamGeo, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0, depthWrite: false }));
  scene.add(beam);
  const sparks = [];
  for (let i = 0; i < 7; i++) {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color, transparent: true, opacity: 0,
      depthWrite: false, blending: THREE.AdditiveBlending }));
    sp.scale.setScalar(0.45);
    scene.add(sp);
    sparks.push(sp);
  }
  root.scale.setScalar(0.0001);
  empGroup.add(root);
  employees.set(skill.id, { root, body, sphere, eyes, label, aura, beam, sparks, data: skill, born: performance.now() + delay,
    slot: 0, busyAmt: 0, blinkAt: performance.now() + 1500 + Math.random() * 4000, phase: Math.random() * 6 });
}

function removeEmployee(id) {
  const e = employees.get(id);
  if (!e) return;
  empGroup.remove(e.root);
  scene.remove(e.beam);
  for (const s of e.sparks) scene.remove(s);
  employees.delete(id);
}

// Rings of up to 12 employees, alternating tilt.
function layoutEmployees() {
  const list = [...employees.values()].sort((a, b) =>
    (a.data.source === b.data.source ? 0 : a.data.source === 'project' ? -1 : b.data.source === 'project' ? 1 : a.data.source.localeCompare(b.data.source))
    || a.data.name.localeCompare(b.data.name));
  const perRing = 12;
  list.forEach((e, i) => {
    const ring = Math.floor(i / perRing);
    const inRing = Math.min(perRing, list.length - ring * perRing);
    e.ring = ring;
    e.angle0 = (i % perRing) / inRing * Math.PI * 2 + ring * 0.4;
    e.radius = 9.5 + ring * 2.6;
    e.tilt = (ring % 2 ? -1 : 1) * (0.16 + ring * 0.06);
  });
}

// ---------- state from server ----------
let state = { memories: [], skills: [], activity: [] };
let firstLoad = true;
let selected = null;

function matchSkill(name, skills) {
  return skills.find(s => s.invokeAs === name) || skills.find(s => s.name === name)
    || skills.find(s => s.name === name.split(':').pop());
}

// Turn the hook log into tasks, workloads and who is busy right now.
function deriveWork(activity, skills) {
  const sessions = new Map();
  const load = new Map();
  const contractors = new Map();
  const now = Date.now();
  for (const ev of activity) {
    let s = sessions.get(ev.session);
    if (ev.type === 'task' || !s) {
      s = { task: ev.type === 'task' ? ev.prompt : s?.task, skills: new Set(), open: true, last: ev.ts };
      sessions.set(ev.session, s);
    }
    s.last = ev.ts;
    if (ev.type === 'skill') {
      let sk = matchSkill(ev.skill, skills);
      if (!sk) {
        const id = 'contractor:' + ev.skill;
        sk = contractors.get(id) || { id, name: ev.skill.split(':').pop(), invokeAs: ev.skill, source: 'contractor',
          description: 'Built-in skill with no SKILL.md on this PC. Shows up when Claude calls it.' };
        contractors.set(id, sk);
      }
      s.skills.add(sk.id);
      load.set(sk.id, (load.get(sk.id) || 0) + 1);
    }
    if (ev.type === 'stop') s.open = false;
  }
  const busy = new Map(); // skill id -> task text
  for (const s of sessions.values()) {
    if (!s.open || now - s.last > BUSY_WINDOW_MS) continue;
    for (const id of s.skills) busy.set(id, s.task || 'working');
  }
  return { load, busy, contractors: [...contractors.values()] };
}

let work = { load: new Map(), busy: new Map(), contractors: [] };

let brainId = null;
function apply(next) {
  // switching brains: let the new cloud fill in dot by dot again
  if (next.brain && brainId && next.brain.id !== brainId) { firstLoad = true; selected = null; }
  brainId = next.brain?.id ?? brainId;
  const prevMemIds = new Set(memories.keys());
  const memSorted = [...next.memories].sort((a, b) => a.created - b.created);
  let i = 0;
  for (const m of memSorted) {
    if (memories.has(m.id)) { memories.get(m.id).data = m; prevMemIds.delete(m.id); continue; }
    // first load: the cloud starts empty and fills dot by dot
    addMemory(m, firstLoad ? 1400 + i++ * 110 : 0, !firstLoad);
    if (!firstLoad) pushFeed({ type: 'memory', text: `Memory saved: ${m.name}`, ts: Date.now() });
  }
  for (const id of prevMemIds) removeMemory(id);

  work = deriveWork(next.activity, next.skills);
  const allSkills = [...next.skills, ...work.contractors];
  for (const [id, n] of Object.entries(next.names || {})) names.set(id, n);
  assignNames(allSkills); // only contractors are still unnamed here
  const prevEmp = new Set(employees.keys());
  let j = 0;
  for (const s of allSkills) {
    if (employees.has(s.id)) { employees.get(s.id).data = s; prevEmp.delete(s.id); continue; }
    addEmployee(s, firstLoad ? 600 + j++ * 90 : 0);
    if (!firstLoad && s.source !== 'contractor') pushFeed({ type: 'skill', text: `New hire: ${employeeName(s)} (${s.name})`, ts: Date.now() });
  }
  for (const id of prevEmp) removeEmployee(id);
  layoutEmployees();

  state = { ...next, skills: allSkills };
  firstLoad = false;
  renderPanel();
}

// ---------- panel ----------
const liveFeed = [];
function pushFeed(ev) { liveFeed.push(ev); }

const SOURCE_TITLES = { personal: 'Your skills', project: 'ClaudeOS team', plugin: 'Plugin skills', contractor: 'Contractors (built-in)' };
function renderPanel() {
  document.getElementById('nMem').textContent = memories.size;
  document.getElementById('nEmp').textContent = state.skills.filter(s => s.source !== 'contractor').length;
  document.getElementById('nBusy').textContent = work.busy.size;

  const team = document.getElementById('team');
  const groups = ['project', 'personal', 'plugin', 'contractor'];
  let html = '';
  for (const g of groups) {
    const list = state.skills.filter(s => s.source === g)
      .sort((a, b) => (work.busy.has(b.id) - work.busy.has(a.id)) || ((work.load.get(b.id) || 0) - (work.load.get(a.id) || 0)) || a.name.localeCompare(b.name));
    if (!list.length) continue;
    html += `<div class="group">${SOURCE_TITLES[g]} · ${list.length}</div>`;
    for (const s of list) {
      const n = work.load.get(s.id) || 0;
      const busy = work.busy.has(s.id);
      html += `<div class="emp ${busy ? 'busy' : ''} ${selected === s.id ? 'sel' : ''}" data-id="${esc(s.id)}">
        <div class="dot" style="background:${hex(SOURCE_COLORS[s.source] ?? SOURCE_COLORS.plugin)}"></div>
        <div class="who">${esc(employeeName(s))}</div>
        <div class="load">${busy ? 'working' : n ? `${n} job${n > 1 ? 's' : ''}` : 'idle'}</div>
        <div class="role">${esc(s.name)}</div></div>`;
    }
  }
  if (!state.skills.length) html = '<div class="empty">No SKILL.md files found yet. Every skill you create appears here as a new employee.</div>';
  team.innerHTML = html;

  const feed = document.getElementById('feed');
  const evs = [
    ...state.activity.map(ev => {
      if (ev.type === 'task') return { type: 'task', text: ev.prompt ? `Task: ${ev.prompt}` : 'New task', ts: ev.ts };
      if (ev.type === 'skill') {
        const sk = matchSkill(ev.skill, state.skills);
        return { type: 'skill', text: `${sk ? employeeName(sk) : ev.skill} picked up work (${ev.skill})`, ts: ev.ts };
      }
      if (ev.type === 'stop') return { type: 'stop', text: 'Task finished', ts: ev.ts };
      return null;
    }).filter(Boolean),
    ...liveFeed,
  ].sort((a, b) => b.ts - a.ts).slice(0, 120);
  feed.innerHTML = evs.length
    ? evs.map(e => `<div class="ev ${e.type}"><time>${ago(e.ts)}</time>${esc(e.text)}</div>`).join('')
    : `<div class="empty">No work logged yet. Turn on the activity hook (see <code>README.md</code>) and every task Claude runs shows up here, with the skills it hands work to.</div>`;
  renderDetail();
}

function renderDetail() {
  const el = document.getElementById('detail');
  if (!selected) { el.classList.remove('on'); return; }
  const emp = employees.get(selected);
  const mem = memories.get(selected);
  if (emp) {
    const s = emp.data;
    const busy = work.busy.get(s.id);
    el.innerHTML = `<h3>${esc(employeeName(s))} · ${esc(s.name)}</h3>
      <div class="k">${esc(SOURCE_TITLES[s.source] || s.source)}${s.owner ? ' · ' + esc(s.owner) : ''} · ${work.load.get(s.id) || 0} jobs${busy ? ' · working on: ' + esc(busy) : ''}</div>
      <div>${esc(s.description)}</div>`;
  } else if (mem) {
    const m = mem.data;
    el.innerHTML = `<h3>${esc(m.name)}</h3><div class="k">${esc(m.type)} memory · ${esc(m.projectLabel)} · ${m.created ? new Date(m.created).toLocaleDateString() : ''}</div><div>${esc(m.description)}</div>`;
  } else { selected = null; el.classList.remove('on'); return; }
  el.classList.add('on');
}

document.querySelector('aside header').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  for (const x of document.querySelectorAll('aside header button')) x.setAttribute('aria-selected', String(x === b));
  for (const t of document.querySelectorAll('.tab')) t.classList.toggle('on', t.id === b.dataset.tab);
});
document.getElementById('team').addEventListener('click', e => {
  const row = e.target.closest('.emp');
  if (!row) return;
  selected = row.dataset.id;
  renderPanel();
});

// ---------- picking ----------
const ray = new THREE.Raycaster();
const mouse = new THREE.Vector2();
const tip = document.getElementById('tip');
let downAt = null;
function pick(ev) {
  mouse.set(ev.clientX / innerWidth * 2 - 1, -(ev.clientY / innerHeight) * 2 + 1);
  ray.setFromCamera(mouse, camera);
  const targets = [...[...employees.values()].map(e => e.sphere), ...[...memories.values()].map(m => m.mesh)];
  const hit = ray.intersectObjects(targets, false)[0];
  return hit?.object.userData;
}
canvas.addEventListener('pointermove', ev => {
  const u = pick(ev);
  if (!u) { tip.style.display = 'none'; canvas.style.cursor = ''; return; }
  canvas.style.cursor = 'pointer';
  let title, sub;
  if (u.kind === 'employee') { const s = employees.get(u.id).data; title = `${employeeName(s)} · ${s.name}`; sub = work.busy.get(s.id) ? 'Working on: ' + work.busy.get(s.id) : `${work.load.get(s.id) || 0} jobs done`; }
  else { const m = memories.get(u.id).data; title = m.name; sub = m.description; }
  tip.innerHTML = `<b>${esc(title)}</b><span>${esc(sub)}</span>`;
  tip.style.display = 'block';
  tip.style.left = Math.min(ev.clientX + 14, innerWidth - 300) + 'px';
  tip.style.top = ev.clientY + 14 + 'px';
});
canvas.addEventListener('pointerdown', ev => { downAt = [ev.clientX, ev.clientY]; });
canvas.addEventListener('pointerup', ev => {
  if (!downAt || Math.hypot(ev.clientX - downAt[0], ev.clientY - downAt[1]) > 5) return;
  const u = pick(ev);
  selected = u ? u.id : null;
  renderPanel();
});

// ---------- animation ----------
const clock = new THREE.Clock();
const tmp = new THREE.Vector3();
const brainWorld = new THREE.Vector3();
function animate() {
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = clock.elapsedTime;
  const now = performance.now();

  // cloud breathes; it brightens as the brain learns more
  const fill = Math.min(1, memories.size / 80);
  for (const p of puffs) {
    const u = p.userData;
    p.position.set(u.base.x + Math.sin(t * u.speed + u.phase) * 0.25, u.base.y + Math.cos(t * u.speed * 0.8 + u.phase) * 0.18, u.base.z);
    p.material.opacity = u.op * (0.85 + fill * 0.6);
  }
  cloud.rotation.y += dt * 0.03;
  core.material.opacity = 0.03 + fill * 0.08 + Math.sin(t * 1.3) * 0.01;
  brainLight.intensity = 14 + fill * 40 + work.busy.size * 8;

  for (const e of memories.values()) {
    const age = (now - e.born) / 1000;
    if (age < 0) continue;
    const k = Math.min(1, age / 0.8);
    const s = easeOutBack(k) * (1 + Math.sin(t * 2 + e.twinkle) * 0.12);
    e.mesh.scale.setScalar(Math.max(0.0001, s));
    e.halo.scale.setScalar(selected === e.data.id ? 1.6 : 0.9);
    const ringT = Math.min(1, age / (e.big ? 1.6 : 0.9));
    e.ring.scale.setScalar(0.3 + ringT * (e.big ? 9 : 3.5));
    e.ring.material.opacity = (1 - ringT) * (e.big ? 0.9 : 0.5);
  }

  cloud.updateMatrixWorld();
  brainWorld.set(0, 0, 0);
  for (const e of employees.values()) {
    const age = (now - e.born) / 1000;
    if (age < 0) continue;
    const busy = work.busy.has(e.data.id);
    e.busyAmt += ((busy ? 1 : 0) - e.busyAmt) * Math.min(1, dt * 3);
    const a = e.angle0 + t * 0.04;
    const r = e.radius - e.busyAmt * 2.4;
    tmp.set(Math.cos(a) * r, 0, Math.sin(a) * r);
    tmp.y = Math.sin(a) * r * e.tilt + Math.sin(t * (1.4 + e.busyAmt * 3) + e.phase) * (0.15 + e.busyAmt * 0.12);
    e.root.position.copy(tmp);
    const k = Math.min(1, age / 0.7);
    const sel = selected === e.data.id ? 1.18 : 1;
    e.root.scale.setScalar(Math.max(0.0001, easeOutBack(k) * sel));
    // idle employees look at you; busy ones look at the brain
    const look = busy ? brainWorld : camera.position;
    e.body.lookAt(look);
    if (now > e.blinkAt) { e.blinkAt = now + 2500 + Math.random() * 5000; e.blinkUntil = now + 140; }
    e.eyes.scale.y = now < (e.blinkUntil || 0) ? 0.1 : 1;
    e.sphere.material.emissiveIntensity = 0.08 + e.busyAmt * (0.6 + Math.sin(t * 6 + e.phase) * 0.25);
    e.aura.material.opacity = e.busyAmt * 0.35;
    e.label.material.opacity = 0.5 + e.busyAmt * 0.45 + (selected === e.data.id ? 0.3 : 0);

    const pos = e.beam.geometry.attributes.position;
    pos.setXYZ(1, tmp.x, tmp.y, tmp.z);
    pos.needsUpdate = true;
    e.beam.material.opacity = e.busyAmt * 0.35;
    e.beam.visible = e.busyAmt > 0.01;
    e.sparks.forEach((sp, i) => {
      const f = (t * 0.6 + i / e.sparks.length) % 1;
      sp.position.copy(tmp).multiplyScalar(f);
      sp.material.opacity = e.busyAmt * Math.sin(f * Math.PI) * 0.9;
    });
  }

  controls.update();
  composer.render();
  requestAnimationFrame(animate);
}
animate();

// ---------- live connection ----------
const conn = document.getElementById('conn');
function connect() {
  events.addEventListener('open', () => { conn.textContent = 'live'; });
  events.addEventListener('message', ev => { lastRaw = JSON.parse(ev.data); apply(lastRaw); });
  events.addEventListener('error', () => { conn.textContent = 'reconnecting…'; });
}
let lastRaw = null;
connect();
setInterval(() => lastRaw && apply(lastRaw), 30000); // keep "x min ago" and busy timeouts fresh
