// ClaudeOS front end: the brain cloud, memory dots, and skill "employees".
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { events } from '/events.js';
import { APPS, appForServer, normServer } from './apps.js';
import * as office from './office.js';

const TOKEN = window.CLAUDEOS_TOKEN;
async function api(path, body) {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', 'x-claudeos-token': TOKEN },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res.json().catch(() => ({ error: `HTTP ${res.status}` }));
}

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

// ---------- linked brains: small satellite clouds beside this one ----------
const satellites = new Map(); // brain id -> { group, glow, beam, dots: Map(memory id -> mesh), data }
const satDotGeo = new THREE.SphereGeometry(0.1, 10, 10);
const SAT_COLOR = 0xc9a7ff;
function syncSatellites(linked) {
  const keep = new Set();
  linked.forEach((b, i) => {
    keep.add(b.id);
    let sat = satellites.get(b.id);
    if (!sat) {
      const group = new THREE.Group();
      const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: puffTex, color: 0x8f86d8, transparent: true, opacity: 0.12, depthWrite: false }));
      glow.scale.setScalar(4.2);
      group.add(glow);
      const label = labelSprite(b.name, 'linked brain', SAT_COLOR);
      label.position.y = 2;
      group.add(label);
      const beam = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
        new THREE.LineBasicMaterial({ color: SAT_COLOR, transparent: true, opacity: 0, depthWrite: false }));
      scene.add(beam, group);
      sat = { group, glow, label, beam, dots: new Map(), phase: Math.random() * 6 };
      satellites.set(b.id, sat);
    }
    sat.data = b;
    const a = (i - (linked.length - 1) / 2) * 0.55; // fan out behind and above the brain
    sat.home = new THREE.Vector3(Math.sin(a) * 13, 6 + (i % 2) * 1.2, -Math.cos(a) * 13);
    const ids = new Set(b.memories.map(m => m.id));
    for (const [id, mesh] of sat.dots) if (!ids.has(id)) { sat.group.remove(mesh); sat.dots.delete(id); }
    for (const m of b.memories) {
      if (sat.dots.has(m.id)) { sat.dots.get(m.id).userData.memory = m; continue; }
      const r = rng(hash(m.id));
      const mesh = new THREE.Mesh(satDotGeo, new THREE.MeshBasicMaterial({ color: SAT_COLOR, transparent: true, opacity: 0.55 }));
      mesh.position.set((r() - 0.5) * 2.6, (r() - 0.5) * 1.8, (r() - 0.5) * 2.6);
      mesh.userData = { kind: 'linked', id: `linked:${b.id}|${m.id}`, brain: b, memory: m };
      sat.group.add(mesh);
      sat.dots.set(m.id, mesh);
    }
  });
  for (const [id, sat] of satellites) {
    if (keep.has(id)) continue;
    scene.remove(sat.group, sat.beam);
    satellites.delete(id);
  }
}
function linkedDot(sel) {
  if (!sel?.startsWith('linked:')) return null;
  const [brainId, memId] = sel.slice(7).split('|');
  return satellites.get(brainId)?.dots.get(memId) || null;
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

// ---------- each employee's workstation: desk, chair, keyboard and a monitor facing them ----------
// Built in the station's own frame: +z points from the employee to the brain.
const deskMat = new THREE.MeshStandardMaterial({ color: 0x3a3f58, roughness: 0.6, metalness: 0.15 });
const metalMat = new THREE.MeshStandardMaterial({ color: 0x1c2030, roughness: 0.4, metalness: 0.6 });
const chairMat = new THREE.MeshStandardMaterial({ color: 0x262a3c, roughness: 0.8 });
const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
const STATION = {
  top: box(2.1, 0.08, 0.95), leg: box(0.07, 0.95, 0.07), kb: box(0.8, 0.04, 0.26),
  bezel: box(1.12, 0.74, 0.06), neck: box(0.08, 0.42, 0.08), foot: box(0.42, 0.03, 0.26),
  seat: box(0.85, 0.09, 0.75), back: box(0.85, 0.55, 0.08), post: box(0.08, 0.5, 0.08),
  screen: new THREE.PlaneGeometry(1.02, 0.64),
  cabinet: box(0.55, 0.9, 0.7), drawer: box(0.47, 0.03, 0.02), handle: box(0.16, 0.035, 0.04),
};
const cabinetMat = new THREE.MeshStandardMaterial({ color: 0x4a5070, roughness: 0.5, metalness: 0.35 });
function stationMesh(geo, mat, x, y, z, parent) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  parent.add(m);
  return m;
}
// withCabinet: an employee's file cabinet beside the desk (the Manager has none)
function buildStation(color, withCabinet) {
  const g = new THREE.Group();
  const deskY = -0.38, deskZ = 1.0;
  stationMesh(STATION.top, deskMat, 0, deskY, deskZ, g);
  for (const x of [-0.98, 0.98]) for (const z of [0.6, 1.4]) stationMesh(STATION.leg, metalMat, x, deskY - 0.51, z, g);
  stationMesh(STATION.kb, metalMat, 0, deskY + 0.06, 0.7, g);
  stationMesh(STATION.foot, metalMat, 0, deskY + 0.055, 1.25, g);
  stationMesh(STATION.neck, metalMat, 0, deskY + 0.25, 1.3, g);
  stationMesh(STATION.bezel, metalMat, 0, deskY + 0.74, 1.32, g);
  // the screen faces the employee; its picture is a canvas redrawn while they work
  const c = document.createElement('canvas');
  c.width = 256; c.height = 160;
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const screen = stationMesh(STATION.screen, new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }), 0, deskY + 0.74, 1.285, g);
  screen.rotation.y = Math.PI;
  screen.userData = { canvas: c, color, drawnAt: 0, busy: null };
  // a low chair behind the employee, so it doesn't hide them from the back
  stationMesh(STATION.seat, chairMat, 0, -0.78, -0.05, g);
  stationMesh(STATION.back, chairMat, 0, -0.45, -0.48, g);
  stationMesh(STATION.post, metalMat, 0, -1.08, -0.05, g);
  let cabinet = null;
  if (withCabinet) {
    // two drawers, their fronts toward the chair; a stripe in the employee's colour on each
    cabinet = stationMesh(STATION.cabinet, cabinetMat, 1.5, -0.88, 0.75, g);
    const stripe = new THREE.MeshBasicMaterial({ color, toneMapped: false });
    for (const y of [0.2, -0.2]) {
      const dz = -0.36;
      stationMesh(STATION.drawer, metalMat, 0, y + 0.19, dz, cabinet);
      stationMesh(STATION.handle, stripe, 0, y, dz, cabinet);
    }
  }
  return { station: g, screen, cabinet };
}
// Idle: a calm screensaver. Busy: lines of code scrolling in the employee's colour.
function drawScreen(screen, busy, t) {
  const u = screen.userData, c = u.canvas, g = c.getContext('2d');
  const col = hex(u.color);
  g.fillStyle = '#0b0e1c';
  g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = col;
  g.globalAlpha = busy ? 0.9 : 0.35;
  g.fillRect(0, 0, c.width, 14);
  if (busy) {
    const scroll = Math.floor(t * 9);
    for (let i = 0; i < 11; i++) {
      const n = scroll + i, r = rng(n * 7919 + 1); r();
      const indent = Math.floor(r() * 4) * 14, w = 30 + r() * 150;
      g.globalAlpha = 0.45 + r() * 0.5;
      g.fillStyle = r() < 0.3 ? col : r() < 0.5 ? '#9aa3d6' : '#e9ecff';
      g.fillRect(12 + indent, 22 + i * 12.5, Math.min(w, c.width - 24 - indent), 6);
    }
    if (Math.floor(t * 2) % 2) { g.globalAlpha = 1; g.fillStyle = '#e9ecff'; g.fillRect(12, 22 + 10 * 12.5, 8, 8); }
  } else {
    g.globalAlpha = 0.5;
    g.fillStyle = col;
    g.beginPath();
    g.arc(c.width / 2 + Math.sin(t * 0.5) * 60, 88 + Math.cos(t * 0.7) * 30, 12, 0, Math.PI * 2);
    g.fill();
  }
  g.globalAlpha = 1;
  screen.material.map.needsUpdate = true;
}

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
  s.position.y = 1.55;
  return s;
}

// The task a busy employee is on, floating over its head.
function bubbleSprite() {
  const c = document.createElement('canvas');
  c.width = 640; c.height = 96;
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthWrite: false, opacity: 0 }));
  s.scale.set(4, 0.6, 1);
  s.position.y = 2.25;
  s.userData = { canvas: c, text: null };
  return s;
}
function setBubble(s, text, color) {
  if (s.userData.text === text) return;
  s.userData.text = text;
  const c = s.userData.canvas, g = c.getContext('2d');
  g.clearRect(0, 0, c.width, c.height);
  g.font = '500 34px system-ui, Segoe UI, sans-serif';
  const label = text.length > 38 ? text.slice(0, 37) + '…' : text;
  const w = Math.min(c.width - 8, g.measureText(label).width + 44);
  const x = (c.width - w) / 2;
  g.fillStyle = 'rgba(14,17,30,0.88)';
  g.strokeStyle = hex(color);
  g.lineWidth = 3;
  g.beginPath();
  g.roundRect(x, 8, w, 64, 20);
  g.moveTo(c.width / 2 - 10, 72); g.lineTo(c.width / 2, 88); g.lineTo(c.width / 2 + 10, 72);
  g.fill(); g.stroke();
  g.fillStyle = '#e9ecff';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(label, c.width / 2, 41);
  s.material.map.needsUpdate = true;
}

// ---------- apps an employee is connected to ----------
// From its SKILL.md (integration tools it calls, or apps it names) and from the integrations
// (MCP servers) it really used in its runs. Each is matched to the integrations Claude has here.
const OWN_SERVERS = /^(memory|claudeos|brain_\d+)$/;
function appsOf(s) {
  const by = new Map();
  for (const a of s.apps || []) if (!OWN_SERVERS.test(a.key.replace(/^mcp:/, ''))) by.set(a.key, { key: a.key, why: a.why, runs: 0 });
  for (const r of work.runs.get(s.id) || []) {
    for (const server of r.bySkill[r.calledAs[s.id]]?.mcp || []) {
      if (OWN_SERVERS.test(server)) continue;
      const key = appForServer(server) || 'mcp:' + server;
      const a = by.get(key) || { key, why: 'used', runs: 0 };
      a.runs++;
      by.set(key, a);
    }
  }
  return [...by.values()].map(a => {
    const server = a.key.startsWith('mcp:') ? a.key.slice(4) : null;
    const integ = (state.integrations || []).find(i => server ? normServer(i.server) === normServer(server) : i.key === a.key);
    const app = APPS[a.key];
    return { ...a, title: app?.title || integ?.server || server || a.key, hex: app?.hex || '8a8fa8', path: app?.path || null,
      status: integ ? integ.status : 'not set up', server: integ?.server || server };
  }).sort((x, y) => (y.status === 'connected') - (x.status === 'connected') || y.runs - x.runs || x.title.localeCompare(y.title));
}
function appBadge(a) {
  const tip = `${a.title} · ${a.runs ? `used in ${a.runs} run${a.runs > 1 ? 's' : ''}` : a.why === 'tools' ? 'its SKILL.md calls it' : 'named in its SKILL.md'} · ${a.status}`;
  const inner = a.path ? `<svg viewBox="0 0 24 24"><path fill="#${a.hex}" d="${a.path}"/></svg>` : esc(a.title[0].toUpperCase());
  return `<span class="app ${a.status === 'connected' ? '' : 'off'}" title="${esc(tip)}" style="${a.path ? '' : `background:#${a.hex}`}">${inner}</span>`;
}

// the same logos as a strip under the employee's sphere
function appsSprite() {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 80;
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthWrite: false, opacity: 0.9 }));
  s.scale.set(4.2, 0.66, 1);
  s.position.y = -1.85;
  s.userData = { canvas: c, key: null };
  return s;
}
function drawApps(sprite, apps) {
  const shown = apps.slice(0, 6);
  const key = shown.map(a => a.key + a.status).join();
  if (sprite.userData.key === key) return;
  sprite.userData.key = key;
  const c = sprite.userData.canvas, g = c.getContext('2d');
  g.clearRect(0, 0, c.width, c.height);
  const size = 64, gap = 12, x0 = (c.width - (shown.length * size + (shown.length - 1) * gap)) / 2;
  shown.forEach((a, i) => {
    const x = x0 + i * (size + gap), cx = x + size / 2, cy = c.height / 2;
    g.globalAlpha = a.status === 'connected' ? 1 : 0.55;
    g.fillStyle = a.path ? '#f4f5fb' : '#' + a.hex;
    g.beginPath(); g.arc(cx, cy, size / 2, 0, Math.PI * 2); g.fill();
    if (a.path) {
      g.save();
      g.translate(cx - 20, cy - 20); g.scale(40 / 24, 40 / 24);
      g.fillStyle = '#' + a.hex;
      g.fill(new Path2D(a.path));
      g.restore();
    } else {
      g.fillStyle = '#fff'; g.font = '700 34px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(a.title[0].toUpperCase(), cx, cy + 2);
    }
  });
  g.globalAlpha = 1;
  sprite.material.map.needsUpdate = true;
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
  const bubble = bubbleSprite();
  root.add(bubble);
  const appStrip = appsSprite();
  root.add(appStrip);
  const aura = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color, transparent: true, opacity: 0,
    depthWrite: false, blending: THREE.AdditiveBlending }));
  aura.scale.setScalar(3.4);
  root.add(aura);
  const { station, screen, cabinet } = buildStation(color, skill.source !== 'contractor');
  root.add(station);
  // the monitor opens their computer (activity and logs), the cabinet their files
  screen.userData.kind = 'employee';
  screen.userData.id = skill.id;
  screen.userData.view = 'computer';
  if (cabinet) cabinet.userData = { kind: 'employee', id: skill.id, view: 'cabinet' };
  drawScreen(screen, false, 0);
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
  employees.set(skill.id, { root, body, sphere, eyes, label, bubble, appStrip, color, aura, beam, sparks, station, screen, cabinet, data: skill, born: performance.now() + delay,
    slot: 0, busyAmt: 0, blinkAt: performance.now() + 1500 + Math.random() * 4000, phase: Math.random() * 6 });
}

// ---------- the Manager: a bigger desk in front of the brain, facing the team and you ----------
// The Manager is the chat: it types while it answers in the Chat tab, and its briefs split the work
// between the employees (manager.mjs).
const MANAGER_COLOR = 0xf2c14e;
let managerState = { inbox: [], files: [], briefs: [], busy: false, chatting: false };
const boss = (() => {
  const root = new THREE.Group(), body = new THREE.Group();
  root.add(body);
  const sphere = new THREE.Mesh(bodyGeo, new THREE.MeshStandardMaterial({ color: MANAGER_COLOR, roughness: 0.3, metalness: 0.25,
    emissive: MANAGER_COLOR, emissiveIntensity: 0.1 }));
  sphere.userData = { kind: 'manager' };
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
  const label = labelSprite('Manager', 'briefs & splits the work', MANAGER_COLOR);
  const bubble = bubbleSprite();
  const { station, screen } = buildStation(MANAGER_COLOR);
  screen.userData.kind = 'manager';
  drawScreen(screen, false, 0);
  root.add(label, bubble, station);
  // station +z (its desk) points at the camera side, so the Manager faces the room
  root.position.set(0, -0.4, 5.2);
  root.scale.setScalar(1.1);
  scene.add(root);
  return { root, body, sphere, eyes, label, bubble, screen, busyAmt: 0, phase: 1.3, blinkAt: 0 };
})();
function bossBrief() { return managerState.briefs.find(b => b.status === 'working'); }
function bossLine() {
  const b = bossBrief();
  if (managerState.chatting) return 'Answering you in Chat…';
  if (b) return `${b.title} · ${b.tasks.filter(t => t.status === 'done').length}/${b.tasks.length} done`;
  const waiting = managerState.inbox.filter(x => x.status === 'new').length + managerState.files.length;
  return waiting ? `${waiting} queued for the team` : '';
}
let managerSeen = false;
function setManager(next) {
  managerState = next;
  // hand-offs that happened before the page opened aren't replayed
  handoffVisits(next.briefs || [], managerSeen);
  managerSeen = true;
  work = withBriefWork(hookWork);
  renderPanel();
}
events.addEventListener('manager', e => setManager(JSON.parse(e.data)));
// talking in the Chat tab is talking to the Manager
events.addEventListener('chat', e => { const ev = JSON.parse(e.data); if (ev.kind === 'busy') managerState = { ...managerState, chatting: !!ev.any }; });
async function loadManager() { const r = await api('/api/manager'); if (!r.error) setManager(r); }
events.addEventListener('open', loadManager);
events.addEventListener('brain', loadManager);

function removeEmployee(id) {
  const e = employees.get(id);
  if (!e) return;
  empGroup.remove(e.root);
  scene.remove(e.beam);
  for (const s of e.sparks) scene.remove(s);
  employees.delete(id);
}

// ---------- the building: each department is a glass room round the brain, all desks facing it ----------
// Employees with no department work on the Lobby's open floor: rings outside the rooms, each a step
// higher (with no departments at all, that's the whole office, as before).
const building = new THREE.Group();
scene.add(building);
const FLOOR_Y = -2.0, DESK_X = 3.3, DESK_Z = 3.0;
const ENTRANCE = 0.55; // the gap in the ring of rooms, in front of the Manager's desk
const rooms = new Map(); // dept id -> { group, center, pickables }
let roomsKey = '', ground = null;
const sourceOrder = (a, b) => (a.data.source === b.data.source ? 0 : a.data.source === 'project' ? -1 : b.data.source === 'project' ? 1 : a.data.source.localeCompare(b.data.source))
  || a.data.name.localeCompare(b.data.name);
function layoutEmployees(org) {
  const depts = org?.departments || [];
  const where = new Map();
  for (const d of depts) for (const id of d.employees) where.set(id, d.id);
  const all = [...employees.values()].sort(sourceOrder);
  const plan = depts.map(d => {
    const members = all.filter(e => where.get(e.data.id) === d.id && e.data.source !== 'contractor');
    const n = members.length, cols = Math.max(2, Math.ceil(Math.sqrt(n * 1.5))), rows = Math.max(1, Math.ceil(n / cols));
    return { d, members, cols, rows, w: cols * DESK_X + 1.6, depth: rows * DESK_Z + 1.4 };
  });
  // the rooms' fronts sit on one circle, big enough for all of them; the set is centred at the back
  const spanAt = (p, r) => 2 * Math.atan((p.w / 2 + 0.8) / r);
  let r0 = 9;
  while (plan.reduce((s, p) => s + spanAt(p, r0), 0) > Math.PI * 2 - ENTRANCE && r0 < 80) r0 += 0.5;
  let a = Math.PI * 1.5 - plan.reduce((s, p) => s + spanAt(p, r0), 0) / 2;
  for (const p of plan) {
    const span = spanAt(p, r0);
    p.angle = a + span / 2;
    a += span;
    p.r = r0 + p.depth / 2;
    p.cx = Math.cos(p.angle) * p.r;
    p.cz = Math.sin(p.angle) * p.r;
    const th = p.facing = Math.atan2(-p.cx, -p.cz); // the room's +z points at the brain
    p.members.forEach((e, i) => {
      const col = i % p.cols, row = Math.floor(i / p.cols), inRow = Math.min(p.cols, p.members.length - row * p.cols);
      const lx = (col - (inRow - 1) / 2) * DESK_X, lz = ((p.rows - 1) / 2 - row) * DESK_Z - 0.3;
      e.home = new THREE.Vector3(p.cx + lx * Math.cos(th) + lz * Math.sin(th), -0.6, p.cz - lx * Math.sin(th) + lz * Math.cos(th));
      e.facing = th;
      e.dept = p.d.id;
    });
  }
  const outer = plan.length ? Math.max(...plan.map(p => p.r + p.depth / 2)) + 2.5 : 9.5;
  const lobby = all.filter(e => !plan.some(p => p.members.includes(e)));
  for (let i = 0, ring = 0; i < lobby.length; ring++) {
    const radius = outer + ring * 3.2;
    const per = plan.length ? Math.max(12, Math.floor(Math.PI * 2 * radius / 3.4)) : 12;
    const inRing = Math.min(per, lobby.length - i);
    for (let k = 0; k < inRing; k++, i++) {
      const e = lobby[i], ang = k / inRing * Math.PI * 2 + ring * 0.4;
      e.home = new THREE.Vector3(Math.cos(ang) * radius, -0.6 + ring * 1.1 + (plan.length ? 0.6 : 0), Math.sin(ang) * radius);
      e.facing = Math.atan2(-e.home.x, -e.home.z);
      e.dept = '';
    }
  }
  const key = JSON.stringify(plan.map(p => [p.d.id, p.d.name, p.d.color, p.w, p.depth, p.angle.toFixed(3), p.members.length,
    p.d.projects.filter(x => x.status === 'active').map(x => x.name)]));
  if (key !== roomsKey) { roomsKey = key; buildRooms(plan, outer); }
}

function disposeTree(o) {
  o.traverse(x => { x.geometry?.dispose(); x.material?.map?.dispose(); x.material?.dispose(); });
}
function buildRooms(plan, outer) {
  for (const r of rooms.values()) { building.remove(r.group); disposeTree(r.group); }
  rooms.clear();
  if (ground) { building.remove(ground); disposeTree(ground); ground = null; }
  if (!plan.length) return;
  // the building's floor: a dark disc with a faint polar grid
  ground = new THREE.Group();
  const disc = new THREE.Mesh(new THREE.CircleGeometry(outer - 0.8, 96), new THREE.MeshStandardMaterial({ color: 0x0b0e1c, roughness: 0.9, transparent: true, opacity: 0.85 }));
  disc.rotation.x = -Math.PI / 2;
  const grid = new THREE.PolarGridHelper(outer - 0.8, 16, 6, 96, 0x2a3156, 0x1a1f38);
  grid.position.y = 0.01;
  for (const m of [grid.material].flat()) { m.transparent = true; m.opacity = 0.5; }
  const rim = new THREE.Mesh(new THREE.TorusGeometry(outer - 0.8, 0.05, 6, 160), new THREE.MeshBasicMaterial({ color: 0x5a64a8, transparent: true, opacity: 0.6 }));
  rim.rotation.x = Math.PI / 2;
  ground.add(disc, grid, rim);
  ground.position.y = FLOOR_Y - 0.03;
  building.add(ground);
  for (const p of plan) {
    const col = new THREE.Color(p.d.color), g = new THREE.Group();
    g.position.set(p.cx, FLOOR_Y, p.cz);
    g.rotation.y = p.facing;
    const pickId = 'dept:' + p.d.id;
    const floor = new THREE.Mesh(new THREE.BoxGeometry(p.w, 0.05, p.depth), new THREE.MeshStandardMaterial({ color: col, emissive: col, emissiveIntensity: 0.25,
      transparent: true, opacity: 0.16, depthWrite: false }));
    floor.userData = { kind: 'dept', id: pickId };
    const H = 2.4;
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(p.w, H, p.depth)), new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: 0.4 }));
    edges.position.y = H / 2;
    // glass on three sides; the side facing the brain stays open
    const glass = new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.05, side: THREE.DoubleSide, depthWrite: false });
    const back = new THREE.Mesh(new THREE.PlaneGeometry(p.w, H), glass);
    back.position.set(0, H / 2, -p.depth / 2);
    g.add(floor, edges, back);
    for (const x of [-p.w / 2, p.w / 2]) {
      const side = new THREE.Mesh(new THREE.PlaneGeometry(p.depth, H), glass);
      side.position.set(x, H / 2, 0);
      side.rotation.y = Math.PI / 2;
      g.add(side);
    }
    const sign = roomSign(p);
    sign.position.set(0, H + 1.1, -p.depth / 2);
    sign.userData = { kind: 'dept', id: pickId };
    g.add(sign);
    building.add(g);
    rooms.set(p.d.id, { group: g, center: new THREE.Vector3(p.cx, -0.5, p.cz), pickables: [floor, sign], color: col });
  }
}
// the name over a room's back wall, with its active projects
function roomSign(p) {
  const projects = p.d.projects.filter(x => x.status === 'active');
  const c = document.createElement('canvas');
  c.width = 512; c.height = 220;
  const g = c.getContext('2d');
  g.textAlign = 'center';
  g.font = '700 54px system-ui, Segoe UI, sans-serif';
  g.fillStyle = p.d.color;
  g.fillText(p.d.name.length > 18 ? p.d.name.slice(0, 17) + '…' : p.d.name, 256, 58);
  g.font = '28px system-ui, Segoe UI, sans-serif';
  g.fillStyle = '#8c93b8';
  const n = p.members.length;
  g.fillText(`${n} ${n === 1 ? 'person' : 'people'} · ${projects.length} project${projects.length === 1 ? '' : 's'}`, 256, 98);
  g.font = '500 30px system-ui, Segoe UI, sans-serif';
  g.fillStyle = '#e9ecff';
  projects.slice(0, 3).forEach((x, i) => g.fillText('▸ ' + (x.name.length > 26 ? x.name.slice(0, 25) + '…' : x.name), 256, 142 + i * 36));
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthWrite: false, opacity: 0.85 }));
  s.scale.set(4.6, 1.98, 1);
  return s;
}

// ---------- colleagues stopping by ----------
// Now and then an idle employee floats over to a colleague's desk for a chat: mostly someone in their own
// department, sometimes a neighbouring one; on the Lobby's open floor, the people nearby. When a brief's
// task starts on another's output, the one who finished walks over to hand it over.
const MAX_VISITS = 3;
function startVisit(e, host, reason) {
  if (!e || !host || e === host || e.visit) return;
  const dist = e.home.distanceTo(host.home);
  e.visit = { to: host.data.id, start: performance.now(), walk: 1.2 + dist / 10, stay: reason === 'handoff' ? 4.5 : 3 + Math.random() * 4, reason };
}
function planVisits() {
  const now = performance.now(), list = [...employees.values()];
  if (list.filter(e => e.visit).length >= MAX_VISITS) return;
  const people = list.filter(e => e.data.source !== 'contractor' && e.home && now - e.born > 3000);
  for (const e of people) {
    if (e.visit || work.busy.has(e.data.id)) continue;
    if (Math.random() > (e.dept ? 1 / 60 : 1 / 600)) continue;
    const near = pool => pool.sort((x, y) => x.home.distanceTo(e.home) - y.home.distanceTo(e.home)).slice(0, 4);
    const same = people.filter(o => o !== e && o.dept === e.dept && !o.visit);
    const others = near(people.filter(o => o !== e && o.dept !== e.dept && !o.visit));
    const pool = same.length && (Math.random() < 0.85 || !others.length) ? (e.dept ? same : near(same)) : others;
    if (!pool.length) continue;
    return startVisit(e, pool[Math.floor(Math.random() * pool.length)], 'chat');
  }
}
setInterval(planVisits, 1000);
const empBySkill = name => [...employees.values()].find(e => e.data.source === 'project' && e.data.name === name);
const handoffsSeen = new Set();
function handoffVisits(briefs, replay) {
  for (const b of briefs) for (const t of b.tasks) {
    if (t.status !== 'working' || !t.after?.length) continue;
    for (const dep of b.tasks.filter(x => t.after.includes(x.id))) {
      const k = `${b.id}:${dep.id}>${t.id}`;
      if (handoffsSeen.has(k)) continue;
      handoffsSeen.add(k);
      if (replay && Date.now() - t.start < 30000) startVisit(empBySkill(dep.employee), empBySkill(t.employee), 'handoff');
    }
  }
}

// ---------- state from server ----------
let state = { memories: [], skills: [], activity: [] };
let firstLoad = true;
let selected = null;

function matchSkill(name, skills) {
  return skills.find(s => s.invokeAs === name) || skills.find(s => s.name === name)
    || skills.find(s => s.name === name.split(':').pop());
}

// Turn the hook log into tasks (one per prompt), each employee's runs, and who is busy right now.
// A task runs from its prompt to its stop; every skill handed work in between ran in it.
function deriveWork(activity, skills) {
  const open = new Map();   // session -> its task still running
  const latest = new Map(); // session -> its newest task
  const tasks = [];
  const load = new Map();
  const contractors = new Map();
  const now = Date.now();
  for (const ev of activity) {
    let task = open.get(ev.session);
    if (ev.type === 'stop' && !task) {
      // the chat's own stop/error note lands just after the hook's stop: it has the better story
      const prev = latest.get(ev.session);
      if (prev && ev.outcome && ev.outcome !== 'done' && ev.ts - prev.end < 60000) Object.assign(prev, { outcome: ev.outcome, result: ev.result || prev.result });
      continue;
    }
    if (ev.type === 'task' || !task) {
      task = { key: `${ev.session}:${ev.ts}`, prompt: ev.type === 'task' ? ev.prompt : '', start: ev.ts, last: ev.ts, end: 0,
        outcome: '', result: '', files: [], tools: 0, bySkill: {}, skills: [], calledAs: {} };
      tasks.push(task);
      open.set(ev.session, task);
      latest.set(ev.session, task);
    }
    task.last = ev.ts;
    if (ev.type === 'skill') {
      let sk = matchSkill(ev.skill, skills);
      if (!sk) {
        const id = 'contractor:' + ev.skill;
        sk = contractors.get(id) || { id, name: ev.skill.split(':').pop(), invokeAs: ev.skill, source: 'contractor',
          description: 'Built-in skill with no SKILL.md on this PC. Shows up when Claude calls it.' };
        contractors.set(id, sk);
      }
      if (!task.skills.includes(sk.id)) task.skills.push(sk.id);
      task.calledAs[sk.id] = ev.skill;
      load.set(sk.id, (load.get(sk.id) || 0) + 1);
    }
    if (ev.type === 'stop') {
      Object.assign(task, { end: ev.ts, outcome: ev.outcome || 'done', result: ev.result || '', files: ev.files || [], tools: ev.tools || 0, bySkill: ev.bySkill || {} });
      open.delete(ev.session);
    }
  }
  const busy = new Map(); // skill id -> the task it is on
  const runs = new Map(); // skill id -> its tasks, newest first
  for (const t of tasks.reverse()) {
    t.status = t.end ? t.outcome : now - t.last > BUSY_WINDOW_MS ? 'unfinished' : 'working';
    for (const id of t.skills) {
      if (t.status === 'working' && !busy.has(id)) busy.set(id, t);
      if (!runs.has(id)) runs.set(id, []);
      runs.get(id).push(t);
    }
  }
  return { load, busy, runs, contractors: [...contractors.values()] };
}

let work = { load: new Map(), busy: new Map(), runs: new Map(), contractors: [] };
let hookWork = work;
// Employees working the Manager's brief are busy even in a brain whose activity hook isn't set up:
// the brief itself says who is on what.
function withBriefWork(base) {
  const brief = managerState.briefs.find(b => b.status === 'working');
  if (!brief) return base;
  const busy = new Map(base.busy);
  for (const t of brief.tasks) {
    if (t.status !== 'working') continue;
    const s = state.skills.find(x => x.source === 'project' && x.name === t.employee);
    if (s && !busy.has(s.id)) busy.set(s.id, { prompt: t.task.split('\n')[0], start: t.start, last: t.start, skills: [s.id], status: 'working' });
  }
  return { ...base, busy };
}

function duration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60 ? (s % 60) + 's' : ''}`.trim();
  return `${Math.floor(s / 3600)}h ${Math.floor(s / 60) % 60}m`;
}
const STATUS_TEXT = { working: 'working', done: 'done', stopped: 'stopped', error: 'failed', unfinished: 'no finish logged' };

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

  syncSatellites(next.linked || []);
  hookWork = deriveWork(next.activity, next.skills);
  work = withBriefWork(hookWork);
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
  layoutEmployees(next.org);

  state = { ...next, skills: allSkills };
  for (const e of employees.values()) drawApps(e.appStrip, appsOf(e.data));
  firstLoad = false;
  if (selectWhenHired && employees.has(selectWhenHired)) { selected = selectWhenHired; selectWhenHired = null; }
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

  const team = document.getElementById('teamList'); // the briefs (queue.js) are on the Activity tab
  const groups = ['project', 'personal', 'plugin', 'contractor'];
  let html = state.brain ? `<div class="team-acts"><button class="btn" data-hire title="Write a new SKILL.md in ${esc(state.brain.name)}/.claude/skills">+ Hire</button><button class="btn" data-newdept title="A room in the building for a group of employees and their projects">+ Department</button></div>` : '';
  const byWork = (a, b) => (work.busy.has(b.id) - work.busy.has(a.id)) || ((work.load.get(b.id) || 0) - (work.load.get(a.id) || 0)) || a.name.localeCompare(b.name);
  const row = s => {
    const n = work.load.get(s.id) || 0;
    const busy = work.busy.get(s.id);
    const lastRun = work.runs.get(s.id)?.[0];
    const now = busy ? `<div class="now working">${esc(busy.prompt || 'working')}</div>`
      : lastRun ? `<div class="now ${lastRun.status}">${esc(lastRun.prompt || 'a task')} · ${ago(lastRun.end || lastRun.last)}</div>` : '';
    return `<div class="emp ${busy ? 'busy' : ''} ${selected === s.id ? 'sel' : ''}" data-id="${esc(s.id)}"${s.source !== 'contractor' ? ' draggable="true"' : ''}>
      <div class="dot" style="background:${hex(SOURCE_COLORS[s.source] ?? SOURCE_COLORS.plugin)}"></div>
      <div class="who">${esc(employeeName(s))}${appsOf(s).slice(0, 5).map(appBadge).join('')}</div>
      <div class="load">${busy ? 'working' : n ? `${n} job${n > 1 ? 's' : ''}` : 'idle'}</div>
      <div class="role">${esc(s.name)}</div>${now}</div>`;
  };
  // the building: each department with its people, then the Lobby (everyone else, by where their skill lives)
  const depts = state.org?.departments || [];
  const placed = new Set(depts.flatMap(d => d.employees));
  for (const d of depts) {
    const list = state.skills.filter(s => d.employees.includes(s.id)).sort(byWork);
    const projects = d.projects.filter(p => p.status === 'active').length;
    html += `<div class="group dept ${selected === 'dept:' + d.id ? 'sel' : ''}" data-dept="${esc(d.id)}" data-drop="${esc(d.id)}" title="Open the ${esc(d.name)} department">
      <i style="background:${esc(d.color)}"></i>${esc(d.name)} · ${list.length}${projects ? ` · ${projects} project${projects > 1 ? 's' : ''}` : ''}</div>`;
    if (!list.length) html += `<div class="empty drop" data-drop="${esc(d.id)}">Drag people here, or pick this department on their board.</div>`;
    html += list.map(row).join('');
  }
  for (const g of groups) {
    const list = state.skills.filter(s => s.source === g && !placed.has(s.id)).sort(byWork);
    if (!list.length) continue;
    html += `<div class="group" data-drop="">${depts.length ? 'Lobby · ' : ''}${SOURCE_TITLES[g]} · ${list.length}</div>`;
    html += list.map(row).join('');
  }
  // the teams of linked brains: copy a skill over to hire the same employee here
  const have = new Set(state.skills.filter(s => s.source === 'project').map(s => s.name));
  for (const b of state.linked || []) {
    html += `<div class="group">From ${esc(b.name)} · ${b.skills.length}</div>`;
    if (!b.skills.length) html += `<div class="empty">${esc(b.name)} has no team of its own yet.</div>`;
    for (const s of [...b.skills].sort((x, y) => x.name.localeCompare(y.name))) {
      html += `<div class="lskill"><div class="dot" style="background:${hex(SOURCE_COLORS.project)}"></div>
        <div><b>${esc(s.name)}</b><span>${esc(s.description)}</span></div>
        ${have.has(s.name) ? '<em>on your team</em>' : `<button class="btn" data-copy="${esc(s.name)}" data-from="${esc(b.id)}" title="Copy .claude/skills/${esc(s.folder)} into ${esc(state.brain?.name || 'this brain')}">Copy</button>`}</div>`;
    }
  }
  renderMemList();
  if (!state.skills.length && !state.linked?.length) html += '<div class="empty">No SKILL.md files found yet. Hire someone above, or ask Claude to write a skill. Every skill appears here as a new employee.</div>';
  team.innerHTML = html;

  const feed = document.getElementById('feedList');
  const evs = [
    ...state.activity.map(ev => {
      if (ev.type === 'task') return { type: 'task', text: ev.prompt ? `Task: ${ev.prompt}` : 'New task', ts: ev.ts };
      if (ev.type === 'skill') {
        const sk = matchSkill(ev.skill, state.skills);
        return { type: 'skill', text: `${sk ? employeeName(sk) : ev.skill} picked up work (${ev.skill})`, ts: ev.ts };
      }
      if (ev.type === 'stop') return { type: 'stop', text: ev.outcome === 'stopped' ? 'Task stopped' : ev.outcome === 'error' ? 'Task failed' : 'Task finished', ts: ev.ts };
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
  // an employee's desk takes over the whole side panel; everything else is the Manager's panel
  const aside = document.querySelector('aside');
  aside.classList.toggle('emp', employees.has(selected));
  // the Apps tab: while the Apps panel is open it fills the side panel; leaving it brings back the tab you were on
  const appsFull = selected === APPS_PANEL;
  if (appsFull !== aside.classList.contains('apps-full')) {
    if (appsFull) {
      tabBeforeApps = document.querySelector('aside header button[aria-selected="true"]')?.dataset.tab || 'chat';
      if (tabBeforeApps === 'apps') tabBeforeApps = 'chat';
      for (const x of document.querySelectorAll('aside header button')) x.setAttribute('aria-selected', String(x.dataset.tab === 'apps'));
    } else if (document.querySelector('aside header [data-tab="apps"]')?.getAttribute('aria-selected') === 'true') showTab(tabBeforeApps);
    aside.classList.toggle('apps-full', appsFull);
  }
  // an employee's Chat tab is the chat box itself, showing their conversation
  const chatWith = employees.has(selected) && employees.get(selected).data.source !== 'contractor' && deskView === 'chat' ? selected : null;
  aside.classList.toggle('emp-chat', !!chatWith);
  if (chatWith !== chatFocus) { chatFocus = chatWith; api('/api/employee/view', { id: chatWith }).then(r => { if (r.error) toast(r.error); }); }
  // choosing something else closes the skill form
  if (skillForm.id && skillForm.id !== selected) skillForm = { id: null, mode: 'board', data: null, err: '' };
  if (!selected) { el.classList.remove('on', 'editing', 'deskv'); delete el.dataset.mode; return; }
  if (!employees.has(selected)) el.classList.remove('deskv');
  if (selected === HIRE) { el.classList.remove('board'); renderSkillForm(el, null); el.classList.add('on'); return; }
  if (selected === APPS_PANEL) { el.classList.remove('board', 'editing'); renderAppsPanel(el); el.classList.add('on'); return; }
  if (selected === NEW_DEPT || String(selected).startsWith('dept:')) {
    el.classList.remove('editing');
    if (!renderDeptPanel(el)) { selected = null; el.classList.remove('on', 'board'); return; }
    el.classList.add('on', 'board');
    return;
  }
  const emp = employees.get(selected);
  const mem = memories.get(selected);
  const ld = linkedDot(selected);
  if (ld) {
    const { brain, memory: m } = ld.userData;
    el.classList.remove('board', 'editing');
    delete el.dataset.mode;
    el.innerHTML = `<h3>${esc(m.name)}</h3><div class="k">shared brain of ${esc(brain.name)} · linked, read-only here</div>
      <div class="full">${esc(m.description)}</div><div class="file">Switch to ${esc(brain.name)} to edit it.</div>`;
  } else if (emp && skillForm.id === selected && skillForm.mode !== 'board') {
    el.classList.remove('board');
    renderSkillForm(el, emp.data);
  } else if (emp) {
    el.classList.remove('editing');
    delete el.dataset.mode;
    // their desk: chat box, file cabinet and computer; contractors only have a profile
    const view = emp.data.source === 'contractor' ? 'profile' : deskView;
    el.classList.toggle('deskv', view !== 'profile');
    if (view === 'profile') renderBoard(el, emp.data);
    else { office.select(emp.data.id); office.render(el, emp.data, view, `${esc(employeeName(emp.data))} · ${esc(emp.data.name)}`, runsHtml(emp.data)); el.classList.add("board"); }
  } else if (mem) {
    el.classList.remove('board');
    renderMemoryDetail(el, mem.data);
  } else { selected = null; el.classList.remove('on', 'editing'); delete el.dataset.mode; return; }
  el.classList.add('on');
}

// ---------- employee task board ----------
// What the employee is on now, then its recent runs: the task, how it ended, Claude's answer,
// and the files this employee wrote in it.
const openRuns = new Set(); // runs whose full answer is showing
function renderBoard(el, s) {
  let html = `${s.source === 'contractor' ? office.backBar() : office.tabs('profile')}<h3>${esc(employeeName(s))} · ${esc(s.name)}</h3>
    <div class="k">${esc(SOURCE_TITLES[s.source] || s.source)}${s.owner ? ' · ' + esc(s.owner) : ''} · ${work.load.get(s.id) || 0} jobs</div>
    <div class="desc">${esc(s.description)}</div>`;
  const apps = appsOf(s);
  if (apps.length) {
    html += `<div class="runs-h">Apps</div><div class="apps-l">${apps.map(a => `<div class="row">${appBadge(a)}
      <div><b>${esc(a.title)}</b><span>${a.runs ? `used in ${a.runs} run${a.runs > 1 ? 's' : ''}` : a.why === 'tools' ? 'its SKILL.md calls it' : 'named in its SKILL.md'}</span></div>
      ${a.status === 'connected' ? `<em class="connected" title="${esc(`integration: ${a.server}`)}">connected</em>`
        : `<button class="btn mini" data-fixapp="${esc(a.key)}" title="${esc(a.server ? `integration: ${a.server}` : 'No integration for this app in Claude yet')}">${a.status === 'needs sign-in' ? 'Sign in' : a.status === 'not set up' ? 'Add' : 'Fix'}</button>`}</div>`).join('')}</div>`;
  }
  if (s.source !== 'contractor' && state.brain) {
    const depts = state.org?.departments || [], mine = depts.find(d => d.employees.includes(s.id));
    html += `<div class="deptpick"><span>Department</span><select data-assign="${esc(s.id)}"><option value="">Lobby (no department)</option>${depts.map(d =>
      `<option value="${esc(d.id)}" ${mine === d ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select>${mine ? `<button class="btn mini" data-opendept="${esc(mine.id)}">Open</button>` : ''}</div>`;
  }
  // their runs are on their computer; a contractor has no desk, so theirs stay here
  if (s.source === 'contractor') html += runsHtml(s);
  if (s.source !== 'contractor') {
    const editable = s.source === 'project' && s.owner === brainFolder();
    html += `<div class="bar"><span class="msg-err"></span>${editable
      ? `<button class="btn danger" data-skill="ask">Fire</button><button class="btn" data-skill="edit">Edit SKILL.md</button>`
      : `<button class="btn" data-skill="view">View SKILL.md</button>`}</div>`;
  }
  el.innerHTML = html;
  el.classList.add('board');
}
// What the employee is on now, then the runs Claude handed them (from the activity hook)
function runsHtml(s) {
  const busy = work.busy.get(s.id);
  const runs = (work.runs.get(s.id) || []).slice(0, 20);
  let html = '';
  if (busy) html += `<div class="nowcard"><b>Working on</b>${esc(busy.prompt || 'a task')}<span>started ${ago(busy.start)}</span></div>`;
  html += `<div class="runs-h">Recent runs</div>`;
  if (!runs.length) html += `<div class="empty">No runs yet. When Claude hands ${esc(employeeName(s))} work, each task shows up here with how it went.</div>`;
  for (const r of runs) {
    const mine = r.bySkill[r.calledAs[s.id]] || {};
    const others = r.skills.filter(id => id !== s.id).map(id => employees.get(id)).filter(Boolean).map(e => employeeName(e.data));
    const took = r.end ? ` · took ${duration(r.end - r.start)}` : r.status === 'working' ? ` · ${duration(Date.now() - r.start)} so far` : '';
    html += `<div class="run ${r.status} ${openRuns.has(r.key) ? 'open' : ''}" data-run="${esc(r.key)}">
      <div class="top"><i></i><b>${esc(r.prompt || 'A task')}</b></div>
      <div class="meta">${STATUS_TEXT[r.status] || r.status} · ${ago(r.start)}${took}${mine.tools ? ` · ${mine.tools} tool${mine.tools > 1 ? 's' : ''}` : ''}</div>
      ${r.result ? `<div class="res">${esc(r.result)}</div>` : ''}
      ${mine.files?.length ? `<div class="files">${mine.files.slice(0, 8).map(f => `<code title="${esc(f)}">${esc(f.split(/[\\/]/).pop())}</code>`).join('')}${mine.files.length > 8 ? `<span>+${mine.files.length - 8} more</span>` : ''}</div>` : ''}
      ${others.length ? `<div class="with">with ${esc(others.join(', '))}</div>` : ''}
    </div>`;
  }
  return html;
}

// ---------- an employee's desk (office.js) ----------
// Clicking someone opens their chat box; their monitor opens their computer, their cabinet their files.
let deskView = 'chat';
let chatFocus; // the employee whose chat the chat box shows (null: the Manager's); unset until the first render
office.onChange(() => { if (employees.has(selected)) renderDetail(); });
office.onError(msg => toast(msg));
function backToManager() { if (employees.has(selected)) { selected = null; renderPanel(); } }
addEventListener('keydown', e => {
  if (e.key === 'Escape' && employees.has(selected) && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)) backToManager();
});
document.getElementById('detail').addEventListener('click', async e => {
  if (e.target.closest('[data-desk-back]')) return backToManager();
  const t = e.target.closest('[data-desk-view]');
  if (t) { deskView = t.dataset.deskView; return renderDetail(); }
  if (employees.has(selected)) office.click(e);
});

// ---------- departments and their projects ----------
// A department is a room in the building: its people, what it's for, and its projects. The Manager gives
// project work to the department that owns it; each finished task's report goes in the project's log.
const NEW_DEPT = '__dept__';
const deptById = id => (state.org?.departments || []).find(d => d.id === id);
let deptForm = { mode: 'view', err: '' }; // view | edit | confirm | project (adding one)
const openProjects = new Set();
async function orgApi(body) {
  const r = await api('/api/org', body);
  if (r.error) { deptForm.err = r.error; renderDetail(); }
  return r;
}
function renderDeptPanel(el) {
  // a live update mustn't wipe what is being typed
  const a = document.activeElement, key = `${selected}:${deptForm.mode}:${deptForm.err}`;
  if (el.dataset.for === key && el.contains(a) && /^(INPUT|TEXTAREA)$/.test(a.tagName)) return true;
  el.dataset.for = key;
  delete el.dataset.mode;
  const err = `<span class="msg-err">${esc(deptForm.err)}</span>`;
  if (selected === NEW_DEPT) {
    el.innerHTML = `<h3>New department</h3><div class="k">A room in the building for a group of employees and their projects. People in the same department work together more: the Manager pairs them up, and they see each other's reports.</div>
      <label for="dpName">Name</label><input class="f" id="dpName" placeholder="Design" maxlength="60">
      <label for="dpAbout">What it does <small>optional</small></label><input class="f" id="dpAbout" placeholder="Brand, layouts and video" maxlength="300">
      <div class="bar">${err}<button class="btn" data-d="cancel">Cancel</button><button class="btn primary" data-d="create">Create</button></div>`;
    el.querySelector('#dpName').focus();
    return true;
  }
  const d = deptById(selected.slice(5));
  if (!d) return false;
  const people = state.skills.filter(s => d.employees.includes(s.id));
  const active = d.projects.filter(p => p.status === 'active');
  let html = `<h3><i class="ddot" style="background:${esc(d.color)}"></i>${esc(d.name)}</h3>
    <div class="k">${people.length} ${people.length === 1 ? 'person' : 'people'} · ${active.length} active project${active.length === 1 ? '' : 's'}${d.projects.length > active.length ? ` · ${d.projects.length - active.length} done` : ''}</div>`;
  if (deptForm.mode === 'edit') {
    el.innerHTML = html + `<label for="dpName">Name</label><input class="f" id="dpName" maxlength="60">
      <label for="dpAbout">What it does</label><input class="f" id="dpAbout" maxlength="300">
      <label for="dpColor">Colour</label><input type="color" id="dpColor" value="${esc(d.color)}">
      <div class="bar">${err}<button class="btn" data-d="view">Cancel</button><button class="btn primary" data-d="save">Save</button></div>`;
    el.querySelector('#dpName').value = d.name;
    el.querySelector('#dpAbout').value = d.about || '';
    return true;
  }
  if (d.about) html += `<div class="desc">${esc(d.about)}</div>`;
  html += `<div class="runs-h">People</div>`;
  if (!people.length) html += `<div class="empty">Nobody works here yet. Add someone below, or drag them onto ${esc(d.name)} in the list.</div>`;
  for (const s of people) {
    const busy = work.busy.get(s.id);
    html += `<div class="dperson" data-pick="${esc(s.id)}"><div class="dot" style="background:${hex(SOURCE_COLORS[s.source] ?? SOURCE_COLORS.plugin)}"></div>
      <div><b>${esc(employeeName(s))}</b><span>${esc(busy ? 'working: ' + (busy.prompt || 'a task') : s.name)}</span></div>
      <button class="btn mini" data-d="unassign" data-skill="${esc(s.id)}" title="Back to the Lobby">×</button></div>`;
  }
  const others = state.skills.filter(s => s.source !== 'contractor' && !d.employees.includes(s.id)).sort((x, y) => employeeName(x).localeCompare(employeeName(y)));
  if (others.length) html += `<select data-add="${esc(d.id)}" class="dadd"><option value="">+ Add someone…</option>${others.map(s => {
    const in_ = (state.org?.departments || []).find(x => x.employees.includes(s.id));
    return `<option value="${esc(s.id)}">${esc(employeeName(s))} · ${esc(s.name)}${in_ ? ` (from ${esc(in_.name)})` : ''}</option>`;
  }).join('')}</select>`;
  html += `<div class="runs-h">Projects</div>`;
  if (!d.projects.length && deptForm.mode !== 'project') html += `<div class="empty">No projects yet. A project gives the team a goal and a folder; the Manager puts its tasks on it, and everyone's reports collect here.</div>`;
  for (const p of [...active, ...d.projects.filter(x => x.status !== 'active')]) {
    const open = openProjects.has(p.id), log = [...p.log].reverse();
    html += `<div class="proj ${p.status} ${open ? 'open' : ''}" data-proj="${esc(p.id)}">
      <div class="top"><b>${esc(p.name)}</b><em>${p.status === 'done' ? 'done' : log.length ? `${log.length} report${log.length > 1 ? 's' : ''}` : 'new'}</em></div>
      ${p.goal ? `<div class="goal">${esc(p.goal)}</div>` : ''}
      ${p.folder ? `<div class="file" data-file="${esc(p.folder)}">${esc(p.folder)}</div>` : ''}
      ${log.slice(0, open ? 20 : 2).map(l => `<div class="plog ${l.status}"><i></i><b>${esc(l.name)}</b> ${esc(l.task)} · ${ago(l.ts)}${open ? `<div class="res">${esc(l.result)}</div>` : ''}</div>`).join('')}
      <div class="pacts">${p.status === 'active' ? `<button class="btn mini" data-d="brief" data-p="${esc(p.id)}" title="Ask the Manager in Chat to put the team on it">Brief the team</button><button class="btn mini" data-d="done" data-p="${esc(p.id)}">Mark done</button>`
        : `<button class="btn mini" data-d="reopen" data-p="${esc(p.id)}">Reopen</button>`}<button class="btn mini danger" data-d="rmproj" data-p="${esc(p.id)}">Remove</button></div></div>`;
  }
  if (deptForm.mode === 'project') {
    html += `<div class="pform"><label for="pjName">Project name</label><input class="f" id="pjName" placeholder="Spring launch video" maxlength="60">
      <label for="pjGoal">Goal <small>what done looks like</small></label><textarea class="desc-f" id="pjGoal" maxlength="1000" placeholder="A 30-second launch video and three stills for socials, in our brand style."></textarea>
      <label for="pjFolder">Folder <small>optional, full path to where its files live</small></label><input class="f" id="pjFolder" spellcheck="false" placeholder="C:\\Users\\you\\Projects\\launch">
      <div class="bar">${err}<button class="btn" data-d="view">Cancel</button><button class="btn primary" data-d="addproj">Add project</button></div></div>`;
  }
  html += deptForm.mode === 'confirm'
    ? `<div class="bar"><span class="ask">Remove ${esc(d.name)}? Its people go back to the Lobby and its projects are deleted.</span><button class="btn" data-d="view">Cancel</button><button class="btn danger primary" data-d="remove">Remove</button></div>`
    : `<div class="bar">${deptForm.mode === 'project' ? '' : err}<button class="btn danger" data-d="ask">Remove</button><button class="btn" data-d="edit">Edit</button>${deptForm.mode === 'project' ? '' : '<button class="btn primary" data-d="project">+ Project</button>'}</div>`;
  el.innerHTML = html;
  if (deptForm.mode === 'project') el.querySelector('#pjName').focus();
  return true;
}
function openDept(id) { selected = id === NEW_DEPT ? NEW_DEPT : 'dept:' + id; deptForm = { mode: 'view', err: '' }; renderPanel(); }
document.getElementById('detail').addEventListener('click', async e => {
  const od = e.target.closest('[data-opendept]');
  if (od) return openDept(od.dataset.opendept);
  if (selected !== NEW_DEPT && !String(selected).startsWith('dept:')) return;
  const pick = e.target.closest('.dperson');
  if (pick && !e.target.closest('button')) { selected = pick.dataset.pick; return renderPanel(); }
  const card = e.target.closest('.proj');
  const b = e.target.closest('[data-d]');
  if (!b) {
    if (card && !e.target.closest('[data-file]')) { openProjects.has(card.dataset.proj) ? openProjects.delete(card.dataset.proj) : openProjects.add(card.dataset.proj); renderDetail(); }
    return;
  }
  const act = b.dataset.d, id = String(selected).slice(5), val = sel => document.getElementById(sel)?.value ?? '';
  deptForm.err = '';
  if (act === 'cancel') { selected = null; return renderPanel(); }
  if (['view', 'edit', 'ask', 'project'].includes(act)) { deptForm.mode = act === 'ask' ? 'confirm' : act; return renderDetail(); }
  if (act === 'create') {
    const r = await orgApi({ op: 'addDept', name: val('dpName'), about: val('dpAbout') });
    if (r.ok) { selected = 'dept:' + r.id; deptForm.mode = 'view'; if (deptById(r.id)) renderPanel(); }
    return;
  }
  if (act === 'save') { const r = await orgApi({ op: 'editDept', id, name: val('dpName'), about: val('dpAbout'), color: val('dpColor') }); if (r.ok) { deptForm.mode = 'view'; renderDetail(); } return; }
  if (act === 'remove') { const r = await orgApi({ op: 'removeDept', id }); if (r.ok) { selected = null; deptForm.mode = 'view'; toast(`Removed the ${r.removed.name} department`); } return; }
  if (act === 'unassign') return orgApi({ op: 'assign', skill: b.dataset.skill, dept: '' });
  if (act === 'addproj') { const r = await orgApi({ op: 'addProject', dept: id, name: val('pjName'), goal: val('pjGoal'), folder: val('pjFolder') }); if (r.ok) { deptForm.mode = 'view'; renderDetail(); } return; }
  if (act === 'done' || act === 'reopen') return orgApi({ op: 'editProject', id: b.dataset.p, status: act === 'done' ? 'done' : 'active' });
  if (act === 'rmproj') return orgApi({ op: 'removeProject', id: b.dataset.p });
  if (act === 'brief') {
    // the Manager is the chat: start the request there, the user says what to do
    const p = deptById(id)?.projects.find(x => x.id === b.dataset.p);
    if (!p) return;
    document.querySelector('aside header [data-tab="chat"]').click();
    const input = document.getElementById('input');
    input.value = `Put the ${deptById(id).name} department on the project "${p.name}" (${p.id}): `;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }
});
document.getElementById('detail').addEventListener('keydown', e => {
  if (e.key !== 'Enter' || e.target.tagName !== 'INPUT') return;
  const go = document.querySelector('#detail [data-d="create"], #detail [data-d="save"], #detail [data-d="addproj"]');
  if (go) { e.preventDefault(); go.click(); }
});
document.getElementById('detail').addEventListener('change', e => {
  const as = e.target.closest('select[data-assign]');
  if (as) return orgApi({ op: 'assign', skill: as.dataset.assign, dept: as.value });
  const add = e.target.closest('select[data-add]');
  if (add && add.value) orgApi({ op: 'assign', skill: add.value, dept: add.dataset.add });
});
// drag an employee row onto a department (or a Lobby heading) to move them
const teamEl = document.getElementById('team');
teamEl.addEventListener('dragstart', e => {
  const row = e.target.closest('.emp[draggable]');
  if (!row) return;
  e.dataTransfer.setData('text/x-claudeos-emp', row.dataset.id);
  e.dataTransfer.effectAllowed = 'move';
  teamEl.classList.add('dragging');
});
teamEl.addEventListener('dragend', () => { teamEl.classList.remove('dragging'); for (const x of teamEl.querySelectorAll('.over')) x.classList.remove('over'); });
teamEl.addEventListener('dragover', e => {
  const t = e.target.closest('[data-drop]');
  if (!t || !e.dataTransfer.types.includes('text/x-claudeos-emp')) return;
  e.preventDefault();
  for (const x of teamEl.querySelectorAll('.over')) if (x !== t) x.classList.remove('over');
  t.classList.add('over');
});
teamEl.addEventListener('drop', e => {
  const t = e.target.closest('[data-drop]'), id = e.dataTransfer.getData('text/x-claudeos-emp');
  if (!t || !id) return;
  e.preventDefault();
  orgApi({ op: 'assign', skill: id, dept: t.dataset.drop });
});

// ---------- skill editor ----------
// Hire (a new SKILL.md in this brain's .claude/skills), edit or fire an employee without asking Claude.
// Personal and plugin skills open read-only: they belong to every project, not this brain.
const HIRE = '__hire__';
let skillForm = { id: null, mode: 'board', data: null, err: '' };
let selectWhenHired = null; // the new employee's id, until its sphere arrives
const brainFolder = () => state.brain?.path.split(/[\\/]/).filter(Boolean).pop();
const HIRE_BODY = `# What this employee does

1. **Read first.** What to look at before starting (files, the shared brain).
2. **Do the work.** The steps, in order.
3. **Hand it back.** Where the result goes and what to say when done.
`;

async function openSkill(id, mode) {
  skillForm = { id, mode, data: null, err: '' };
  renderDetail();
  const r = await api(`/api/skill?id=${encodeURIComponent(id)}`);
  if (skillForm.id !== id) return;
  if (r.error) { skillForm.mode = 'board'; renderDetail(); return toast(r.error); }
  skillForm.data = r;
  if (!r.editable) skillForm.mode = 'view';
  renderDetail();
}

function renderSkillForm(el, s) {
  const key = s ? s.id : HIRE;
  const mode = s ? skillForm.mode : 'hire';
  // live updates re-render the panel; keep what is being typed
  if ((mode === 'edit' || mode === 'hire') && el.dataset.mode === mode && el.dataset.for === key && el.querySelector('#skBody')) return;
  el.dataset.for = key;
  el.dataset.mode = mode;
  el.classList.add('editing');
  if (s && !skillForm.data) { el.innerHTML = `<h3>${esc(employeeName(s))} · ${esc(s.name)}</h3><div class="empty">Opening SKILL.md…</div>`; return; }
  const err = `<span class="msg-err">${esc(skillForm.err)}</span>`;
  const d = s ? skillForm.data : { name: '', description: '', body: HIRE_BODY };
  const ro = mode === 'view' || mode === 'confirm' ? 'readonly' : '';
  const head = !s
    ? `<h3>Hire an employee</h3><div class="k">Writes a new skill into ${esc(state.brain?.name || 'this brain')}/.claude/skills. Claude can hand it work from your next message.</div>`
    : `<h3>${esc(employeeName(s))} · ${esc(s.name)}</h3><div class="k">${mode !== 'view' ? 'Claude picks this employee by its description, then follows the instructions.'
      : s.source === 'project' ? `Only ${esc(state.brain?.name || 'this brain')}'s own team can be edited here.`
      : `${esc(SOURCE_TITLES[s.source] || s.source)} are shared by every project, so they're read-only here.`}</div>`;
  const bar = mode === 'confirm'
    ? `<span class="ask">Fire ${esc(employeeName(s))}? Claude stops using this skill. You can undo right after.</span><button class="btn" data-skill="board">Cancel</button><button class="btn danger primary" data-skill="fire">Fire</button>`
    : mode === 'view' ? `${err}<button class="btn" data-skill="board">Back</button>`
    : `${err}<button class="btn" data-skill="board">Cancel</button><button class="btn primary" data-skill="save">${s ? 'Save' : 'Hire'}</button>`;
  el.innerHTML = `${head}
    <label for="skName">Skill name <small>lowercase-with-dashes</small></label>
    <input class="f" id="skName" spellcheck="false" placeholder="proof-reader" ${ro}>
    <label for="skDesc">Description <small>what it does, and when Claude should use it</small></label>
    <textarea class="desc-f" id="skDesc" placeholder="Check a script for typos and awkward lines. Use when the user asks to proof-read or polish text." ${ro}></textarea>
    <label for="skBody">Instructions <small>Markdown, the steps it follows</small></label>
    <textarea id="skBody" spellcheck="false" ${ro}></textarea>
    ${d.file ? `<div class="file">${esc(d.file)}</div>` : ''}
    <div class="bar">${bar}</div>`;
  el.querySelector('#skName').value = d.name;
  el.querySelector('#skDesc').value = d.description;
  el.querySelector('#skBody').value = d.body;
  if (!ro) el.querySelector(s ? '#skBody' : '#skName').focus();
}

document.getElementById('detail').addEventListener('click', async e => {
  const btn = e.target.closest('[data-skill]');
  if (!btn) return;
  const act = btn.dataset.skill;
  const id = selected === HIRE ? null : selected;
  if (act === 'edit' || act === 'view') return openSkill(id, act);
  if (act === 'ask') return openSkill(id, 'confirm');
  if (act === 'board') {
    skillForm = { id: null, mode: 'board', data: null, err: '' };
    if (selected === HIRE) selected = null;
    return renderPanel();
  }
  btn.disabled = true;
  const showErr = msg => { skillForm.err = msg; btn.disabled = false; document.querySelector('#detail .msg-err').textContent = msg; };
  if (act === 'save') {
    const r = await api('/api/skills/save', { id, name: document.getElementById('skName').value,
      description: document.getElementById('skDesc').value, body: document.getElementById('skBody').value });
    if (r.error) return showErr(r.error);
    skillForm = { id: null, mode: 'board', data: null, err: '' };
    toast(id ? `Saved: ${r.name}` : `Hired: ${r.name}`, null, null, `.claude/skills/${r.folder}/SKILL.md`);
    showWhenHired(r.id);
  }
  if (act === 'fire') {
    const who = employeeName(employees.get(id).data);
    const r = await api('/api/skills/fire', { id });
    if (r.error) return showErr(r.error);
    skillForm = { id: null, mode: 'board', data: null, err: '' };
    selected = null;
    renderPanel();
    toast(`Fired: ${who} (${r.name})`, 'Undo', async () => {
      const u = await api('/api/skills/restore', { trashId: r.trashId });
      if (u.error) return toast(u.error);
      showWhenHired(u.id);
    });
  }
});

// ---------- apps (integrations) ----------
// Add Claude's integrations from the page: pick an app with a known address, turn on a claude.ai
// connector, or paste any MCP address or command. Remote apps then sign in once in the browser.
const APPS_PANEL = '__apps__';
let tabBeforeApps = 'chat';
let appsPanel = { data: null, open: null, err: '', busy: false, scope: 'local', drawn: '' };

async function openApps(key) {
  selected = APPS_PANEL;
  appsPanel = { ...appsPanel, open: key || null, err: '', busy: false };
  renderPanel();
  const r = await api('/api/integrations');
  if (!r.error) appsPanel.data = r;
  renderDetail();
}
events.addEventListener('integrations', e => {
  appsPanel.data = JSON.parse(e.data);
  if (selected === APPS_PANEL) renderDetail();
});
events.addEventListener('account-login', e => {
  const r = JSON.parse(e.data);
  if (r.cancelled) return;
  const t = r.title || 'GitHub';
  toast(r.ok ? `Signed in to ${t} as ${r.user}` : `${t} sign-in didn’t finish`, null, null,
    r.ok ? (r.key === 'claude' ? 'Your chats and employees run on this account.' : r.key === 'codex' ? 'Codex chats run on this account.' : 'git push, pull requests and CI work from now on.') : r.text);
});
// another part of the page (the Git tab) asks for the Apps panel
document.addEventListener('claudeos:open-apps', () => openApps());
events.addEventListener('integration-login', e => {
  const r = JSON.parse(e.data);
  toast(r.ok ? `Signed in: ${r.server}` : `Sign-in didn't finish for ${r.server}`, null, null, r.ok ? 'Its employees can use it from your next message.' : r.text);
});

const appMeta = (key, fallback) => APPS[key] ? { title: APPS[key].title, hex: APPS[key].hex, path: APPS[key].path } : { title: fallback || key, hex: '8a8fa8', path: null };
function logo(key, fallback, off) {
  return appBadge({ ...appMeta(key, fallback), key, status: off ? 'off' : 'connected', runs: 0, why: '' }).replace(/title="[^"]*"/, '');
}

function renderAppsPanel(el) {
  const d = appsPanel.data;
  // live updates re-render the panel; keep a half-filled form as it is
  const sig = JSON.stringify([d?.list, d?.accounts, d?.checking, appsPanel.open, appsPanel.err, appsPanel.busy, appsPanel.scope]);
  if (el.dataset.mode === 'apps' && appsPanel.drawn === sig) return;
  const typing = el.querySelector('#apName, #apTarget, #apExtra');
  const keep = typing && { name: el.querySelector('#apName')?.value, target: el.querySelector('#apTarget')?.value, extra: el.querySelector('#apExtra')?.value };
  // a key half pasted in survives the redraw too
  const keysTyped = Object.fromEntries([...el.querySelectorAll('[data-keyin]')].filter(i => i.value).map(i => [i.dataset.keyin, i.value]));
  appsPanel.drawn = sig;
  el.dataset.mode = 'apps';
  delete el.dataset.for;
  if (!d) { el.innerHTML = '<h3>Apps</h3><div class="empty">Loading…</div>'; return; }
  const have = new Set(d.list.map(i => i.key).filter(Boolean));
  let html = `<h3>Apps</h3><div class="k">What Claude can reach from ${esc(state.brain?.name || 'this brain')}. Employees use these through their skills.
    <button class="btn mini" data-ap="refresh" ${d.checking ? 'disabled' : ''}>${d.checking ? 'Checking…' : 'Refresh'}</button>
    <button class="btn mini" data-ap="plugins" title="Browse and install Claude Code plugins: skills, commands, agents and MCP servers from marketplaces">Plugins…</button></div>`;
  // accounts for this PC (Claude, Codex, GitHub's gh), each with a one-click sign-in and sign-out
  html += `<div class="runs-h">Accounts</div><div class="apps-l">`;
  for (const a of d.accounts || []) {
    const st = a.state === 'signed-in' ? `<em class="connected">signed in as ${esc(a.user)}</em><button class="btn mini" data-ap="acct" data-act="logout" data-key="${esc(a.key)}" title="Sign ${esc(a.user)} out of ${esc(a.title)} on this PC">Sign out</button>`
      : a.state === 'missing' ? `<em class="failed">not installed</em><a class="btn mini" href="${esc(a.install)}" target="_blank" rel="noopener">Get it</a>`
      : a.state === 'checking' ? '<em>checking…</em>'
      : a.flow ? `<em>waiting for ${a.ai ? 'your browser' : 'GitHub'}…</em><button class="btn mini" data-ap="acct" data-act="cancel" data-key="${esc(a.key)}">Cancel</button>`
      : `<em class="needs">${a.state === 'expired' ? `${esc(a.user)}'s sign-in expired` : 'not signed in'}</em><button class="btn mini primary" data-ap="acct" data-act="login" data-key="${esc(a.key)}">Sign in</button>`;
    html += `<div class="row">${logo(a.key, a.title, a.state !== 'signed-in')}<div><b>${esc(a.title)}</b><span>${esc(a.what)}</span></div><div class="acts">${st}</div></div>`;
    // Claude / Codex: the CLI opens the sign-in page; the link is here too, and Claude's page may hand back a code to paste
    if (a.ai && a.flow) html += `<div class="ap-box ap-code">${a.flow.url
      ? `Finish signing in to ${esc(a.title)} in your browser. This finishes by itself.
        <div class="code-line"><a class="btn mini" href="${esc(a.flow.url)}" target="_blank" rel="noopener">Open the sign-in page again</a></div>
        ${a.flow.paste ? `<div class="note">If the page shows a code instead, paste it here:</div>
        <div class="code-line"><input class="f" data-keyin="acct-${esc(a.key)}" placeholder="Code from the sign-in page" autocomplete="off" spellcheck="false"><button class="btn mini primary" data-ap="acctcode" data-key="${esc(a.key)}">Continue</button></div>` : ''}`
      : `Starting the ${esc(a.title)} sign-in…`}</div>`;
    else if (a.flow?.code) html += `<div class="ap-box ap-code">Enter this code on the GitHub page that just opened:
      <div class="code-line"><code class="otc">${esc(a.flow.code)}</code><button class="btn mini" data-ap="copy" data-text="${esc(a.flow.code)}">Copy</button><a class="btn mini" href="${esc(a.flow.url)}" target="_blank" rel="noopener">Open github.com/login/device</a></div>
      <div class="note">Then click Authorize. This finishes by itself, and git push uses the same sign-in.</div></div>`;
    else if (a.flow) html += `<div class="ap-box ap-code">Asking GitHub for a code…</div>`;
  }
  html += `</div>`;
  html += `<div class="runs-h">Connected to Claude · ${d.list.length}</div><div class="apps-l">`;
  if (!d.list.length) html += `<div class="empty">${d.checking ? 'Checking your integrations…' : 'None yet. Add one below.'}</div>`;
  for (const i of d.list) {
    const m = appMeta(i.key, i.server.replace(/^plugin:[^:]+:/, ''));
    const fixed = /^(claude\.ai |plugin:)/.test(i.server);
    const keys = i.keys || [];
    // a remote app that failed without asking for a key usually needs its browser sign-in again
    const act = i.signingIn ? `<em>signing in…</em>`
      : i.status === 'needs sign-in' ? `<button class="btn mini primary" data-ap="login" data-server="${esc(i.server)}">Sign in</button>`
      : i.status === 'failed' && i.remote && !keys.length ? `<button class="btn mini" data-ap="login" data-server="${esc(i.server)}" title="Open the sign-in page in your browser again">Sign in again</button>` : '';
    html += `<div class="row">${logo(i.key, i.server, i.status !== 'connected')}
      <div><b>${esc(m.title)}</b><span title="${esc(i.detail)}">${esc(i.server)}${i.status === 'connected' || (i.keys || []).length ? '' : ' · ' + esc(i.detail)}</span></div>
      <div class="acts"><em class="${i.status.split(' ')[0]}">${esc(keys.some(k => !k.set) ? 'needs a key' : i.status)}</em>${act}${fixed ? '' : `<button class="btn mini danger" data-ap="remove" data-server="${esc(i.server)}" title="Remove from Claude Code">×</button>`}</div></div>`;
    // apps that sign in with an API key: paste it once, ClaudeOS keeps it as a Windows user variable
    for (const k of keys) {
      html += `<div class="ap-box ap-key"><div><b>${esc(m.title)}</b> signs in with a key, <code>${esc(k.name)}</code>. ${k.set ? 'One is saved, but it was refused: paste a new one.' : 'Paste yours and it works from your next message.'}${k.help ? ` <a href="${esc(k.help)}" target="_blank" rel="noopener">Get a key</a>` : ''}</div>
        <div class="code-line"><input class="f" type="password" data-keyin="${esc(k.name)}" placeholder="${esc(k.name)}" autocomplete="off" spellcheck="false"><button class="btn mini primary" data-ap="savekey" data-name="${esc(k.name)}">Save</button>${k.set ? `<button class="btn mini" data-ap="rmkey" data-name="${esc(k.name)}" title="Delete the saved key from this PC">Remove</button>` : ''}</div></div>`;
    }
  }
  html += `</div><div class="runs-h">Add an app</div><div class="ap-grid">`;
  for (const c of d.catalog.filter(c => !have.has(c.key))) {
    const m = appMeta(c.key);
    html += `<button class="ap-tile ${appsPanel.open === c.key ? 'on' : ''}" data-ap="open" data-key="${esc(c.key)}">${logo(c.key)}<span>${esc(m.title)}</span></button>`;
  }
  html += `<button class="ap-tile ${appsPanel.open === 'custom' ? 'on' : ''}" data-ap="open" data-key="custom"><span class="app" style="background:#5b6080">+</span><span>Other app</span></button></div>`;
  const c = d.catalog.find(x => x.key === appsPanel.open);
  const scope = `<select id="apScope" title="Where Claude can use it"><option value="local" ${appsPanel.scope === 'local' ? 'selected' : ''}>This brain only</option><option value="user" ${appsPanel.scope === 'user' ? 'selected' : ''}>All my projects</option></select>`;
  const err = `<span class="msg-err">${esc(appsPanel.err)}</span>`;
  if (c?.how === 'connector') {
    html += `<div class="ap-box"><b>${esc(appMeta(c.key).title)}</b> connects through your claude.ai account. Turn it on there, sign in, then press Refresh here. It shows up in every brain.
      <div class="bar">${err}<a class="btn primary" href="${esc(d.connectorsUrl)}" target="_blank" rel="noopener">Open claude.ai connectors</a></div></div>`;
  } else if (c) {
    html += `<div class="ap-box"><b>${esc(appMeta(c.key).title)}</b> · ${c.how === 'stdio' ? `runs <code>${esc(c.command.join(' '))}</code> on this PC.` : `adds <code>${esc(c.url)}</code>. Your browser opens once so you can sign in.`}
      ${c.note ? `<div class="note">${esc(c.note)}</div>` : ''}
      <div class="bar">${err}${scope}<button class="btn primary" data-ap="add" ${appsPanel.busy ? 'disabled' : ''}>${appsPanel.busy ? 'Adding…' : 'Add'}</button></div></div>`;
  } else if (appsPanel.open === 'custom') {
    html += `<div class="ap-box"><b>Any other app</b> with an MCP server. Its website or GitHub page gives the address or command.
      <label for="apName">Name</label><input class="f" id="apName" placeholder="unreal" spellcheck="false">
      <label for="apTarget">Address or command</label><input class="f" id="apTarget" placeholder="https://… or npx -y some-mcp-server" spellcheck="false">
      <label for="apExtra">Keys <small>optional, one per line: API_KEY=… for a command, Authorization: Bearer … for an address</small></label>
      <textarea class="desc-f" id="apExtra" spellcheck="false"></textarea>
      <div class="bar">${err}${scope}<button class="btn primary" data-ap="add" ${appsPanel.busy ? 'disabled' : ''}>${appsPanel.busy ? 'Adding…' : 'Add'}</button></div></div>`;
  }
  el.innerHTML = html;
  if (keep) for (const [id, v] of [['#apName', keep.name], ['#apTarget', keep.target], ['#apExtra', keep.extra]]) if (el.querySelector(id) && v != null) el.querySelector(id).value = v;
  for (const i of el.querySelectorAll('[data-keyin]')) if (keysTyped[i.dataset.keyin]) i.value = keysTyped[i.dataset.keyin];
}

document.getElementById('detail').addEventListener('change', e => { if (e.target.id === 'apScope') appsPanel.scope = e.target.value; });
document.getElementById('detail').addEventListener('click', async e => {
  const fix = e.target.closest('[data-fixapp]');
  if (fix) return openApps(fix.dataset.fixapp.startsWith('mcp:') ? 'custom' : fix.dataset.fixapp);
  const btn = e.target.closest('[data-ap]');
  if (!btn || selected !== APPS_PANEL) return;
  const act = btn.dataset.ap;
  const redraw = () => { appsPanel.drawn = ''; renderDetail(); };
  if (act === 'open') { appsPanel.open = appsPanel.open === btn.dataset.key ? null : btn.dataset.key; appsPanel.err = ''; return redraw(); }
  if (act === 'refresh') return api('/api/integrations/refresh', {});
  if (act === 'plugins') return document.dispatchEvent(new CustomEvent('claudeos:plugins'));
  if (act === 'acct') {
    if (btn.dataset.key === 'claude' && btn.dataset.act === 'logout'
      && !confirm('Sign out of Claude on this PC?\n\nEvery chat and employee in ClaudeOS runs on this sign-in, so they stop working until you sign in again (Apps → Accounts → Sign in).')) return;
    const r = await api('/api/integrations/account', { key: btn.dataset.key, act: btn.dataset.act });
    if (r.error) toast(r.error);
    return;
  }
  if (act === 'acctcode') {
    const input = btn.closest('.ap-box')?.querySelector('[data-keyin]');
    const r = await api('/api/integrations/account', { key: btn.dataset.key, act: 'code', code: input?.value || '' });
    if (r.error) toast(r.error); else { btn.textContent = 'Checking…'; btn.disabled = true; }
    return;
  }
  if (act === 'copy') { navigator.clipboard?.writeText(btn.dataset.text).then(() => { btn.textContent = 'Copied'; }); return; }
  if (act === 'savekey' || act === 'rmkey') {
    const input = btn.closest('.ap-key')?.querySelector('[data-keyin]');
    if (act === 'rmkey' && !confirm(`Delete the saved ${btn.dataset.name} from this PC?`)) return;
    btn.disabled = true;
    const r = await api('/api/integrations/key', act === 'rmkey' ? { name: btn.dataset.name, remove: true } : { name: btn.dataset.name, value: input?.value || '' });
    btn.disabled = false;
    if (r.error) return toast(r.error);
    if (input) input.value = '';
    return toast(act === 'rmkey' ? `Removed ${btn.dataset.name}` : `Saved ${btn.dataset.name}`, null, null, act === 'rmkey' ? '' : 'Checking that it connects…');
  }
  if (act === 'login') { const r = await api('/api/integrations/login', { server: btn.dataset.server }); if (r.error) toast(r.error); return; }
  if (act === 'remove') {
    if (!confirm(`Remove ${btn.dataset.server} from Claude Code? Employees that use it stop reaching it.`)) return;
    const r = await api('/api/integrations/remove', { server: btn.dataset.server });
    return r.error ? toast(r.error) : toast(`Removed: ${btn.dataset.server}`);
  }
  if (act === 'add') {
    const c = appsPanel.data.catalog.find(x => x.key === appsPanel.open);
    const body = c ? { key: c.key, scope: appsPanel.scope }
      : { name: document.getElementById('apName').value, target: document.getElementById('apTarget').value, extra: document.getElementById('apExtra').value, scope: appsPanel.scope };
    appsPanel.busy = true; appsPanel.err = ''; redraw();
    const r = await api('/api/integrations/add', body);
    appsPanel.busy = false;
    if (r.error) { appsPanel.err = r.error; return redraw(); }
    appsPanel.open = null;
    redraw();
    toast(`Added: ${r.name}`, null, null, c && c.how !== 'stdio' ? 'Your browser opens so you can sign in.' : 'Checking that it connects…');
    // a remote app signs in right away, so it's ready for the next message
    if (c && c.how !== 'stdio') api('/api/integrations/login', { server: r.name });
  }
});

// a new or renamed employee's sphere comes with the next live update; select it once it's there
function showWhenHired(id) {
  if (employees.has(id)) { selected = id; selectWhenHired = null; } else { selected = null; selectWhenHired = id; }
  renderPanel();
}
document.getElementById('detail').addEventListener('click', e => {
  const run = e.target.closest('.run');
  if (!run || !run.querySelector('.res')) return;
  openRuns.has(run.dataset.run) ? openRuns.delete(run.dataset.run) : openRuns.add(run.dataset.run);
  run.classList.toggle('open');
});

// ---------- memory inspector ----------
// What the detail panel is doing with the selected memory: reading it, editing it, or asking to delete it.
let inspect = { id: null, mode: 'view', text: null, kind: '', file: '', err: '' };
const stripFrontmatter = t => t.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();

async function loadMemory(id) {
  const r = await api(`/api/memory?id=${encodeURIComponent(id)}`);
  if (inspect.id !== id) return; // picked something else meanwhile
  if (r.error) inspect.err = r.error; else Object.assign(inspect, { text: r.text, kind: r.kind, file: r.file, err: '' });
  renderDetail();
}

function renderMemoryDetail(el, m) {
  if (inspect.id !== m.id) { inspect = { id: m.id, mode: 'view', text: null, kind: '', file: '', err: '' }; loadMemory(m.id); }
  // the panel re-renders on every live update; don't wipe out what is being typed
  if (inspect.mode === 'edit' && el.dataset.mode === 'edit' && el.dataset.for === m.id) return;
  el.dataset.for = m.id;
  el.dataset.mode = inspect.mode;
  el.classList.toggle('editing', inspect.mode === 'edit');
  const head = `<h3>${esc(m.name)}</h3><div class="k">${esc(m.type)} memory · ${esc(m.projectLabel)}${m.created ? ' · ' + new Date(m.created).toLocaleDateString() : ''}</div>`;
  const err = `<span class="msg-err">${esc(inspect.err)}</span>`;
  if (inspect.mode === 'edit') {
    el.innerHTML = `${head}<textarea id="memEdit" spellcheck="false"></textarea>
      <div class="bar">${err}<button class="btn" data-act="cancel">Cancel</button><button class="btn primary" data-act="save">Save</button></div>`;
    const ta = el.querySelector('textarea');
    ta.value = inspect.text ?? m.description;
    ta.focus();
    return;
  }
  const body = inspect.text == null ? m.description : inspect.kind === 'claude' ? stripFrontmatter(inspect.text) : inspect.text;
  const bar = inspect.mode === 'confirm'
    ? `<span class="ask">Delete this memory? Claude stops seeing it. You can undo right after.</span><button class="btn" data-act="cancel">Cancel</button><button class="btn danger primary" data-act="delete">Delete</button>`
    : `${err}<button class="btn danger" data-act="ask">Delete</button><button class="btn" data-act="edit" ${inspect.text == null ? 'disabled' : ''}>Edit</button>`;
  el.innerHTML = `${head}<div class="full">${esc(body)}</div>
    ${inspect.file ? `<div class="file">${esc(inspect.file)}${inspect.kind === 'brain' ? ` · ${esc(m.name)}` : ''}</div>` : ''}
    <div class="bar">${bar}</div>`;
}

function setMode(mode) { inspect.mode = mode; inspect.err = ''; renderDetail(); }

document.getElementById('detail').addEventListener('click', async e => {
  const btn = e.target.closest('[data-act]');
  if (!btn || !memories.has(inspect.id)) return;
  const act = btn.dataset.act;
  if (act === 'edit') return setMode('edit');
  if (act === 'ask') return setMode('confirm');
  if (act === 'cancel') return setMode('view');
  btn.disabled = true;
  if (act === 'save') {
    const r = await api('/api/memory/save', { id: inspect.id, text: document.getElementById('memEdit').value });
    if (r.error) { inspect.err = r.error; btn.disabled = false; document.querySelector('#detail .msg-err').textContent = r.error; return; }
    // a shared-brain memory's id comes from its text, so an edit gives it a new id (and a new dot)
    selected = r.id;
    inspect = { id: r.id, mode: 'view', text: null, kind: '', file: '', err: '' };
    loadMemory(r.id);
    renderPanel();
  }
  if (act === 'delete') {
    const name = memories.get(inspect.id).data.name;
    const r = await api('/api/memory/delete', { id: inspect.id });
    if (r.error) { inspect.mode = 'view'; inspect.err = r.error; return renderDetail(); }
    selected = null;
    renderPanel();
    toast(`Deleted: ${name}`, 'Undo', async () => {
      const u = await api('/api/memory/restore', { trashId: r.trashId });
      if (u.error) return toast(u.error);
      selected = u.id; // the dot comes back with the next live update
    });
  }
});

addEventListener('keydown', e => {
  if (e.key !== 'Escape' || !selected || e.target.closest?.('#log, .composer, .modal')) return;
  if (inspect.mode !== 'view' && memories.has(selected)) return setMode('view');
  selected = null;
  renderPanel();
});

function toast(title, action, onAction, detail) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.innerHTML = `${esc(title)}${action ? `<button class="btn">${esc(action)}</button>` : ''}${detail ? `<span>${esc(detail)}</span>` : ''}`;
  t.querySelector('button')?.addEventListener('click', () => { t.remove(); onAction(); });
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 8000);
}

// ---------- memory search ----------
const memSearch = document.getElementById('memSearch');
let query = [];
const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function highlight(text) {
  if (!query.length) return esc(text);
  return String(text).split(new RegExp(`(${query.map(reEsc).join('|')})`, 'i'))
    .map((part, i) => i % 2 ? `<mark>${esc(part)}</mark>` : esc(part)).join('');
}

function renderMemList() {
  const list = document.getElementById('memList');
  const all = [...memories.values()].sort((a, b) => b.data.created - a.data.created);
  let shown = 0, html = '';
  for (const e of all) {
    const m = e.data;
    const hay = `${m.name} ${m.description} ${m.projectLabel} ${m.type}`.toLowerCase();
    e.match = query.every(q => hay.includes(q));
    if (!e.match) continue;
    shown++;
    html += `<div class="mem ${selected === m.id ? 'sel' : ''}" data-id="${esc(m.id)}">
      <i style="color:${hex(TYPE_COLORS[m.type] ?? TYPE_COLORS.project)};background:currentColor"></i>
      <b>${highlight(m.name)}</b><span>${highlight(m.description)}</span></div>`;
  }
  if (!all.length) html = '<div class="empty">No memories yet. Everything Claude saves in this brain shows up here.</div>';
  else if (!shown) html = '<div class="empty">No memory matches that.</div>';
  list.innerHTML = html;
}

memSearch.addEventListener('input', () => {
  query = memSearch.value.toLowerCase().split(/\s+/).filter(Boolean);
  renderMemList();
});
document.getElementById('memList').addEventListener('click', e => {
  const row = e.target.closest('.mem');
  if (!row) return;
  selected = row.dataset.id;
  renderPanel();
});

document.querySelector('aside header').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  // Apps is its own tab: the Apps panel fills the side panel (renderDetail sets that up)
  if (b.dataset.tab === 'apps') return openApps();
  showTab(b.dataset.tab);
  if (selected === APPS_PANEL) { selected = null; renderPanel(); }
});
function showTab(name) {
  for (const x of document.querySelectorAll('aside header button')) x.setAttribute('aria-selected', String(x.dataset.tab === name));
  for (const t of document.querySelectorAll('.tab')) t.classList.toggle('on', t.id === name);
}
document.getElementById('team').addEventListener('click', async e => {
  if (e.target.closest('[data-newdept]')) return openDept(NEW_DEPT);
  const dh = e.target.closest('[data-dept]');
  if (dh) return openDept(dh.dataset.dept);
  if (e.target.closest('[data-hire]')) {
    skillForm = { id: null, mode: 'hire', data: null, err: '' };
    selected = HIRE;
    return renderPanel();
  }
  const copy = e.target.closest('[data-copy]');
  if (copy) {
    copy.disabled = true;
    const r = await api('/api/skills/copy', { from: copy.dataset.from, skill: copy.dataset.copy });
    if (r.error) { copy.disabled = false; return toast(r.error); }
    return toast(`Hired: ${copy.dataset.copy}`, null, null, `Copied into .claude/skills/${r.folder}`);
  }
  const row = e.target.closest('.emp');
  if (!row) return;
  selected = row.dataset.id;
  deskView = 'chat';
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
  const targets = [boss.sphere, boss.screen, ...[...employees.values()].flatMap(e => [e.sphere, e.screen, ...(e.cabinet ? [e.cabinet] : [])]), ...[...memories.values()].map(m => m.mesh),
    ...[...satellites.values()].flatMap(s => [...s.dots.values()]), ...[...rooms.values()].flatMap(r => r.pickables)];
  const hit = ray.intersectObjects(targets, false)[0];
  return hit?.object.userData;
}
canvas.addEventListener('pointermove', ev => {
  const u = pick(ev);
  if (!u) { tip.style.display = 'none'; canvas.style.cursor = ''; return; }
  canvas.style.cursor = 'pointer';
  let title, sub;
  if (u.kind === 'employee') { const s = employees.get(u.id).data; title = `${employeeName(s)} · ${s.name}${u.view === 'computer' ? ' · computer' : u.view === 'cabinet' ? ' · file cabinet' : ''}`; const b = work.busy.get(s.id); sub = b ? 'Working on: ' + (b.prompt || 'a task') : `${work.load.get(s.id) || 0} jobs done`; }
  else if (u.kind === 'manager') { title = 'Manager · briefs & splits the work'; sub = bossLine() || 'Talk to the Manager in the Chat tab. Queue requests there to brief the team on several at once.'; }
  else if (u.kind === 'dept') { const d = deptById(u.id.slice(5)); if (!d) return; title = `${d.name} department`; sub = `${d.employees.filter(id => employees.has(id)).length} people · ${d.projects.filter(p => p.status === 'active').length} active projects. Click to open it.`; }
  else if (u.kind === 'linked') { title = `${u.memory.name} · ${u.brain.name}`; sub = u.memory.description; }
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
  if (u?.kind === 'dept') return openDept(u.id.slice(5));
  if (u?.kind === 'employee') deskView = u.view || 'chat';
  if (u?.kind === 'manager') { backToManager(); document.querySelector('aside header [data-tab="chat"]').click(); return document.getElementById('input').focus(); }
  selected = u ? u.id : null;
  renderPanel();
});

// ---------- animation ----------
const clock = new THREE.Clock();
const tmp = new THREE.Vector3();
const brainWorld = new THREE.Vector3();
const screenWorld = new THREE.Vector3();
const focus = new THREE.Vector3();
const visitSpot = new THREE.Vector3(), visitLook = new THREE.Vector3();
const HOME = new THREE.Vector3();
let goHome = false;
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
    const dim = query.length && !e.match;
    const s = easeOutBack(k) * (1 + Math.sin(t * 2 + e.twinkle) * 0.12) * (dim ? 0.45 : 1);
    e.mesh.scale.setScalar(Math.max(0.0001, s));
    e.halo.scale.setScalar(selected === e.data.id ? 2.6 : 0.9);
    e.halo.material.opacity = dim ? 0.08 : selected === e.data.id ? 0.9 : 0.55;
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
    tmp.copy(e.home);
    e.root.position.copy(tmp);
    e.station.rotation.y = e.facing;
    // idle: leaning back in the chair, face above the monitor, breathing slowly;
    // busy: leaning in to the screen with a little typing bounce
    const lean = 0.12 * e.busyAmt - 0.28 * (1 - e.busyAmt);
    e.body.position.set(Math.sin(e.facing) * lean, 0, Math.cos(e.facing) * lean);
    e.body.position.y = (0.28 + Math.sin(t * 1.4 + e.phase) * 0.04) * (1 - e.busyAmt) + Math.abs(Math.sin(t * 9 + e.phase)) * 0.05 * e.busyAmt;
    const k = Math.min(1, age / 0.7);
    const sel = selected === e.data.id ? 1.18 : 1;
    e.root.scale.setScalar(Math.max(0.0001, easeOutBack(k) * sel));
    // idle employees turn round to look at you; busy ones face their screen
    let look = busy ? e.screen.getWorldPosition(screenWorld) : camera.position;
    // stopping by a colleague: float over (hopping the desks), stay a while, float back
    let talk = null;
    const v = e.visit, host = v && employees.get(v.to);
    if (v) {
      const el = (now - v.start) / 1000;
      if (!host || busy || el > v.walk * 2 + v.stay) e.visit = null;
      else {
        const ease = x => x * x * (3 - 2 * x);
        const f = el < v.walk ? ease(el / v.walk) : el < v.walk + v.stay ? 1 : ease(1 - (el - v.walk - v.stay) / v.walk);
        // the spot at the host's right, beside their chair
        visitSpot.set(Math.cos(host.facing) * 1.3 - Math.sin(host.facing) * 0.2, 0.3, -Math.sin(host.facing) * 1.3 - Math.cos(host.facing) * 0.2)
          .add(host.home).sub(e.home).divideScalar(e.root.scale.x);
        e.body.position.lerp(visitSpot, f);
        e.body.position.y += Math.sin(f * Math.PI) * (f < 1 ? 1.1 : 0);
        if (f > 0.85) {
          look = host.body.getWorldPosition(visitLook);
          talk = `${v.reason === 'handoff' ? 'Handing over to' : 'Chatting with'} ${employeeName(host.data)}`;
          host.visitor = { id: e.data.id, until: now + 200 };
        }
      }
    }
    // a colleague at your desk: turn to them (unless you're busy)
    const guest = e.visitor && now < e.visitor.until && employees.get(e.visitor.id);
    if (guest && !busy) look = guest.body.getWorldPosition(visitLook);
    e.body.lookAt(look);
    e.bubble.position.set(e.body.position.x, 2.25 + e.body.position.y - 0.28, e.body.position.z);
    if (busy !== e.screen.userData.busy || (busy && now - e.screen.userData.drawnAt > 110) || (!busy && now - e.screen.userData.drawnAt > 400)) {
      drawScreen(e.screen, busy, t);
      e.screen.userData.busy = busy;
      e.screen.userData.drawnAt = now;
    }
    if (now > e.blinkAt) { e.blinkAt = now + 2500 + Math.random() * 5000; e.blinkUntil = now + 140; }
    e.eyes.scale.y = now < (e.blinkUntil || 0) ? 0.1 : 1;
    e.sphere.material.emissiveIntensity = 0.08 + e.busyAmt * (0.6 + Math.sin(t * 6 + e.phase) * 0.25);
    e.aura.material.opacity = e.busyAmt * 0.35;
    e.label.material.opacity = 0.5 + e.busyAmt * 0.45 + (selected === e.data.id ? 0.3 : 0);
    if (busy) setBubble(e.bubble, work.busy.get(e.data.id).prompt || 'working…', e.color);
    else if (talk) setBubble(e.bubble, talk, e.color);
    e.talkAmt = (e.talkAmt || 0) + (((talk && !busy) ? 1 : 0) - (e.talkAmt || 0)) * Math.min(1, dt * 4);
    e.bubble.material.opacity = Math.max(e.busyAmt * 0.95, e.talkAmt * 0.8);
    e.bubble.visible = e.bubble.material.opacity > 0.01;

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

  // the Manager types while it answers you in the chat, then watches the team; idle it peeks over at you
  {
    const brief = bossBrief(), writing = !!managerState.chatting;
    boss.busyAmt += ((writing ? 1 : 0) - boss.busyAmt) * Math.min(1, dt * 3);
    const lean = 0.12 * boss.busyAmt - 0.28 * (1 - boss.busyAmt);
    boss.body.position.set(0, (0.28 + Math.sin(t * 1.4 + boss.phase) * 0.04) * (1 - boss.busyAmt) + Math.abs(Math.sin(t * 9)) * 0.05 * boss.busyAmt, lean);
    boss.body.lookAt(writing ? boss.screen.getWorldPosition(screenWorld) : camera.position);
    if (now > boss.blinkAt) { boss.blinkAt = now + 2500 + Math.random() * 5000; boss.blinkUntil = now + 140; }
    boss.eyes.scale.y = now < (boss.blinkUntil || 0) ? 0.1 : 1;
    boss.sphere.material.emissiveIntensity = 0.1 + (brief ? 0.35 + Math.sin(t * 4) * 0.12 : 0) + boss.busyAmt * 0.3;
    const line = bossLine();
    if (line) setBubble(boss.bubble, line, MANAGER_COLOR);
    boss.bubble.visible = !!line;
    boss.bubble.material.opacity = brief ? 0.95 : 0.7;
    boss.label.material.opacity = brief ? 0.95 : 0.6;
    const su = boss.screen.userData;
    if (writing !== su.busy || now - su.drawnAt > (writing ? 110 : 400)) { drawScreen(boss.screen, writing, t); su.busy = writing; su.drawnAt = now; }
  }

  for (const sat of satellites.values()) {
    const busy = sat.data.busy;
    sat.group.position.copy(sat.home).setY(sat.home.y + Math.sin(t * 0.6 + sat.phase) * 0.25);
    sat.group.rotation.y += dt * 0.08;
    sat.glow.material.opacity = busy ? 0.22 + Math.sin(t * 5) * 0.08 : 0.12;
    sat.label.material.opacity = busy ? 0.95 : 0.55;
    for (const d of sat.dots.values()) d.material.opacity = selected === d.userData.id ? 1 : busy ? 0.85 : 0.5;
    const pos = sat.beam.geometry.attributes.position;
    pos.setXYZ(1, sat.group.position.x, sat.group.position.y, sat.group.position.z);
    pos.needsUpdate = true;
    sat.beam.material.opacity = busy ? 0.4 + Math.sin(t * 6) * 0.15 : 0.08;
  }

  // swing the view round to the memory being inspected, and back to the brain after
  const focused = memories.get(selected) || (linkedDot(selected) && { mesh: linkedDot(selected) });
  const room = typeof selected === 'string' && selected.startsWith('dept:') && rooms.get(selected.slice(5));
  if (room) { controls.target.lerp(room.center, Math.min(1, dt * 2)); goHome = true; }
  else if (focused) { focused.mesh.getWorldPosition(focus); controls.target.lerp(focus, Math.min(1, dt * 2.5)); goHome = true; }
  else if (goHome) { controls.target.lerp(HOME, Math.min(1, dt * 2.5)); if (controls.target.lengthSq() < 1e-4) goHome = false; }

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
