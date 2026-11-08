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
import { createBenchmark } from './benchmark/panel/server.mjs';
import { createChat, employeeChatId, withEngine } from './chat.mjs';
import { craftOf } from './public/minds.js';
import { codexModels, codexStatus, codexCommand, codexLimits } from './codex.mjs';
import { findFiles } from './files.mjs';
import { createSchedules } from './schedules.mjs';
import { createPlugins } from './plugins.mjs';
import { runHandoff } from './handoff.mjs';
import { createManager } from './manager.mjs';
import { modelCatalog } from './model-routing.mjs';
import { createTerminals } from './terminals.mjs';
import { createGit } from './git.mjs';
import { createArtifacts } from './artifacts.mjs';
import { createPreviews } from './previews.mjs';
import { openFile } from './openfile.mjs';
import { createMemoryEditor, observationId } from './memory-edit.mjs';
import { createCompactor, sizeOf as memorySizeOf } from './memory-compact.mjs';
import { createSkillEditor } from './skill-edit.mjs';
import { createOrg } from './org.mjs';
import { createGrades, finishedRuns } from './grades.mjs';
import { createCoaching } from './coaching.mjs';
import { ensureCabinet, findCabinet, cabinetTree } from './cabinets.mjs';
import { appsInText, appForServer } from './public/apps.js';
import { CATALOG, CONNECTORS_URL, KEY_HELP, addIntegration, removeIntegration, loginIntegration, isSigningIn, signInLink, cancelLogin, sendLoginRedirect, logoutIntegration, keysFor, saveKey, setPtyLoader } from './integrations.mjs';
import { createAccounts } from './accounts.mjs';
import { refreshPath, findExe } from './agents.mjs';
import { createRegistry, setupBrain, repairHooks, listFolder, slugFor, samePath, inside } from './brains.mjs';
import { IS_EXE, helper, memoryServer, hookCommand, templatesDir, pageFile, loadNodePty, appVersion, benchmarkDir } from './runtime.mjs';
import { startTray } from './tray.mjs';
import { createDesktop, openPage as openWindow, showPage as showWindow } from './desktop.mjs';
import { createUpdater } from './update.mjs';
import { IS_DESKTOP, desktopEvent } from './desktop-bridge.mjs';

const HOME = os.homedir();
const CLAUDE = path.resolve(process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude'));
const PORT = Number(process.env.PORT || 4747);
const DATA = path.resolve(process.env.CLAUDEOS_HOME || path.join(HOME, '.claudeos'));
const ACTIVITY = path.join(DATA, 'activity.jsonl');
let ptyModule = null;
setPtyLoader(() => (ptyModule ||= loadNodePty(DATA)));
const TEMPLATES = templatesDir(DATA);
const HOOK = hookCommand(DATA);
const brains = createRegistry({ file: path.join(DATA, 'brains.json') });
// if the app folder moved since a brain was set up, point that brain's hooks at this copy
// each brain's building: departments, who sits where, and their projects
const org = createOrg({ dir: path.join(DATA, 'org') });
const desktop = createDesktop({ dataDir: DATA });
desktop.repairLogin();
const memoryFileOf = brain => path.join(brain.path, 'brain', 'memory.jsonl');
for (const b of brains.list()) { try { repairHooks(b.path, HOOK, memoryServer(memoryFileOf(b))); } catch { /* folder may be gone */ } }

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };

function readFrontmatter(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const fm = {};
  if (m) {
    for (const line of m[1].split(/\r?\n/)) {
      const kv = line.match(/^\s*([\w-]+):\s*(.*)$/);
      if (!kv || kv[2] === '') continue;
      let v = kv[2];
      if (v.startsWith('"')) { try { v = JSON.parse(v); } catch { /* not JSON-style quoting */ } }
      fm[kv[1]] = String(v).replace(/^["']|["']$/g, '');
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
      out.push({
        id: observationId(e.name, obs),
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

// the other files a skill brings (scripts, references, assets), not counting SKILL.md
function skillFiles(dir, max = 200) {
  const out = [];
  const walk = (d, depth) => {
    let items;
    try { items = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      if (out.length >= max || it.name.startsWith('.') || it.name === 'node_modules' || it.name === '__pycache__') continue;
      const rel = path.relative(dir, path.join(d, it.name));
      if (it.isDirectory()) { if (depth < 3) walk(path.join(d, it.name), depth + 1); } else if (rel !== 'SKILL.md') out.push(rel);
    }
  };
  walk(dir, 0);
  return out;
}

function skillsIn(dir, source, owner) {
  const out = [];
  for (const name of listDirs(dir)) {
    const file = path.join(dir, name, 'SKILL.md');
    const fm = readFrontmatter(file);
    if (!fm) continue;
    const st = statSafe(file);
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { /* read above, gone now */ }
    out.push({
      id: `${source}:${owner ? owner + ':' : ''}${fm.name || name}`,
      folder: name,
      name: fm.name || name,
      invokeAs: owner ? `${owner}:${fm.name || name}` : (fm.name || name),
      description: fm.description || '',
      source, owner: owner || null, file,
      constraints: text.split(/\r?\n/).filter(line => /\b(must not|never|do not)\b/i.test(line)).map(line => line.trim()).slice(0, 80),
      apps: appsInText(text), // integrations its SKILL.md uses or names
      craft: craftOf(text, fm.description, skillFiles(path.join(dir, name))), // what its SKILL.md gives it to work with
      // a model or effort the SKILL.md itself asks for
      ...(fm.model && fm.model !== 'inherit' ? { model: fm.model } : {}), ...(fm.effort ? { effort: fm.effort } : {}),
      created: st ? Math.round(st.birthtimeMs || st.mtimeMs) : 0,
    });
  }
  return out;
}

// Home is the user's own Claude (~/.claude): its team is the personal skills, and it has every plugin
// Claude has turned on. Every other brain starts clean: personal skills are blocked in its chats and
// plugins are off unless that brain's own settings turn one on. A brain hires copies from Home.
function installedPlugins() {
  try {
    const installed = JSON.parse(fs.readFileSync(path.join(CLAUDE, 'plugins', 'installed_plugins.json'), 'utf8'));
    return Object.entries(installed.plugins || {}).map(([key, entries]) => ({ key, name: key.split('@')[0], dirs: entries.map(e => path.join(e.installPath, 'skills')) }));
  } catch { return []; }
}
function enabledPluginsIn(...files) {
  const on = {};
  for (const f of files) { try { Object.assign(on, JSON.parse(fs.readFileSync(f, 'utf8')).enabledPlugins || {}); } catch { /* none there */ } }
  return on;
}
function pluginsOn(brain) {
  const user = enabledPluginsIn(path.join(CLAUDE, 'settings.json'));
  if (brain.home) return new Set(Object.keys(user).filter(k => user[k]));
  const own = enabledPluginsIn(path.join(brain.path, '.claude', 'settings.json'), path.join(brain.path, '.claude', 'settings.local.json'));
  return new Set(Object.keys(own).filter(k => own[k]));
}
const teamSkills = brain => skillsIn(teamDir(brain), 'project', path.basename(brain.path));
// what a chat, employee run or hand-off in this brain starts with, on top of Claude's own settings
function scopeFor(brain) {
  if (!brain || brain.home) return { disallowed: [], settings: null };
  const own = new Set(teamSkills(brain).map(s => s.name));
  const disallowed = skillsIn(path.join(CLAUDE, 'skills'), 'personal').filter(s => !own.has(s.name)).map(s => `Skill(${s.name})`);
  const on = pluginsOn(brain);
  const off = Object.fromEntries(installedPlugins().filter(p => !on.has(p.key)).map(p => [p.key, false]));
  return { disallowed, settings: Object.keys(off).length ? { enabledPlugins: off } : null };
}

function collectSkills(brain) {
  const skills = [];
  const on = pluginsOn(brain);
  for (const p of installedPlugins()) if (on.has(p.key)) for (const d of p.dirs) skills.push(...skillsIn(d, 'plugin', p.name));
  skills.push(...teamSkills(brain));
  const seen = new Set();
  return skills.filter(s => !seen.has(s.id) && seen.add(s.id));
}

// How each employee thinks: the model and effort of their own chat box if they have one, else the Manager's
// (whose chats hand them most work); a model in the SKILL.md wins. JSON files are read again only when they change.
const jsonCache = new Map();
function readJsonCached(file) {
  const st = statSafe(file);
  if (!st) return null;
  const hit = jsonCache.get(file);
  if (hit && hit.mtime === st.mtimeMs) return hit.value;
  let value = null;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* half-written: next time */ }
  jsonCache.set(file, { mtime: st.mtimeMs, value });
  return value;
}
function mindsOf(brain, skills) {
  const dir = path.join(DATA, 'chats', brain.id);
  const idx = readJsonCached(path.join(dir, 'index.json')) || {};
  const user = readJsonCached(path.join(CLAUDE, 'settings.json')) || {};
  const pick = o => o.engine === 'codex' ? { engine: 'codex', model: o.codexModel || '', effort: o.codexEffort || '' } : { engine: 'claude', model: o.model || '', effort: o.effort || '' };
  const manager = pick(withEngine(idx.options || {}));
  const out = {};
  for (const s of skills) {
    const ownOpts = idx.empOptions?.[s.id] || readJsonCached(path.join(dir, employeeChatId(s.id) + '.json'))?.options;
    const own = ownOpts && (ownOpts.model || ownOpts.effort || ownOpts.engine || ownOpts.codexModel) ? pick(withEngine(ownOpts)) : null;
    const base = own || manager;
    const m = { engine: base.engine, model: base.model, effort: base.effort, from: own ? 'own' : 'manager' };
    if (m.engine === 'claude') {
      if (s.model) Object.assign(m, { model: s.model, modelFrom: 'skill' });
      if (s.effort) Object.assign(m, { effort: s.effort, effortFrom: 'skill' });
      if (!m.model && user.model) Object.assign(m, { model: user.model, modelFrom: 'settings' });
      if (!m.effort && user.effortLevel) Object.assign(m, { effort: user.effortLevel, effortFrom: 'settings' });
    }
    out[s.id] = m;
  }
  return out;
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
  if (changed) saveNames();
  return names;
}
function saveNames() {
  try { fs.mkdirSync(path.dirname(NAMES_FILE), { recursive: true }); fs.writeFileSync(NAMES_FILE, JSON.stringify(names, null, 2)); } catch { /* names still work this session */ }
}

// Home: the brain ClaudeOS opens with, in Claude's own folder. Made once; it takes over reading
// Claude's memories from every folder, and the personal skills keep the names they had.
function ensureHome() {
  let home = brains.home();
  if (!home) {
    const existing = brains.byPath(CLAUDE);
    setupBrain(CLAUDE, { name: 'Home', hookCommand: HOOK, memoryServer, templatesDir: TEMPLATES, home: true });
    for (const b of brains.list()) if (b.allClaudeMemories && b !== existing) brains.update(b.id, { allClaudeMemories: false });
    home = existing ? brains.update(existing.id, { home: true, allClaudeMemories: true })
      : brains.add({ id: crypto.randomUUID(), name: 'Home', path: CLAUDE, created: Date.now(), allClaudeMemories: true, home: true });
    const owner = path.basename(CLAUDE);
    for (const [id, name] of Object.entries(names)) if (id.startsWith('personal:')) names[`project:${owner}:${id.slice('personal:'.length)}`] ||= name;
    saveNames();
  }
  brains.activate(home.id); // the app always opens in Home
}
try { ensureHome(); } catch (e) { console.error('Could not set up the Home brain:', e.message); }

// Compact brain (Memory tab and the top bar): oversized memory entries rewritten short, with a backup and Undo
const compactor = createCompactor({ dataDir: DATA });
const memorySize = brain => { try { return { ...memorySizeOf(memoryFileOf(brain)), busy: compactor.busy(brain.id), canUndo: compactor.canUndo(brain) }; } catch { return null; } };
// The quality of each finished run: Haiku's grade and the user's thumbs (grades.mjs)
const grades = createGrades({ file: path.join(DATA, 'grades.json'), onChange: () => refresh(), onCorrection: event => {
  const b = brains.active();
  if (b && b.id === event.brain) broadcast('skill-correction', { ...event, brain: b.id });
} });
const coaching = createCoaching({ file: path.join(DATA, 'coaching.json'), backupDir: path.join(DATA, 'coaching'), onChange: () => refresh() });
function withGrades(activity) { return { activity, grades: grades.for(finishedRuns(activity).map(r => r.key)) }; }
setInterval(() => { const b = brains.active(); if (b) grades.tick(collectActivity(b), coachable(b)).catch(() => {}); }, 15000);

function snapshot() {
  const brain = brains.active();
  const list = brains.list().map(b => ({ id: b.id, name: b.name, path: b.path, links: b.links || [], home: !!b.home }));
  if (!brain) return { brain: null, brains: list, memories: [], skills: [], names: {}, activity: [], at: Date.now() }; // first run
  const skills = collectSkills(brain);
  return {
    brain: { id: brain.id, name: brain.name, path: brain.path, home: !!brain.home },
    brains: list,
    foundations: (() => {
      const file = path.join(brain.path, 'CLAUDE.md');
      try { const st = fs.statSync(file); return { file, modified: st.mtimeMs, text: fs.readFileSync(file, 'utf8').slice(0, 60000), truncated: st.size > 60000 }; }
      catch { return { file, text: '', missing: true }; }
    })(),
    memories: [...collectBrain(brain), ...collectMemories(brain)], memorySize: memorySize(brain), skills, names: { ...nameSkills(skills) },
    minds: mindsOf(brain, skills),
    // linked brains: their shared brain (read-only here), their own team, and whether they're working for us
    linked: brains.linksOf(brain).map(b => ({ id: b.id, name: b.name, path: b.path, busy: handoffs.has(b.id),
      memories: collectBrain(b), skills: teamSkills(b) })),
    // a clean brain hires from Home: the user's personal skills, copied into this brain's team
    home: brain.home || !brains.home() ? null : { id: brains.home().id, name: brains.home().name, skills: teamSkills(brains.home()) },
    ...withGrades(collectActivity(brain)), coaching: coaching.view(skills.map(s => s.id)), at: Date.now(), org: org.snapshot(brain.id),
    integrations: integrations.brainId === brain.id ? integrations.list : [],
  };
}

// The integrations (MCP servers) Claude has in the active brain, from `claude mcp list`. It starts
// every server to check it, so it runs in the background now and then, never per page update.
// ClaudeOS's own servers (memory, claudeos, brain_N) aren't integrations.
const INTEGRATIONS_TTL = 10 * 60 * 1000;
let integrations = { brainId: null, at: 0, list: [], running: false };
function checkIntegrations(brain, force) {
  if (!brain || integrations.running) return;
  if (!force && integrations.brainId === brain.id && Date.now() - integrations.at < INTEGRATIONS_TTL) return;
  integrations.running = true;
  broadcast('integrations', integrationsView(brain));
  exec('claude mcp list', { cwd: brain.path, windowsHide: true, timeout: 90000, maxBuffer: 1 << 20 }, (err, out) => {
    const list = [];
    for (const line of String(out || '').split(/\r?\n/)) {
      const at = line.indexOf(': '), dash = line.lastIndexOf(' - ');
      if (at < 1 || dash < at) continue;
      const server = line.slice(0, at).trim();
      if (/^(memory|claudeos|brain_\d+)$/.test(server)) continue;
      const tail = line.slice(dash + 3);
      const status = /✔|connected/i.test(tail) && !/fail|not connected/i.test(tail) ? 'connected'
        : /approv/i.test(tail) ? 'needs approval' : /fail/i.test(tail) ? 'failed' : /auth/i.test(tail) ? 'needs sign-in' : 'failed';
      // keys it reads from the environment (${FAL_KEY}), and whether the browser sign-in can fix it
      const keys = keysFor(brain.path, server);
      list.push({ server, key: appForServer(server), status, keys, remote: /https?:\/\//.test(line.slice(at, dash)), detail: tail.replace(/^[^\w]+/, '').slice(0, 200) });
    }
    const again = integrations.again;
    integrations = { brainId: brain.id, at: Date.now(), list: err && !list.length ? integrations.list : list, running: false };
    if (again) setTimeout(() => checkIntegrations(brains.active(), true), 0);
    refresh();
    broadcast('integrations', integrationsView(brain));
  });
}
function integrationsView(brain) {
  const list = integrations.brainId === brain?.id ? integrations.list : [];
  return { list: list.map(i => ({ ...i, signingIn: isSigningIn(i.server), signInUrl: signInLink(i.server), keys: (i.keys || []).map(name => ({ name, set: !!process.env[name], help: KEY_HELP[name] || '' })) })),
    checking: integrations.running, checked: integrations.brainId === brain?.id ? integrations.at : 0, catalog: CATALOG, connectorsUrl: CONNECTORS_URL,
    accounts: accounts.view() };
}
// the page asks for a fresh check after changing something; a check already running counts
function recheck(brain) {
  if (integrations.running) { integrations.again = true; return; }
  checkIntegrations(brain, true);
}

// Tasks handed to linked brains that are running now: brain id -> { stop }.
const handoffs = new Map();

// Poll instead of fs.watch: cheap at this size and reliable across OneDrive/Windows.
let last = snapshot();
let lastKey = keyOf(last);
const clients = new Set();
function keyOf(s) {
  return JSON.stringify([s.brain?.id, s.memorySize, s.foundations, s.skills.map(x => x.constraints), s.brains, s.integrations?.map(i => i.server + i.status), s.skills.map(x => x.apps?.map(a => a.key).join()), s.linked?.map(l => [l.id, l.busy, l.memories.length, l.skills.length]), s.memories.map(m => m.id + m.description), s.skills.map(s => s.id + s.craft?.score), s.minds, s.activity.length && s.activity[s.activity.length - 1], s.grades, s.coaching, s.org]);
}
function refresh() {
  checkIntegrations(brains.active());
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
// which start of the server a page talks to: a page from an earlier one reloads (its token is stale)
const BOOT = crypto.randomBytes(6).toString('hex');
const LOCAL_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);
// The chats' desk: shell tabs Claude and the user share, and the artifacts Claude publishes
// (served on their own port, so a page can never reach this one's token or API).
const terminals = createTerminals({ broadcast, data: DATA });
const gitPane = createGit();
// Claude Code and Codex may have been installed after Windows gave this process its PATH
refreshPath();
// GitHub (gh) and other sign-ins that aren't MCP servers; shown with the integrations
const accounts = createAccounts({ open: url => openWindow(url, { appWindow: false }), broadcast: done => {
  if (done) broadcast('account-login', done);
  broadcast('accounts', accounts.view());
  broadcast('integrations', integrationsView(brains.active()));
} });
const ARTIFACT_PORT = Number(process.env.ARTIFACT_PORT || PORT + 10);
const previews = createPreviews({ port: () => ARTIFACT_PORT, broadcast });
const artifacts = createArtifacts({ dir: path.join(DATA, 'artifacts'), port: ARTIFACT_PORT, broadcast, extra: previews.handle });
// a browser of Claude's own (Playwright's MCP server), with sign-ins kept in the data folder
const browserServer = () => ({ command: 'npx', args: ['-y', '@playwright/mcp@latest', '--user-data-dir', path.join(DATA, 'browser')] });
// the brain whose chats include this one (a desk tool call names its chat)
const chatOwning = id => [...chats.values()].find(c => c.owns(id));
async function desk(tool, a) {
  const owner = chatOwning(String(a.chat || ''));
  if (!owner) return { error: 'This chat is not running in ClaudeOS anymore.' };
  if (tool === 'model_catalog') return { text: JSON.stringify(modelCatalog(), null, 2) };
  if (tool === 'run_model_task') {
    const brainId = [...chats.entries()].find(([, c]) => c === owner)?.[0];
    const brain = brains.find(brainId);
    if (!brain) return { error: 'This brain is no longer registered.' };
    const parent = a.parentSelection || {};
    return managerFor(brain).specialist({ ...a, caller: a.modelCaller || owner.optionsFor(a.chat),
      requiredEngine: parent.requiredEngine || (parent.fallback === false && parent.model ? parent.engine : undefined),
      requiredModel: parent.fallback === false ? parent.model : undefined,
      allowFallback: parent.fallback !== false, workDir: owner.chatFolder(a.chat), fromBrief: !!a.modelCaller });
  }
  const state = t => `${t.title} (tab ${t.id}, ${t.cwd}): ${t.running ? 'running' : t.code == null ? 'idle' : `exited with code ${t.code}`}`;
  if (tool === 'terminal_run') {
    const r = terminals.run({ command: a.command, tab: a.tab, title: a.title, cwd: a.cwd || owner.chatFolder(a.chat), by: 'Claude' });
    return r.error ? r : { text: `Running in the Terminal tab "${r.tab.title}" (tab ${r.tab.id}). Read its output with terminal_read.` };
  }
  if (tool === 'terminal_read') {
    const r = await terminals.read({ tab: a.tab, lines: a.lines, wait: a.wait_ms });
    return r.error ? r : { text: `${state(r.tab)}\n\n${r.text || '(no output yet)'}` };
  }
  if (tool === 'terminal_list') { const l = terminals.list(); return { text: l.length ? l.map(state).join('\n') : 'No terminal tabs.' }; }
  if (tool === 'terminal_stop') { const r = a.close ? terminals.close(a.tab) : terminals.stop(a.tab); return r.error ? r : { text: a.close ? 'Stopped and closed.' : 'Stopped.' }; }
  if (tool === 'publish_artifact') {
    const r = artifacts.publish({ file: a.file_path, title: a.title, description: a.description, id: a.id, chat: a.chat });
    return r.error ? r : { text: `${r.updated ? 'Updated' : 'Published'} “${r.artifact.title}” (id ${r.artifact.id}): ${r.artifact.url}\nIt shows in the ClaudeOS Artifacts tab. Give the user this link.` };
  }
  if (tool === 'update_app') {
    const brain = [...chats.entries()].find(([, c]) => c === owner)?.[0] || '';
    const r = updater.request({ chat: a.chat, brain, kind: a.rollback ? 'rollback' : 'update', installer: a.installer });
    if (IS_DESKTOP && !r.error && a.rollback) return { text: `ClaudeOS goes back to ${r.version} ${r.waiting ? 'as soon as every chat (this one included) has finished its turn' : 'now'}: it closes, installs it and opens again on this chat. The version it leaves is kept, so updating again brings it back. End your turn now.` };
    if (IS_DESKTOP && !r.error && a.installer) return { text: `ClaudeOS installs ${r.version} ${r.waiting ? 'as soon as every chat (this one included) has finished its turn' : 'now'}: it closes, installs and opens again on this chat, where you get a message to finish up. End your turn now.` };
    if (IS_DESKTOP && !r.error) return { text: updater.status().ready ? 'The desktop app will install the downloaded release after working chats finish their turns.' : 'Checking GitHub for a desktop release. If one is available, ClaudeOS will offer to download it.' };
    if (!r.error && a.rollback) return { text: `ClaudeOS goes back to the previous build ${r.waiting ? 'as soon as every chat (this one included) has finished its turn' : 'now'}. End your turn now; the page reloads by itself.` };
    return r.error ? r : { text: r.waiting ? 'ClaudeOS restarts into the new build as soon as every chat (this one included) has finished its turn. End your turn now; the page reloads by itself, and the user sees which build is running.' : 'ClaudeOS is restarting into the new build now.' };
  }
  if (tool === 'show_preview') {
    const url = String(a.url || '').trim();
    if (!/^https?:\/\/[^\s]+$/i.test(url)) return { error: 'Give a full http:// or https:// address, like http://localhost:5173.' };
    broadcast('preview-url', { url });
    return { text: `Showing ${url} in the preview panel beside the chat.` };
  }
  if (tool === 'schedule_task') {
    const folder = owner.chatFolder(a.chat);
    const r = schedules.save(brainOfChat(owner), { title: a.title, prompt: a.prompt, repeat: a.repeat, time: a.time, date: a.date, day: a.day, every: a.every_hours, folder: a.folder || folder });
    return r.error ? r : { text: `Scheduled “${r.task.title}” (id ${r.task.id}): ${r.task.when}. Next run ${r.task.nextRun ? new Date(r.task.nextRun).toLocaleString() : 'never'}. Each run is a new chat in this brain; ClaudeOS must be running. The user can change it from the ⏰ button in the chat.` };
  }
  if (tool === 'list_scheduled') {
    const l = schedules.list(brainOfChat(owner));
    return { text: l.length ? l.map(s => `- ${s.id}: ${s.title} · ${s.when}${s.enabled ? '' : ' (paused)'}${s.nextRun ? ` · next ${new Date(s.nextRun).toLocaleString()}` : ''}`).join('\n') : 'No scheduled tasks in this brain.' };
  }
  if (tool === 'delete_scheduled') { const r = schedules.remove(brainOfChat(owner), String(a.id || '')); return r.error ? r : { text: 'Deleted.' }; }
  if (tool === 'start_session') return owner.startSession(a);
  if (tool === 'message_session') return owner.messageSession(a);
  return { error: `Unknown desk tool ${tool}.` };
}

// The account's usage limits (5-hour and weekly windows), as Claude Code reports them with each reply.
// Kept on disk so the page shows the last known numbers after a restart.
const LIMITS_FILE = path.join(DATA, 'limits.json');
let limits = null;
try { limits = JSON.parse(fs.readFileSync(LIMITS_FILE, 'utf8')); } catch { /* none yet */ }
function setLimits(info) {
  limits = { ...info, at: Date.now() };
  try { fs.writeFileSync(LIMITS_FILE, JSON.stringify(limits)); } catch { /* shown anyway */ }
  broadcast('limits', limits);
}

// each brain's chats (any number, each its own conversation); the page shows the active brain's
const chats = new Map();
function chatFor(brain) {
  if (!chats.has(brain.id)) {
    chats.set(brain.id, createChat({ cwd: brain.path, memoryFile: memoryFileOf(brain), globalClaudeDir: CLAUDE, helper, memoryServer, browserServer,
      dir: path.join(DATA, 'chats', brain.id), legacyFile: path.join(DATA, 'chats', `${brain.id}.json`), activityFile: ACTIVITY, port: PORT,
      links: () => brains.linksOf(brain).map(b => ({ id: b.id, name: b.name, memoryFile: memoryFileOf(b) })), token: TOKEN,
      // a brain you switched away from keeps working, out of sight
      broadcast: (event, data) => { if (brains.active()?.id === brain.id) broadcast(event, data); },
      othersWorking: () => managerFor(brain).busy(), team: () => teamOf(brain), projects: () => projectsOf(brain),
      // the chat is the Manager: when it stops, the Manager desk stops typing and unbriefed requests wait again
      onIdle: chatId => { managerFor(brain).stopChatSpecialists(chatId); managerFor(brain).chatDone(chatId); },
      notify: n => notify({ ...n, brain: brain.name }), onLimits: setLimits,
      onCodexTurn: () => setTimeout(() => broadcast('codexLimits', codexLimits()), 800), // Codex writes its log just after
      scope: () => scopeFor(brains.find(brain.id) || brain) }));
  }
  return chats.get(brain.id);
}
// the brain's own employees (project skills), as the Manager assigns them
function teamOf(brain) {
  const skills = skillsIn(teamDir(brain), 'project', path.basename(brain.path));
  nameSkills(skills);
  return skills.map(s => {
    const d = org.deptOf(brain.id, s.id);
    return { skill: s.name, name: names[s.id] || s.name, description: s.description || '', dept: d ? { id: d.id, name: d.name } : null };
  });
}
// ---------- file cabinets ----------
// An employee as their cabinet and their own chat know them (any skill but a contractor).
function employeeOf(brain, skillId) {
  const s = collectSkills(brain).find(x => x.id === skillId);
  if (!s) return null;
  nameSkills([s]);
  return { id: s.id, skill: s.name, name: names[s.id] || s.name, invokeAs: s.invokeAs, dept: org.deptOf(brain.id, s.id)?.name || null };
}
function cabinetFor(brain, skillId) {
  const e = employeeOf(brain, skillId);
  return e ? ensureCabinet(brain.path, e) : null;
}
// after a department change, every cabinet that exists moves to its owner's department folder
function organizeCabinets(brain) {
  for (const s of collectSkills(brain)) {
    if (!findCabinet(brain.path, s.id)) continue;
    try { cabinetFor(brain, s.id); } catch { /* tried again next time */ }
  }
}
// What clicking an employee shows: their own chat, their cabinet's files, and their brief work with its logs.
function employeeView(brain, skillId) {
  const e = employeeOf(brain, skillId);
  if (!e) return { error: 'That employee is gone.' };
  const cabinet = ensureCabinet(brain.path, e);
  const own = skillsIn(teamDir(brain), 'project', path.basename(brain.path)).some(x => x.id === skillId);
  return { id: e.id, cabinet, files: cabinetTree(cabinet), chat: chatFor(brain).employeeChat({ ...e, cabinet }).snapshot(),
    work: own ? managerFor(brain).workOf(e.skill) : [] };
}
function employeeApi(brain, what, body) {
  // the chat box shows this employee's chat (their desk's Chat tab), or the Manager's again
  if (what === 'view' && !body.id) return chatFor(brain).view(null);
  const e = employeeOf(brain, String(body.id || ''));
  if (!e) return { error: 'That employee is gone.' };
  const cabinet = ensureCabinet(brain.path, e);
  const c = chatFor(brain).employeeChat({ ...e, cabinet });
  if (what === 'view') return chatFor(brain).view(c.id);
  if (what === 'open') {
    const target = path.resolve(cabinet, String(body.path || ''));
    const rel = path.relative(cabinet, target);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return Promise.resolve({ error: 'That is not in their cabinet.' });
    return openFile(target, cabinet);
  }
  return { error: 'not found' };
}

// the brain's active projects, as the Manager may put tasks on them
function projectsOf(brain) {
  return org.snapshot(brain.id).departments.flatMap(d => d.projects.filter(p => p.status === 'active')
    .map(p => ({ id: p.id, name: p.name, goal: p.goal, folder: p.folder, dept: d.name })));
}
// one team desk (shared inbox + briefs) per brain; the chat is its Manager
const managers = new Map();
function managerFor(brain) {
  if (!managers.has(brain.id)) {
    managers.set(brain.id, createManager({ cwd: brain.path, dataFile: path.join(DATA, 'manager', `${brain.id}.json`), activityFile: ACTIVITY,
      memoryFile: memoryFileOf(brain), helper, memoryServer, port: PORT, token: TOKEN, team: () => teamOf(brain), scope: () => scopeFor(brains.find(brain.id) || brain),
      optionsFor: (chat, skill) => {
        const base = chatFor(brain).optionsFor(chat);
        const s = teamSkills(brain).find(s => s.name === skill);
        const idx = readJsonCached(path.join(DATA, 'chats', brain.id, 'index.json')) || {};
        return { ...base, ...(s ? idx.empOptions?.[s.id] || {} : {}) };
      },
      inlineRunner: task => chatFor(brain).runInline(task),
      onApproval: (chat, request, who) => chatFor(brain).requestCodexApproval(chat, request, who),
      project: id => org.findProject(brain.id, id),
      cabinet: skill => { const s = skillsIn(teamDir(brain), 'project', path.basename(brain.path)).find(x => x.name === skill); return s ? cabinetFor(brain, s.id) : null; }, logWork: (id, entry) => { org.logWork(brain.id, id, entry); refresh(); },
      chatBusy: () => chatFor(brain).anyBusy(),
      onBriefDone: (brief, text) => chatFor(brain).report(brief.chat, brief.title, text),
      broadcast: (event, data) => {
        if (brains.active()?.id === brain.id) broadcast(event, data);
        if (event !== 'manager') return; // a task's log line
        if (!data.busy) chatFor(brain).dropOthersApprovals();
        refresh();
      } }));
  }
  return managers.get(brain.id);
}
// Claude Code plugins, browsed and installed from the page
const plugins = createPlugins({ broadcast: (e, d) => broadcast(e, d) });
// scheduled tasks: each run is a new chat in the task's brain
const schedules = createSchedules({ file: path.join(DATA, 'schedules.json'), broadcast: (e, d) => broadcast(e, d),
  run: s => { const b = brains.find(s.brain); return b ? chatFor(b).startScheduled(s) : { error: 'its brain is gone' }; } });
const brainOfChat = owner => [...chats.entries()].find(([, c]) => c === owner)?.[0] || '';
const anyBusy = () => [...chats.values()].some(c => c.anyBusy()) || [...managers.values()].some(m => m.busy());
const memoryEditor = createMemoryEditor({ claudeDir: CLAUDE, dataDir: DATA, memoryFileOf });
// only memories the active brain is showing right now can be opened, so an id can't reach other files
function memoryById(brain, id) {
  return [...collectBrain(brain), ...collectMemories(brain)].find(m => m.id === id);
}

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
  const created = setupBrain(dir, { name, hookCommand: HOOK, memoryServer, template, templatesDir: TEMPLATES });
  const brain = brains.add({ id: crypto.randomUUID(), name, path: dir, created: Date.now(), allClaudeMemories: false });
  return { ...switchTo(brain), created };
}
function addBrain({ folder }) {
  folder = String(folder || '').trim();
  if (!folder || !fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) return { error: `Can't find the folder ${folder || '(none)'}.` };
  const dir = path.resolve(folder);
  const existing = brains.byPath(dir);
  if (existing) return { ...switchTo(existing), created: [] };
  const created = setupBrain(dir, { hookCommand: HOOK, memoryServer, templatesDir: TEMPLATES });
  const brain = brains.add({ id: crypto.randomUUID(), name: path.basename(dir) || dir, path: dir, created: Date.now(), allClaudeMemories: false });
  return { ...switchTo(brain), created };
}

// Called (long-poll) by approval-mcp.mjs when the active brain's Claude uses ask_brain.
async function handoff(active, { brain: target, task }, req) {
  if (handoffs.has(active.id)) return { error: 'A linked-brain handoff cannot hand off recursively.' };
  task = String(task || '').trim();
  const want = String(target || '').trim().toLowerCase();
  const b = brains.linksOf(active).find(x => x.name.toLowerCase() === want || x.id === target);
  if (!b) return { error: `"${target}" isn't linked to ${active.name}. Linked brains: ${brains.linksOf(active).map(x => x.name).join(', ') || 'none'}.` };
  if (!task) return { error: 'Say what the linked brain should do.' };
  if (handoffs.has(b.id)) return { error: `${b.name} is already working on a hand-off. Wait for it to finish.` };
  const run = runHandoff({ task, runner: task => chatFor(b).runInline(task), onExit: () => { handoffs.delete(b.id); refresh(); } });
  handoffs.set(b.id, run);
  refresh();
  // if the asking Claude goes away (Stop, crash), stop the linked brain too
  req.on('close', () => { if (handoffs.get(b.id) === run) run.stop(); });
  const r = await run.done;
  return r.error ? { error: `${b.name}: ${r.error}` } : { brain: b.name, result: r.result };
}

// Copies a skill folder from a linked brain's team into the active brain's team.
function copySkill(active, { from, skill }) {
  const b = brains.linksOf(active).find(x => x.id === from) || (brains.home()?.id === from ? brains.home() : null);
  if (!b) return { error: 'Link that brain first.' };
  if (b.id === active.id) return { error: `That skill is already ${active.name}'s.` };
  const s = teamSkills(b).find(x => x.name === skill);
  if (!s) return { error: `${b.name} has no skill called ${skill}.` };
  const dest = path.join(teamDir(active), s.folder);
  if (fs.existsSync(dest)) return { error: `${active.name} already has a ${s.folder} skill folder.` };
  fs.cpSync(path.join(teamDir(b), s.folder), dest, { recursive: true, filter: src => !src.includes('__pycache__') });
  refresh();
  return { ok: true, folder: s.folder };
}

// The active brain's own team is editable from the page; personal and plugin skills are read-only.
const skillEditor = createSkillEditor({ dataDir: DATA });
function teamDir(brain) { return brain.home ? path.join(CLAUDE, 'skills') : path.join(brain.path, '.claude', 'skills'); }
const teamSkill = (brain, id) => skillsIn(teamDir(brain), 'project', path.basename(brain.path)).find(s => s.id === id);
function skillApi(active, route, body) {
  const team = teamDir(active), owner = path.basename(active.path);
  const idOf = name => `project:${owner}:${name}`;
  if (route === 'restore') { const r = skillEditor.restore(String(body.trashId || '')); return r.error ? r : { ...r, id: idOf(r.name) }; }
  const s = body.id ? teamSkill(active, body.id) : null;
  if (body.id && !s) return { error: 'That employee is gone, or isn’t on this brain’s team.' };
  if (route === 'app') {
    if (!s) return { error: 'Pick an employee first.' };
    return skillEditor.addApp(team, s.folder, body.key);
  }
  if (route === 'save') {
    const r = skillEditor.save(team, s?.folder || null, body);
    if (r.error) return r;
    // a rename keeps the employee's first name
    if (s && r.name !== s.name && names[s.id] && !names[idOf(r.name)]) { names[idOf(r.name)] = names[s.id]; delete names[s.id]; saveNames(); }
    // ...and their department
    if (s && r.name !== s.name) org.rename(active.id, s.id, idOf(r.name));
    return { ...r, id: idOf(r.name) };
  }
  if (route === 'fire') {
    if (!s) return { error: 'Pick an employee first.' };
    if (anyBusy()) return { error: 'Claude is still answering. Wait for it, or press Stop, before firing anyone.' };
    return skillEditor.fire(team, s.folder);
  }
  return { error: 'not found' };
}

// The coach (coaching.mjs): an employee whose graded work keeps coming back weak gets better SKILL.md
// instructions, saved right away; Undo puts the old ones back. Checked once a minute, one employee at a time,
// never while a chat or the Manager is working. The Coach button does the same on demand.
function coachable(brain) {
  const team = teamDir(brain);
  return skillsIn(team, 'project', path.basename(brain.path)).map(s => ({ id: s.id, brain: brain.id, name: s.name, file: path.join(team, s.folder, 'SKILL.md'),
    read: () => skillEditor.read(team, s.folder), write: fields => skillEditor.save(team, s.folder, fields) }));
}
function announceCoached(e, r) {
  if (r.ok && e.brain === brains.active()?.id) broadcast('skill-correction', { id: e.id, name: e.name, at: r.at, brain: e.brain });
  if (r.ok) broadcast('coached', { id: e.id, name: e.name, employee: names[e.id] || e.name, summary: r.summary });
}
setInterval(() => {
  const b = brains.active();
  if (!b || anyBusy()) return;
  coaching.tick(coachable(b), finishedRuns(collectActivity(b)), grades.all())
    .then(t => { if (t) announceCoached(t.employee, t.result); }).catch(() => {});
}, 60000);
async function coachSkill(active, body) {
  const e = coachable(active).find(x => x.id === String(body.id || ''));
  if (!e) return { error: 'Only this brain’s own employees can be coached.' };
  const r = await coaching.run(e, finishedRuns(collectActivity(active)), grades.all(), 'manual');
  announceCoached(e, r);
  return r;
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
  // sign-ins for this PC (Claude, Codex, GitHub); the sign-in screen uses them before any brain exists
  if (url.pathname === '/api/accounts' && req.method === 'GET') return json(res, 200, { accounts: accounts.view() });
  const active = brains.active();
  const chat = active ? chatFor(active) : null;
  if (url.pathname === '/api/memory' && req.method === 'GET') {
    const m = active && memoryById(active, url.searchParams.get('id'));
    if (!m) return json(res, 200, { error: 'That memory is gone.' });
    try { return json(res, 200, memoryEditor.read(active, m)); } catch (err) { return json(res, 200, { error: err.message }); }
  }
  if (url.pathname === '/api/skill' && req.method === 'GET') {
    const s = active && collectSkills(active).find(x => x.id === url.searchParams.get('id'));
    if (!s) return json(res, 200, { error: 'That employee is gone.' });
    try {
      const r = skillEditor.read(path.dirname(path.dirname(s.file)), s.folder);
      return json(res, 200, { ...r, editable: !!teamSkill(active, s.id) });
    } catch (err) { return json(res, 200, { error: err.message }); }
  }
  if (url.pathname === '/api/integrations' && req.method === 'GET') return json(res, 200, integrationsView(active));
  if (url.pathname === '/api/chat' && req.method === 'GET') return json(res, 200, chat ? chat.snapshot() : { messages: [], busy: false, approvals: [] });
  if (url.pathname === '/api/limits' && req.method === 'GET') return json(res, 200, { limits, codex: codexLimits() });
  // Codex as a chat's engine: its models and whether it's installed and signed in
  if (url.pathname === '/api/codex' && req.method === 'GET') return json(res, 200, { models: codexModels(), ...(await codexStatus()) });
  // `codex login` opens the ChatGPT sign-in page in the browser and waits for it
  if (url.pathname === '/api/codex/login' && req.method === 'POST') {
    const cmd = codexCommand();
    if (!cmd) return json(res, 200, { error: 'Codex is not installed. Install it with: npm install -g @openai/codex' });
    try { spawn(cmd.command, [...cmd.args, 'login'], { env: { ...process.env, ...cmd.env }, windowsHide: true, stdio: 'ignore' }).on('error', () => {}); }
    catch (err) { return json(res, 200, { error: err.message }); }
    return json(res, 200, { ok: true });
  }
  if (url.pathname === '/api/plugins' && req.method === 'GET') return json(res, 200, await plugins.view({ fresh: url.searchParams.get('fresh') === '1' }));
  if (url.pathname === '/api/schedules' && req.method === 'GET') return json(res, 200, { list: active ? schedules.list(active.id) : [], folder: chat ? chat.chatFolder(chat.currentId()) : null });
  // @mentions: files in the open chat's folder
  if (url.pathname === '/api/chat/files' && req.method === 'GET') {
    if (!chat) return json(res, 200, { files: [] });
    const dir = chat.chatFolder(chat.currentId());
    return json(res, 200, { dir, files: await findFiles(dir, url.searchParams.get('q') || '') });
  }
  if (url.pathname === '/api/chats' && req.method === 'GET') return json(res, 200, chat ? chat.list(url.searchParams.get('q') || '') : { chats: [] });
  if (url.pathname === '/api/employee' && req.method === 'GET') return json(res, 200, active ? employeeView(active, url.searchParams.get('id') || '') : { error: 'Set up a brain first.' });
  if (url.pathname === '/api/manager' && req.method === 'GET') return json(res, 200, active ? managerFor(active).snapshot() : { inbox: [], files: [], briefs: [], busy: false });
  if (url.pathname === '/api/update' && req.method === 'GET') return json(res, 200, updater.status());
  if (url.pathname === '/api/settings' && req.method === 'GET') return json(res, 200, await settingsView());
  // the Git tab: the open chat's repository unless the page names another folder
  const gitDir = d => String(d || '') || (chat ? chat.chatFolder(chat.currentId()) : HOME);
  if (url.pathname === '/api/git' && req.method === 'GET') return json(res, 200, await gitPane.view({ dir: gitDir(url.searchParams.get('dir')), withGithub: url.searchParams.get('gh') === '1', fresh: url.searchParams.get('fresh') === '1' }));
  if (url.pathname === '/api/git/diff' && req.method === 'GET') return json(res, 200, await gitPane.diff({ dir: gitDir(url.searchParams.get('dir')), file: url.searchParams.get('file') || '' }));
  if (url.pathname === '/api/terminals' && req.method === 'GET') return json(res, 200, await terminals.snapshot());
  if (url.pathname === '/api/artifacts' && req.method === 'GET') return json(res, 200, { list: artifacts.list(), port: ARTIFACT_PORT });
  // an attachment's bytes, for the chat's thumbnails (only files under the brain's attachments/)
  if (url.pathname === '/api/chat/file' && req.method === 'GET') {
    const f = chat?.attachmentFile(url.searchParams.get('path'));
    if (!f) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': f.type, 'cache-control': 'private, max-age=3600' });
    return fs.createReadStream(f.abs).pipe(res);
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
  // a file dropped on the Inbox tab streams straight into the brain's inbox/ folder
  if (url.pathname === '/api/inbox/upload') {
    if (!active) return json(res, 200, { error: 'Set up a brain first.' });
    return json(res, 200, await managerFor(active).upload(req, url.searchParams.get('name')));
  }
  // a file pasted or dropped into a chat message, into the brain's attachments/ folder
  if (url.pathname === '/api/chat/upload') {
    if (!chat) return json(res, 200, { error: 'Set up a brain first.' });
    return json(res, 200, await chat.upload(req, url.searchParams.get('name')));
  }
  const body = await readJson(req);
  if (url.pathname === '/api/accounts') return json(res, 200, await accounts.act(String(body.key || ''), String(body.act || ''), body.code));
  // the desk tools a chat's Claude calls (approval-mcp.mjs), for whichever brain that chat is in
  if (url.pathname.startsWith('/api/desk/')) return json(res, 200, await desk(url.pathname.slice('/api/desk/'.length), body));
  // install the new build beside the exe, go back to the previous one, or stop waiting to
  if (url.pathname === '/api/update') return json(res, 200, body.cancel ? updater.cancel() : updater.request({ kind: body.rollback ? 'rollback' : 'update', installer: body.installer, chat: body.chat, brain: body.chat ? active?.id : '' }));
  // window, hotkey, notifications, start at login
  if (url.pathname === '/api/settings') {
    const before = desktop.settings().hotkey;
    const r = await desktop.set(body);
    if (r.error) return json(res, 200, r);
    if (desktop.settings().hotkey !== before) restartTray();
    return json(res, 200, await settingsView());
  }
  if (url.pathname.startsWith('/api/plugins/')) {
    const act = { install: plugins.install, uninstall: plugins.uninstall, enable: plugins.enable, disable: plugins.disable, marketplace: plugins.marketplace }[url.pathname.slice('/api/plugins/'.length)];
    const r = act ? await act(body) : { error: 'not found' };
    if (r.ok) for (const c of chats.values()) c.coolAll();
    return json(res, 200, r);
  }
  // the Terminal and Artifacts tabs
  if (url.pathname === '/api/terminal/run') return json(res, 200, terminals.run({ command: body.command, tab: body.tab, cwd: body.cwd || (active ? chatFor(active).chatFolder(chat.currentId()) : HOME) }));
  if (url.pathname === '/api/terminal/open') return json(res, 200, terminals.open({ cwd: body.cwd || (active ? chatFor(active).chatFolder(chat.currentId()) : HOME), cols: body.cols, rows: body.rows }));
  if (url.pathname === '/api/terminal/input') return json(res, 200, terminals.input({ tab: String(body.tab || ''), data: String(body.data ?? '') }));
  if (url.pathname === '/api/terminal/resize') return json(res, 200, terminals.resize({ tab: String(body.tab || ''), cols: body.cols, rows: body.rows }));
  if (url.pathname.startsWith('/api/git/')) {
    const act = { 'worktree-add': gitPane.addWorktree, 'worktree-remove': gitPane.removeWorktree, 'pr-worktree': gitPane.prWorktree, fetch: gitPane.fetchAll, rerun: gitPane.rerun, 'pr-create': gitPane.createPr }[url.pathname.slice('/api/git/'.length)];
    if (act) return json(res, 200, await act({ ...body, dir: gitDir(body.dir) }));
  }
  if (url.pathname === '/api/terminal/stop') return json(res, 200, terminals.stop(String(body.tab || '')));
  if (url.pathname === '/api/terminal/close') return json(res, 200, terminals.close(String(body.tab || '')));
  // a file Claude linked in the chat, in the user's editor (relative paths are from the open chat's folder)
  // a file or code block, rendered in the preview panel (relative paths from the open chat's folder)
  if (url.pathname === '/api/preview') {
    if (body.content != null) return json(res, 200, previews.ofContent(body.content, body.type));
    let file = String(body.path || '').trim().replace(/^file:\/\/\/?/i, '').replace(/:\d+(:\d+)?$/, '');
    try { file = decodeURIComponent(file); } catch { /* as is */ }
    if (!file) return json(res, 200, { error: 'No file.' });
    return json(res, 200, previews.ofFile(path.resolve(chat ? chat.chatFolder(chat.currentId()) : HOME, file)));
  }
  if (url.pathname === '/api/open-file') return json(res, 200, await openFile(body.path, chat ? chat.chatFolder(chat.currentId()) : HOME));
  if (url.pathname === '/api/artifacts/delete') return json(res, 200, artifacts.remove(String(body.id || '')));
  if (url.pathname.startsWith('/api/brains/')) {
    if (anyBusy()) return json(res, 200, { error: 'Claude is still answering. Wait for it, or press Stop, before changing brains.' });
    try {
      if (url.pathname === '/api/brains/switch') { const b = brains.find(body.id); return json(res, 200, b ? switchTo(b) : { error: 'Unknown brain.' }); }
      if (url.pathname === '/api/brains/create') return json(res, 200, createBrain(body));
      if (url.pathname === '/api/brains/add') return json(res, 200, addBrain(body));
      if (url.pathname === '/api/brains/links') {
        const b = brains.setLinks(String(body.id || ''), Array.isArray(body.links) ? body.links.map(String) : []);
        refresh();
        return json(res, 200, b ? { ok: true, links: b.links } : { error: 'Unknown brain.' });
      }
      if (url.pathname === '/api/brains/remove') {
        const b = brains.find(body.id);
        if (!b) return json(res, 200, { error: 'Unknown brain.' });
        if (b.home) return json(res, 200, { error: 'Home is your own Claude and always stays.' });
        const wasActive = brains.active().id === b.id;
        brains.remove(b.id);
        chats.delete(b.id);
        // its chat history; the folder itself stays
        fs.rmSync(path.join(DATA, 'chats', `${b.id}.json`), { force: true });
        fs.rmSync(path.join(DATA, 'chats', b.id), { recursive: true, force: true });
        if (wasActive && brains.active()) switchTo(brains.active()); else { refresh(); broadcast('brain', { id: null }); }
        return json(res, 200, { ok: true });
      }
    } catch (err) { return json(res, 200, { error: err.message }); }
  }
  if (url.pathname === '/api/memory/compact' || url.pathname === '/api/memory/compact-undo') {
    if (!active) return json(res, 200, { error: 'Set up a brain first.' });
    const file = memoryFileOf(active);
    if (url.pathname === '/api/memory/compact-undo') {
      if (anyBusy()) return json(res, 200, { error: 'Claude is still answering. Wait for it, or press Stop, before undoing.' });
      const r = compactor.undo(active, file); refresh(); return json(res, 200, r);
    }
    // compacting takes a minute or two; an entry a chat changes meanwhile keeps its new notes
    const started = compactor.compact(active, file).then(r => { refresh(); broadcast('memory-compacted', { brain: active.id, ...r }); return r; });
    refresh();
    return json(res, 200, body.wait ? await started : { ok: true, started: true });
  }
  if (url.pathname.startsWith('/api/memory/')) {
    if (!active) return json(res, 200, { error: 'Set up a brain first.' });
    // the memory server rewrites brain/memory.jsonl while Claude works, so don't edit under it
    if (anyBusy()) return json(res, 200, { error: 'Claude is still answering. Wait for it, or press Stop, before changing memories.' });
    try {
      let r;
      if (url.pathname === '/api/memory/restore') r = memoryEditor.restore(String(body.trashId || ''));
      else {
        const m = memoryById(active, body.id);
        if (!m) return json(res, 200, { error: 'That memory is gone.' });
        if (url.pathname === '/api/memory/save') r = memoryEditor.save(active, m, body.text);
        else if (url.pathname === '/api/memory/delete') r = memoryEditor.remove(active, m);
        else return json(res, 404, { error: 'not found' });
      }
      refresh();
      return json(res, 200, r);
    } catch (err) { return json(res, 200, { error: err.message }); }
  }
  if (!chat && (url.pathname.startsWith('/api/chat') || url.pathname.startsWith('/api/inbox') || url.pathname === '/api/brief' || url.pathname.startsWith('/api/approval') || url.pathname.startsWith('/api/handoff') || url.pathname.startsWith('/api/skills') || url.pathname === '/api/org' || url.pathname.startsWith('/api/employee'))) return json(res, 200, { error: 'Set up a brain first.' });
  if (url.pathname === '/api/chat') return json(res, 200, chat.send(body.text, { files: body.files }));
  if (url.pathname === '/api/grade') return json(res, 200, grades.vote(body.key, String(body.vote ?? '')));
  if (url.pathname === '/api/schedules/save') return json(res, 200, schedules.save(active.id, body));
  if (url.pathname === '/api/schedules/delete') return json(res, 200, schedules.remove(active.id, String(body.id || '')));
  if (url.pathname === '/api/schedules/run') return json(res, 200, await schedules.run(active.id, String(body.id || '')));
  if (url.pathname === '/api/chat/rewind') return json(res, 200, await chat.rewind(String(body.id || ''), { text: body.text ?? null, files: Array.isArray(body.files) ? body.files : null, restoreFiles: !!body.restoreFiles }));
  if (url.pathname === '/api/chat/warm') { chat.warm(); return json(res, 200, { ok: true }); }
  if (url.pathname === '/api/chat/tools') return json(res, 200, chat.setTools(body.tools || {}));
  if (url.pathname === '/api/chat/mode') return json(res, 200, chat.setMode(String(body.mode || '')));
  if (url.pathname === '/api/chat/folder') return json(res, 200, chat.setFolder(body.folder || null));
  if (url.pathname === '/api/chat/stop') { managerFor(active).stopChatSpecialists(chat.snapshot().id); chat.stop(); for (const h of handoffs.values()) h.stop(); return json(res, 200, { ok: true }); }
  if (url.pathname === '/api/handoff') return json(res, 200, await handoff(active, body, req));
  if (url.pathname === '/api/org') { const r = org.apply(active.id, body); if (r.ok && /^(assign|editDept|removeDept)$/.test(body.op)) organizeCabinets(active); refresh(); return json(res, 200, r); }
  if (url.pathname.startsWith('/api/employee/')) return json(res, 200, await employeeApi(active, url.pathname.split('/').pop(), body));
  if (url.pathname === '/api/skills/copy') return json(res, 200, copySkill(active, body));
  if (url.pathname === '/api/skills/coach') return json(res, 200, await coachSkill(active, body));
  if (url.pathname === '/api/skills/uncoach') { const r = coaching.undo(String(body.id || '')); refresh(); return json(res, 200, r); }
  if (/^\/api\/skills\/(save|fire|restore|app)$/.test(url.pathname)) {
    try { const r = skillApi(active, url.pathname.split('/').pop(), body); refresh(); return json(res, 200, r); }
    catch (err) { return json(res, 200, { error: err.message }); }
  }
  if (url.pathname.startsWith('/api/integrations/')) {
    if (!active) return json(res, 200, { error: 'Set up a brain first.' });
    const what = url.pathname.split('/').pop();
    let r;
    if (what === 'refresh') { r = { ok: true }; accounts.check(); }
    else if (what === 'add') r = await addIntegration(active, body);
    else if (what === 'remove') r = await removeIntegration(active, String(body.server || ''));
    // an API key an integration needs (only names an integration here asks for can be set)
    else if (what === 'key') {
      const allowed = integrations.brainId === active.id ? integrations.list.flatMap(i => i.keys || []) : [];
      r = await saveKey(body.name, body.remove ? null : body.value, allowed);
    }
    else if (what === 'account') {
      r = await accounts.act(String(body.key || ''), String(body.act || ''), body.code);
      broadcast('integrations', integrationsView(active));
      return json(res, 200, r);
    }
    else if (what === 'login') {
      const server = String(body.server || '');
      if (!/^[\w.: -]{1,80}$/.test(server)) return json(res, 200, { error: 'Unknown integration.' });
      r = loginIntegration(active, server, done => { broadcast('integration-login', { server, ...done }); recheck(active); },
        () => broadcast('integrations', integrationsView(active)));
      broadcast('integrations', integrationsView(active));
      return json(res, 200, r);
    } else if (what === 'cancel-login' || what === 'logout' || what === 'login-redirect') {
      const server = String(body.server || '');
      if (!/^[\w.: -]{1,80}$/.test(server)) return json(res, 200, { error: 'Unknown integration.' });
      if (what === 'login-redirect') return json(res, 200, sendLoginRedirect(server, body.address));
      r = what === 'logout' ? await logoutIntegration(active, server) : cancelLogin(server);
    } else return json(res, 404, { error: 'not found' });
    if (!r.error) recheck(active);
    broadcast('integrations', integrationsView(active));
    return json(res, 200, r);
  }
  if (url.pathname.startsWith('/api/inbox/') || url.pathname === '/api/brief') {
    const sender = body.chat && chatOwning(body.chat);
    const senderBrain = sender && brains.find([...chats.entries()].find(([, c]) => c === sender)?.[0]);
    const m = managerFor(senderBrain || active), what = url.pathname.split('/').pop();
    if (what === 'brief') {
      if (body.chat && !sender) return json(res, 200, { error: 'The parent chat no longer exists.' });
      return json(res, 200, m.postBrief({ ...body, chat: body.chat || chatFor(senderBrain || active).currentId() }));
    }
    if (what === 'add') return json(res, 200, m.add(body.text, body.files));
    if (what === 'remove') return json(res, 200, m.remove(String(body.id || '')));
    if (what === 'run') {
      // "Send to team" hands the queue to the Manager, which is the chat
      if (chat.busy()) return json(res, 200, { error: 'The Manager is still answering in this chat. Wait for it, press Stop, or start a new chat, then send the queue.' });
      const h = m.handOver();
      if (h.error) return json(res, 200, h);
      const r = chat.send(h.text, { label: h.label, from: 'inbox' });
      if (!r.error) m.markSent(h.ids, chat.currentId());
      return json(res, 200, r);
    }
    if (what === 'stop') return json(res, 200, m.stop());
    return json(res, 404, { error: 'not found' });
  }
  if (url.pathname === '/api/chat/new') return json(res, 200, chat.newChat());
  if (url.pathname === '/api/chats/open') return json(res, 200, chat.open(String(body.id || '')));
  if (url.pathname === '/api/chats/rename') return json(res, 200, chat.rename(String(body.id || ''), body.title));
  if (url.pathname === '/api/chats/delete') return json(res, 200, chat.remove(String(body.id || '')));
  if (url.pathname === '/api/chat/options') return json(res, 200, chat.setOptions(body));
  if (url.pathname === '/api/chat/wrap') return json(res, 200, chat.wrapUp());
  if (url.pathname === '/api/approval') return json(res, 200, await chat.requestApproval(body));
  if (url.pathname === '/api/approval/answer') return json(res, 200, chat.answerApproval(body.id, body.allow, body.decision));
  return json(res, 404, { error: 'not found' });
}

const benchmark = createBenchmark({ kit: benchmarkDir(DATA), dataDir: DATA, port: PORT, token: TOKEN,
  context: () => { const b = brains.active(); const c = b && chatFor(b); return b ? {brainId:b.id, brainName:b.name, version:appVersion(), options:c.optionsFor(c.currentId()), mode:c.snapshot().mode || ''} : null; },
  start: async (side, text, ctx) => {
    // each ClaudeOS contestant runs in its own brain, with the benchmark's model, effort and permissions
    const b = brains.find(side.brainId || ctx?.brainId);
    if (!b) throw new Error('That brain is gone. Pick the contestants again.');
    if (anyBusy()) throw new Error('Finish or stop current work before running a benchmark.');
    const c = chatFor(b);
    const options = {...(side.options || ctx.options), engine:side.engine === 'codex' ? 'codex' : ''};
    const r = c.startBenchmark({title:'Benchmark - ' + side.tag, prompt:text, folder:side.dir, options, mode: side.mode ?? ctx.mode});
    if (r.error) throw new Error(r.error);
    side.brainId = b.id; side.chatId = r.chat;
    return 'started';
  },
  stop: async side => { const b = brains.find(side.brainId); if (b && side.chatId) { managerFor(b).stopChatSpecialists(side.chatId); chatFor(b).stopBenchmark(side.chatId); } },
  // the environments on this PC a benchmark can compare: every brain in ClaudeOS, and the user's own Claude Code / Codex setup
  environments: () => ({ brains: brains.list().map(b => ({ id: b.id, name: b.name, active: brains.active()?.id === b.id })),
    claude: findExe('claude') ? { command: findExe('claude'), args: [], env: {} } : null, codex: codexCommand() }),
  launcher: helper('bench-window'),
  watch: side => { const b = brains.find(side.brainId); return b && side.chatId ? chatFor(b).benchmarkSnapshot(side.chatId) : { error: 'Not started yet.' }; },
  // Harbor benchmarks: what a ClaudeOS chat in the active brain gets, for the ClaudeOS contestant's container
  harbor: { loadPty: () => loadNodePty(DATA), harness: () => {
    const b = brains.active();
    if (!b) return { error: 'Select a brain in ClaudeOS first.' };
    const c = chatFor(b);
    const h = c.benchmarkHarness({ folder: '/app', options: c.optionsFor(c.currentId()), mode: c.snapshot().mode || '' });
    return h.error ? h : { ...h, brainDir: b.path, brainName: b.name, memoryFile: memoryFileOf(b) };
  } },
});
const server = http.createServer((req, res) => {
  if (!LOCAL_HOSTS.has(req.headers.host)) { res.writeHead(421); return res.end('wrong host'); }
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/benchmark' || url.pathname.startsWith('/benchmark/')) return benchmark.handle(req, res, url);
  if (url.pathname.startsWith('/api/chat') || url.pathname.startsWith('/api/approval') || url.pathname.startsWith('/api/brains') || url.pathname.startsWith('/api/memory') || url.pathname === '/api/handoff' || url.pathname.startsWith('/api/skill') || url.pathname.startsWith('/api/integrations') || url.pathname === '/api/fs' || url.pathname === '/api/health' || url.pathname === '/api/accounts'
    || url.pathname.startsWith('/api/inbox') || url.pathname === '/api/manager' || url.pathname === '/api/brief' || url.pathname === '/api/org' || url.pathname === '/api/grade' || url.pathname.startsWith('/api/employee')
    || url.pathname.startsWith('/api/desk/') || url.pathname.startsWith('/api/terminal') || url.pathname === '/api/git' || url.pathname.startsWith('/api/git/') || url.pathname.startsWith('/api/artifacts') || url.pathname === '/api/open-file' || url.pathname === '/api/preview' || url.pathname === '/api/settings' || url.pathname === '/api/update' || url.pathname === '/api/limits' || url.pathname.startsWith('/api/codex') || url.pathname.startsWith('/api/schedules') || url.pathname.startsWith('/api/plugins')) {
    return handleApi(req, res, url).catch(err => json(res, 500, { error: err.message }));
  }
  if (url.pathname === '/api/state') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(last));
  }
  if (url.pathname === '/api/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(`event: hello\ndata: ${JSON.stringify({ boot: BOOT, version: appVersion(), updated: updater.status().last })}\n\n`);
    res.write(`data: ${JSON.stringify(last)}\n\n`);
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => { clients.delete(res); clearInterval(ping); });
    return;
  }
  if (url.pathname === '/' || url.pathname === '/index.html') {
    // hand the page its token
    const html = pageFile('/index.html');
    if (!html) { res.writeHead(500); return res.end(); }
    let content = html.toString('utf8').replace('__CLAUDEOS_TOKEN__', TOKEN);
    const headers = { 'content-type': 'text/html', 'cache-control': 'no-store' };
    if (IS_DESKTOP) {
      content = content.replace('<html lang="en">', '<html lang="en" data-desktop="true">');
      const hashes = [...content.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
        .filter(([, attributes]) => !/\bsrc\s*=/i.test(attributes))
        .map(([, , code]) => `'sha256-${crypto.createHash('sha256').update(code).digest('base64')}'`);
      headers['content-security-policy'] = `default-src 'self'; script-src 'self' ${hashes.join(' ')}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: http: https:; font-src 'self' data: https:; connect-src 'self' http: https: ws: wss:; frame-src http: https: blob: data:; worker-src 'self' blob:; media-src 'self' blob: http: https:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
    }
    res.writeHead(200, headers);
    return res.end(content);
  }
  const buf = pageFile(url.pathname);
  if (!buf) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': MIME[path.extname(url.pathname)] || 'application/octet-stream' });
  res.end(buf);
});

const PAGE_URL = `http://localhost:${PORT}`;
const updater = createUpdater({ dataDir: DATA, port: PORT, quit: () => quit(),
  busy: () => [...chats.values()].some(c => c.anyBusy()) || [...managers.values()].some(m => m.busy()) || handoffs.size > 0 || benchmark.busy() });
// Back from an install a chat asked for (update_app): open on that chat, and tell Claude how it went
// so it can finish the job (check, clean up, save what shipped) right where the user is looking.
function resumeAfterUpdate() {
  const u = updater.status().last;
  const b = u?.chat && u.brain && brains.find(u.brain);
  if (!b) return;
  try {
    switchTo(b);
    const c = chatFor(b);
    if (c.open(u.chat).error) return;
    const what = u.version ? `ClaudeOS ${u.version} (build ${u.to})` : `build ${u.to}`;
    const back = u.kind === 'rollback';
    c.report(u.chat, u.ok ? `${back ? 'Rolled back' : 'Updated'} to ${what}` : `The ${back ? 'rollback' : 'update'} did not install`,
      u.ok ? back ? `ClaudeOS closed, went back to ${what} and opened again (it was build ${u.from}). Check that it works and tell me in a line or two.`
        : `ClaudeOS closed, installed ${what} and opened again (it was build ${u.from}). Check that it works, finish the shipping steps that come after installing, and tell me in a line or two.`
        : `The installer failed, so ClaudeOS is still on build ${u.to}. Read update.log in the ClaudeOS data folder, tell me why in a line or two, and fix it if you can.`, 'update');
  } catch (e) { console.error('Could not reopen the chat after the update:', e.message); }
}
server.listen(PORT, '127.0.0.1', () => {
  console.log(`ClaudeOS running at ${PAGE_URL}  (data: ${DATA})`);
  resumeAfterUpdate();
  if (IS_DESKTOP) desktopEvent('desktop-ready', { url: PAGE_URL, settings: desktop.settings() });
  if (process.argv.includes('--open')) openPage(PAGE_URL);
  if (process.argv.includes('--tray')) {
    trayOn = true;
    restartTray(process.argv.includes('--background') ? '' : 'Click the icon or press your hotkey to open it. Right-click to quit.');
  }
});
server.on('error', err => {
  if (IS_DESKTOP) { desktopEvent('desktop-error', { message: err.code === 'EADDRINUSE' ? `Port ${PORT} is already in use. Quit the previous ClaudeOS app, then try again.` : err.message }); return quit(); }
  if (err.code === 'EADDRINUSE') {
    console.log(`ClaudeOS is already running at http://localhost:${PORT}`);
    // double-clicking ClaudeOS.exe again just brings the page back
    const bye = () => setTimeout(() => process.exit(0), 500);
    if (IS_EXE) showWindow(PAGE_URL, { appWindow: desktop.settings().appWindow }, bye); else bye();
    return;
  }
  throw err;
});

function openPage(url) { if (IS_DESKTOP) desktopEvent('desktop-show'); else openWindow(url, { appWindow: desktop.settings().appWindow }); }

// ---------- tray, hotkey and notifications ----------
let tray = null, trayOn = false, hotkeyOk = null;
function restartTray(greet = '') {
  if (IS_DESKTOP) { desktopEvent('desktop-configure', desktop.settings()); return; }
  if (!trayOn) return;
  tray?.stop();
  hotkeyOk = null;
  tray = startTray({ hotkey: desktop.settings().hotkey, greet, onQuit: quit, onShow: () => openPage(PAGE_URL),
    onHotkey: ok => { hotkeyOk = ok; broadcast('settings', {}); } });
}
// An answer finished or Claude needs a yes: the page shows it if it is open (when you are not
// looking at it), else the tray does.
function notify({ title, body, chat, brain }) {
  if (!desktop.settings().notify) return;
  const t = brains.list().length > 1 && brain ? `${title} · ${brain}` : title;
  if (IS_DESKTOP) { desktopEvent('desktop-notify', { title: t, body, chat, brain }); return; }
  if (clients.size) broadcast('notify', { title: t, body, chat });
  else tray?.notify(t, body);
}
async function settingsView() { return { tray: trayOn, hotkeyOk, ...(await desktop.get()) }; }

if (IS_DESKTOP) {
  process.on('message', message => { if (message?.type === 'desktop-quit') quit(); });
  process.on('disconnect', quit);
}

// Quit from the tray: stop anything Claude is doing for us first.
function quit() {
  for (const c of chats.values()) c.stopAll();
  for (const h of handoffs.values()) h.stop();
  for (const m of managers.values()) m.stop();
  terminals.stopAll();
  setTimeout(() => process.exit(0), 800);
}
