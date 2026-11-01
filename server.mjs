// ClaudeOS — local server that turns Claude's memory and skills into a live "brain".
// Shows the active brain (see brains.mjs): its shared-brain file (brain/memory.jsonl), its team in
// .claude/skills, Claude's own memories for that folder, personal and plugin skills from ~/.claude,
// and the activity log written by hooks/claude-os-hook.mjs. Pushes changes over SSE.
// The app folder holds only code; everything personal lives in the data folder (~/.claudeos).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { exec, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createChat } from './chat.mjs';
import { createRegistry, setupBrain, repairHooks, hookCommand, listFolder, slugFor, samePath, inside } from './brains.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();
const CLAUDE = path.join(HOME, '.claude');
const PORT = Number(process.env.PORT || 4747);
const DATA = path.resolve(process.env.CLAUDEOS_HOME || path.join(HOME, '.claudeos'));
const ACTIVITY = path.join(DATA, 'activity.jsonl');
const TEMPLATES = path.join(ROOT, 'templates');
const HOOK = hookCommand(path.join(ROOT, 'hooks', 'claude-os-hook.mjs'), DATA);
const brains = createRegistry({ file: path.join(DATA, 'brains.json') });
// if the app folder moved since a brain was set up, point that brain's hooks at this copy
for (const b of brains.list()) { try { repairHooks(b.path, HOOK); } catch { /* folder may be gone */ } }
const memoryFileOf = brain => path.join(brain.path, 'brain', 'memory.jsonl');

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };

function readFrontmatter(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const fm = {};
  if (m) {
    for (const line of m[1].split(/\r?\n/)) {
      const kv = line.match(/^\s*([\w-]+):\s*(.*)$/);
      if (!kv || kv[2] === '') continue;
      fm[kv[1]] = kv[2].replace(/^["']|["']$/g, '');
    }
  }
  return fm;
}

function listDirs(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); } catch { return []; }
}

function statSafe(file) {
  try { return fs.statSync(file); } catch { return null; }
}

// "C--Users-alex-Desktop-My-Project" -> "My Project"
function projectLabel(slug) {
  const parts = slug.split('-').filter(Boolean);
  const markers = ['Desktop', 'Documents', 'Projects', os.userInfo().username, 'Users'];
  let i = -1;
  for (const m of markers) { i = parts.lastIndexOf(m); if (i >= 0) break; }
  return parts.slice(i + 1).join(' ') || slug;
}

function collectMemories(brain) {
  const out = [];
  const projectsDir = path.join(CLAUDE, 'projects');
  const own = slugFor(brain.path);
  for (const slug of listDirs(projectsDir)) {
    // a new brain starts as an empty cloud: only Claude's memories made in that folder count
    if (!brain.allClaudeMemories && slug !== own && !slug.startsWith(own + '-')) continue;
    const memDir = path.join(projectsDir, slug, 'memory');
    let files;
    try { files = fs.readdirSync(memDir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.md') || f === 'MEMORY.md') continue;
      const file = path.join(memDir, f);
      const fm = readFrontmatter(file) || {};
      const st = statSafe(file);
      out.push({
        id: `${slug}/${f}`,
        name: fm.name || f.replace(/\.md$/, ''),
        description: fm.description || '',
        type: fm.type || (f.split('_')[0]) || 'project',
        project: slug,
        projectLabel: projectLabel(slug),
        created: st ? Math.round(st.birthtimeMs || st.mtimeMs) : 0,
      });
    }
  }
  return out;
}

// Every observation in the shared brain is one memory point, grouped by its entity.
function collectBrain(brain) {
  let text, st;
  try { text = fs.readFileSync(memoryFileOf(brain), 'utf8'); st = fs.statSync(memoryFileOf(brain)); } catch { return []; }
  const out = [];
  const lines = text.split('\n').filter(Boolean);
  let order = 0;
  for (const line of lines) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.type !== 'entity') continue;
    for (const obs of e.observations || []) {
      let h = 0;
      for (let i = 0; i < obs.length; i++) h = (Math.imul(h, 31) + obs.charCodeAt(i)) | 0;
      out.push({
        id: `brain/${e.name}/${(h >>> 0).toString(36)}`,
        name: e.name,
        description: obs,
        type: 'brain',
        project: `brain:${e.name}`,
        projectLabel: `Shared brain · ${e.name}`,
        // the file has no per-observation dates; keep file order for the fill-in animation
        created: Math.round(st.mtimeMs) - 100000 + order++,
      });
    }
  }
  return out;
}

function skillsIn(dir, source, owner) {
  const out = [];
  for (const name of listDirs(dir)) {
    const file = path.join(dir, name, 'SKILL.md');
    const fm = readFrontmatter(file);
    if (!fm) continue;
    const st = statSafe(file);
    out.push({
      id: `${source}:${owner ? owner + ':' : ''}${fm.name || name}`,
      name: fm.name || name,
      invokeAs: owner ? `${owner}:${fm.name || name}` : (fm.name || name),
      description: fm.description || '',
      source, owner: owner || null,
      created: st ? Math.round(st.birthtimeMs || st.mtimeMs) : 0,
    });
  }
  return out;
}

function collectSkills(brain) {
  const skills = [...skillsIn(path.join(CLAUDE, 'skills'), 'personal')];
  try {
    const installed = JSON.parse(fs.readFileSync(path.join(CLAUDE, 'plugins', 'installed_plugins.json'), 'utf8'));
    for (const [key, entries] of Object.entries(installed.plugins || {})) {
      const plugin = key.split('@')[0];
      for (const e of entries) skills.push(...skillsIn(path.join(e.installPath, 'skills'), 'plugin', plugin));
    }
  } catch { /* no plugins */ }
  skills.push(...skillsIn(path.join(brain.path, '.claude', 'skills'), 'project', path.basename(brain.path)));
  const seen = new Set();
  return skills.filter(s => !seen.has(s.id) && seen.add(s.id));
}

function collectActivity(brain) {
  let text;
  try { text = fs.readFileSync(ACTIVITY, 'utf8'); } catch { return []; }
  return text.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(ev => ev && ev.cwd && (samePath(ev.cwd, brain.path) || inside(ev.cwd, brain.path))).slice(-400);
}

// Employee names are handed out once and kept in data/names.json, so a skill keeps its name
// when files move or new skills are hired (a removed skill's name stays reserved for it).
const NAMES_FILE = path.join(DATA, 'names.json');
const FIRST_NAMES = ['Ada', 'Bram', 'Cleo', 'Dax', 'Esme', 'Finn', 'Gia', 'Hugo', 'Iris', 'Jude', 'Kai', 'Lena',
  'Milo', 'Nova', 'Otto', 'Pia', 'Quinn', 'Rhea', 'Sol', 'Tess', 'Uma', 'Vik', 'Wren', 'Xan', 'Yara', 'Zed',
  'Arlo', 'Bea', 'Cass', 'Dov', 'Elio', 'Faye', 'Gus', 'Hana', 'Ivo', 'Juno', 'Kit', 'Lux', 'Mae', 'Nico',
  'Orla', 'Pax', 'Remy', 'Sage', 'Theo', 'Vera', 'Wade', 'Yuki', 'Zara', 'Ezra'];
let names = {};
try { names = JSON.parse(fs.readFileSync(NAMES_FILE, 'utf8')); } catch { /* first run */ }

function nameSkills(skills) {
  const used = new Set(Object.values(names));
  let changed = false;
  for (const s of [...skills].sort((a, b) => a.created - b.created || a.id.localeCompare(b.id))) {
    if (names[s.id]) continue;
    let h = 0;
    for (let i = 0; i < s.id.length; i++) h = (Math.imul(h, 31) + s.id.charCodeAt(i)) | 0;
    const start = (h >>> 0) % FIRST_NAMES.length;
    let n = 0, name;
    do { name = FIRST_NAMES[(start + n) % FIRST_NAMES.length] + (n >= FIRST_NAMES.length ? ` ${Math.floor(n / FIRST_NAMES.length) + 1}` : ''); n++; }
    while (used.has(name));
    names[s.id] = name;
    used.add(name);
    changed = true;
  }
  if (changed) {
    try { fs.mkdirSync(path.dirname(NAMES_FILE), { recursive: true }); fs.writeFileSync(NAMES_FILE, JSON.stringify(names, null, 2)); } catch { /* names still work this session */ }
  }
  return names;
}

function snapshot() {
  const brain = brains.active();
  const list = brains.list().map(b => ({ id: b.id, name: b.name, path: b.path }));
  if (!brain) return { brain: null, brains: list, memories: [], skills: [], names: {}, activity: [], at: Date.now() }; // first run
  const skills = collectSkills(brain);
  return {
    brain: { id: brain.id, name: brain.name, path: brain.path },
    brains: list,
    memories: [...collectBrain(brain), ...collectMemories(brain)], skills, names: { ...nameSkills(skills) },
    activity: collectActivity(brain), at: Date.now(),
  };
}

// Poll instead of fs.watch: cheap at this size and reliable across OneDrive/Windows.
let last = snapshot();
let lastKey = keyOf(last);
const clients = new Set();
function keyOf(s) {
  return JSON.stringify([s.brain?.id, s.brains, s.memories.map(m => m.id + m.description), s.skills.map(s => s.id), s.activity.length && s.activity[s.activity.length - 1]]);
}
function refresh() {
  const next = snapshot();
  const k = keyOf(next);
  if (k === lastKey) return;
  last = next; lastKey = k;
  const payload = `data: ${JSON.stringify(next)}\n\n`;
  for (const res of clients) res.write(payload);
}
setInterval(refresh, 1200);

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(payload);
}

// The chat can run commands on this PC, so only this page may use it: a per-start token that only
// the served page knows, plus Host/Origin checks against other sites and DNS rebinding.
const TOKEN = crypto.randomBytes(24).toString('hex');
const LOCAL_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);
// one chat (conversation + history) per brain; only the active brain's chat is used
const chats = new Map();
function chatFor(brain) {
  if (!chats.has(brain.id)) {
    chats.set(brain.id, createChat({ cwd: brain.path, memoryFile: memoryFileOf(brain), appDir: ROOT,
      stateFile: path.join(DATA, 'chats', `${brain.id}.json`), port: PORT, token: TOKEN, broadcast }));
  }
  return chats.get(brain.id);
}
const anyBusy = () => [...chats.values()].some(c => c.snapshot().busy);

const BAD_NAME = /[<>:"/\\|?*\x00-\x1f]|^\.+$|^(con|prn|aux|nul|com\d|lpt\d)$/i;
function switchTo(brain) {
  brains.activate(brain.id);
  refresh();
  broadcast('brain', { id: brain.id });
  return { ok: true, brain: last.brain };
}
function createBrain({ name, parent, template }) {
  name = String(name || '').trim();
  if (!name || BAD_NAME.test(name)) return { error: 'Pick a folder name without \\ / : * ? " < > |' };
  parent = String(parent || '').trim();
  if (!parent || !fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) return { error: `Can't find the folder ${parent || '(none)'}.` };
  const dir = path.join(parent, name);
  if (brains.byPath(dir)) return { error: 'That folder is already one of your brains.' };
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) return { error: `${dir} already exists and isn't empty. Use "Add existing folder" for it instead.` };
  fs.mkdirSync(dir, { recursive: true });
  const created = setupBrain(dir, { name, hookCommand: HOOK, template, templatesDir: TEMPLATES });
  const brain = brains.add({ id: crypto.randomUUID(), name, path: dir, created: Date.now(), allClaudeMemories: false });
  return { ...switchTo(brain), created };
}
function addBrain({ folder }) {
  folder = String(folder || '').trim();
  if (!folder || !fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) return { error: `Can't find the folder ${folder || '(none)'}.` };
  const dir = path.resolve(folder);
  const existing = brains.byPath(dir);
  if (existing) return { ...switchTo(existing), created: [] };
  const created = setupBrain(dir, { hookCommand: HOOK, templatesDir: TEMPLATES });
  const brain = brains.add({ id: crypto.randomUUID(), name: path.basename(dir) || dir, path: dir, created: Date.now(), allClaudeMemories: false });
  return { ...switchTo(brain), created };
}

// Is Claude Code installed? The setup screen warns new users if it isn't.
let healthCache = null;
function health() {
  if (healthCache) return healthCache;
  healthCache = new Promise(resolve => {
    // through the shell so a claude.cmd from npm counts too; the command is fixed text, nothing user-supplied
    exec('claude --version', { windowsHide: true, timeout: 15000 }, (err, out) =>
      resolve({ claude: err ? null : String(out).trim(), dataDir: DATA }));
  });
  healthCache.then(h => { if (!h.claude) healthCache = null; }); // check again next time if it was missing
  return healthCache;
}

function readJson(req) {
  return new Promise(resolve => {
    let body = '';
    req.on('data', d => { body += d; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch { resolve({}); } });
  });
}
function json(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
}

async function handleApi(req, res, url) {
  const origin = req.headers.origin;
  if (req.headers['x-claudeos-token'] !== TOKEN || (origin && !LOCAL_HOSTS.has(origin.replace(/^https?:\/\//, '')))) {
    return json(res, 403, { error: 'forbidden' });
  }
  if (url.pathname === '/api/fs' && req.method === 'GET') return json(res, 200, listFolder(url.searchParams.get('dir') || ''));
  if (url.pathname === '/api/health' && req.method === 'GET') return json(res, 200, await health());
  const active = brains.active();
  const chat = active ? chatFor(active) : null;
  if (url.pathname === '/api/chat' && req.method === 'GET') return json(res, 200, chat ? chat.snapshot() : { messages: [], busy: false, approvals: [] });
  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
  const body = await readJson(req);
  if (url.pathname.startsWith('/api/brains/')) {
    if (anyBusy()) return json(res, 200, { error: 'Claude is still answering. Wait for it, or press Stop, before changing brains.' });
    try {
      if (url.pathname === '/api/brains/switch') { const b = brains.find(body.id); return json(res, 200, b ? switchTo(b) : { error: 'Unknown brain.' }); }
      if (url.pathname === '/api/brains/create') return json(res, 200, createBrain(body));
      if (url.pathname === '/api/brains/add') return json(res, 200, addBrain(body));
      if (url.pathname === '/api/brains/remove') {
        const b = brains.find(body.id);
        if (!b) return json(res, 200, { error: 'Unknown brain.' });
        const wasActive = brains.active().id === b.id;
        brains.remove(b.id);
        chats.delete(b.id);
        fs.rmSync(path.join(DATA, 'chats', `${b.id}.json`), { force: true }); // its chat history; the folder itself stays
        if (wasActive && brains.active()) switchTo(brains.active()); else { refresh(); broadcast('brain', { id: null }); }
        return json(res, 200, { ok: true });
      }
    } catch (err) { return json(res, 200, { error: err.message }); }
  }
  if (!chat && (url.pathname.startsWith('/api/chat') || url.pathname.startsWith('/api/approval'))) return json(res, 200, { error: 'Set up a brain first.' });
  if (url.pathname === '/api/chat') return json(res, 200, chat.send(body.text));
  if (url.pathname === '/api/chat/stop') { chat.stop(); return json(res, 200, { ok: true }); }
  if (url.pathname === '/api/chat/new') return json(res, 200, chat.reset());
  if (url.pathname === '/api/approval') return json(res, 200, await chat.requestApproval(body));
  if (url.pathname === '/api/approval/answer') return json(res, 200, chat.answerApproval(body.id, body.allow));
  return json(res, 404, { error: 'not found' });
}

const server = http.createServer((req, res) => {
  if (!LOCAL_HOSTS.has(req.headers.host)) { res.writeHead(421); return res.end('wrong host'); }
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/chat') || url.pathname.startsWith('/api/approval') || url.pathname.startsWith('/api/brains') || url.pathname === '/api/fs' || url.pathname === '/api/health') {
    return handleApi(req, res, url).catch(err => json(res, 500, { error: err.message }));
  }
  if (url.pathname === '/api/state') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(last));
  }
  if (url.pathname === '/api/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify(last)}\n\n`);
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => { clients.delete(res); clearInterval(ping); });
    return;
  }
  if (url.pathname === '/' || url.pathname === '/index.html') {
    // hand the page its token
    return fs.readFile(path.join(ROOT, 'public', 'index.html'), 'utf8', (err, html) => {
      if (err) { res.writeHead(500); return res.end(); }
      res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
      res.end(html.replace('__CLAUDEOS_TOKEN__', TOKEN));
    });
  }
  let rel = url.pathname;
  let base = path.join(ROOT, 'public');
  if (rel.startsWith('/vendor/three/')) { base = path.join(ROOT, 'node_modules', 'three'); rel = rel.slice('/vendor/three'.length); }
  const file = path.normalize(path.join(base, decodeURIComponent(rel)));
  if (!file.startsWith(base)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://localhost:${PORT}`;
  console.log(`ClaudeOS running at ${url}  (data: ${DATA})`);
  if (process.argv.includes('--open')) {
    const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : [process.platform === 'darwin' ? 'open' : 'xdg-open', [url]];
    spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  }
});
server.on('error', err => {
  if (err.code === 'EADDRINUSE') { console.log(`ClaudeOS is already running at http://localhost:${PORT}`); process.exit(0); }
  throw err;
});
