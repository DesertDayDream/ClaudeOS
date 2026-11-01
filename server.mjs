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
import { exec } from 'node:child_process';
import { createChat } from './chat.mjs';
import { runHandoff } from './handoff.mjs';
import { createManager } from './manager.mjs';
import { createTerminals } from './terminals.mjs';
import { createArtifacts } from './artifacts.mjs';
import { createPreviews } from './previews.mjs';
import { openFile } from './openfile.mjs';
import { createMemoryEditor, observationId } from './memory-edit.mjs';
import { createSkillEditor } from './skill-edit.mjs';
import { createOrg } from './org.mjs';
import { ensureCabinet, findCabinet, cabinetTree } from './cabinets.mjs';
import { appsInText, appForServer } from './public/apps.js';
import { CATALOG, CONNECTORS_URL, addIntegration, removeIntegration, loginIntegration, isSigningIn } from './integrations.mjs';
import { createRegistry, setupBrain, repairHooks, listFolder, slugFor, samePath, inside } from './brains.mjs';
import { IS_EXE, helper, memoryServer, hookCommand, templatesDir, pageFile } from './runtime.mjs';
import { startTray } from './tray.mjs';
import { createDesktop, openPage as openWindow, showPage as showWindow } from './desktop.mjs';

const HOME = os.homedir();
const CLAUDE = path.resolve(process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude'));
const PORT = Number(process.env.PORT || 4747);
const DATA = path.resolve(process.env.CLAUDEOS_HOME || path.join(HOME, '.claudeos'));
const ACTIVITY = path.join(DATA, 'activity.jsonl');
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
      apps: appsInText(text), // integrations its SKILL.md uses or names
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
  if (changed) saveNames();
  return names;
}
function saveNames() {
  try { fs.mkdirSync(path.dirname(NAMES_FILE), { recursive: true }); fs.writeFileSync(NAMES_FILE, JSON.stringify(names, null, 2)); } catch { /* names still work this session */ }
}

function snapshot() {
  const brain = brains.active();
  const list = brains.list().map(b => ({ id: b.id, name: b.name, path: b.path, links: b.links || [] }));
  if (!brain) return { brain: null, brains: list, memories: [], skills: [], names: {}, activity: [], at: Date.now() }; // first run
  const skills = collectSkills(brain);
  return {
    brain: { id: brain.id, name: brain.name, path: brain.path },
    brains: list,
    memories: [...collectBrain(brain), ...collectMemories(brain)], skills, names: { ...nameSkills(skills) },
    // linked brains: their shared brain (read-only here), their own team, and whether they're working for us
    linked: brains.linksOf(brain).map(b => ({ id: b.id, name: b.name, path: b.path, busy: handoffs.has(b.id),
      memories: collectBrain(b), skills: skillsIn(path.join(b.path, '.claude', 'skills'), 'project', path.basename(b.path)) })),
    activity: collectActivity(brain), at: Date.now(), org: org.snapshot(brain.id),
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
      list.push({ server, key: appForServer(server), status, detail: tail.replace(/^[^\w]+/, '').slice(0, 200) });
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
  return { list: list.map(i => ({ ...i, signingIn: isSigningIn(i.server) })), checking: integrations.running,
    checked: integrations.brainId === brain?.id ? integrations.at : 0, catalog: CATALOG, connectorsUrl: CONNECTORS_URL };
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
  return JSON.stringify([s.brain?.id, s.brains, s.integrations?.map(i => i.server + i.status), s.skills.map(x => x.apps?.map(a => a.key).join()), s.linked?.map(l => [l.id, l.busy, l.memories.length, l.skills.length]), s.memories.map(m => m.id + m.description), s.skills.map(s => s.id), s.activity.length && s.activity[s.activity.length - 1], s.org]);
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
const LOCAL_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);
// The chats' desk: shell tabs Claude and the user share, and the artifacts Claude publishes
// (served on their own port, so a page can never reach this one's token or API).
const terminals = createTerminals({ broadcast });
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
  if (tool === 'start_session') return owner.startSession(a);
  if (tool === 'message_session') return owner.messageSession(a);
  return { error: `Unknown desk tool ${tool}.` };
}

// each brain's chats (any number, each its own conversation); the page shows the active brain's
const chats = new Map();
function chatFor(brain) {
  if (!chats.has(brain.id)) {
    chats.set(brain.id, createChat({ cwd: brain.path, memoryFile: memoryFileOf(brain), helper, memoryServer, browserServer,
      dir: path.join(DATA, 'chats', brain.id), legacyFile: path.join(DATA, 'chats', `${brain.id}.json`), activityFile: ACTIVITY, port: PORT,
      links: () => brains.linksOf(brain).map(b => ({ id: b.id, name: b.name, memoryFile: memoryFileOf(b) })), token: TOKEN,
      // a brain you switched away from keeps working, out of sight
      broadcast: (event, data) => { if (brains.active()?.id === brain.id) broadcast(event, data); },
      othersWorking: () => managerFor(brain).busy(), team: () => teamOf(brain), projects: () => projectsOf(brain),
      // the chat is the Manager: when it stops, the Manager desk stops typing and unbriefed requests wait again
      onIdle: chatId => managerFor(brain).chatDone(chatId),
      notify: n => notify({ ...n, brain: brain.name }) }));
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
      memoryFile: memoryFileOf(brain), helper, memoryServer, port: PORT, token: TOKEN, team: () => teamOf(brain),
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
  task = String(task || '').trim();
  const want = String(target || '').trim().toLowerCase();
  const b = brains.linksOf(active).find(x => x.name.toLowerCase() === want || x.id === target);
  if (!b) return { error: `"${target}" isn't linked to ${active.name}. Linked brains: ${brains.linksOf(active).map(x => x.name).join(', ') || 'none'}.` };
  if (!task) return { error: 'Say what the linked brain should do.' };
  if (handoffs.has(b.id)) return { error: `${b.name} is already working on a hand-off. Wait for it to finish.` };
  const mcpServers = {
    memory: memoryServer(memoryFileOf(b)),
    claudeos: { ...helper('approval-mcp'), env: { CLAUDEOS_PORT: String(PORT), CLAUDEOS_TOKEN: TOKEN } },
  };
  const run = runHandoff({ brain: b, task, mcpServers, onExit: () => { handoffs.delete(b.id); refresh(); } });
  handoffs.set(b.id, run);
  refresh();
  // if the asking Claude goes away (Stop, crash), stop the linked brain too
  req.on('close', () => { if (handoffs.get(b.id) === run) run.stop(); });
  const r = await run.done;
  return r.error ? { error: `${b.name}: ${r.error}` } : { brain: b.name, result: r.result };
}

// Copies a skill folder from a linked brain's team into the active brain's team.
function copySkill(active, { from, skill }) {
  const b = brains.linksOf(active).find(x => x.id === from);
  if (!b) return { error: 'Link that brain first.' };
  const s = skillsIn(path.join(b.path, '.claude', 'skills'), 'project').find(x => x.name === skill);
  if (!s) return { error: `${b.name} has no skill called ${skill}.` };
  const dest = path.join(active.path, '.claude', 'skills', s.folder);
  if (fs.existsSync(dest)) return { error: `${active.name} already has a .claude/skills/${s.folder} folder.` };
  fs.cpSync(path.join(b.path, '.claude', 'skills', s.folder), dest, { recursive: true, filter: src => !src.includes('__pycache__') });
  refresh();
  return { ok: true, folder: s.folder };
}

// The active brain's own team is editable from the page; personal and plugin skills are read-only.
const skillEditor = createSkillEditor({ dataDir: DATA });
const teamDir = brain => path.join(brain.path, '.claude', 'skills');
const teamSkill = (brain, id) => skillsIn(teamDir(brain), 'project', path.basename(brain.path)).find(s => s.id === id);
function skillApi(active, route, body) {
  const team = teamDir(active), owner = path.basename(active.path);
  const idOf = name => `project:${owner}:${name}`;
  if (route === 'restore') { const r = skillEditor.restore(String(body.trashId || '')); return r.error ? r : { ...r, id: idOf(r.name) }; }
  const s = body.id ? teamSkill(active, body.id) : null;
  if (body.id && !s) return { error: 'That employee is gone, or isn’t on this brain’s team.' };
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
  if (url.pathname === '/api/chats' && req.method === 'GET') return json(res, 200, chat ? chat.list(url.searchParams.get('q') || '') : { chats: [] });
  if (url.pathname === '/api/employee' && req.method === 'GET') return json(res, 200, active ? employeeView(active, url.searchParams.get('id') || '') : { error: 'Set up a brain first.' });
  if (url.pathname === '/api/manager' && req.method === 'GET') return json(res, 200, active ? managerFor(active).snapshot() : { inbox: [], files: [], briefs: [], busy: false });
  if (url.pathname === '/api/settings' && req.method === 'GET') return json(res, 200, await settingsView());
  if (url.pathname === '/api/terminals' && req.method === 'GET') return json(res, 200, terminals.snapshot());
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
  // the desk tools a chat's Claude calls (approval-mcp.mjs), for whichever brain that chat is in
  if (url.pathname.startsWith('/api/desk/')) return json(res, 200, await desk(url.pathname.slice('/api/desk/'.length), body));
  // window, hotkey, notifications, start at login
  if (url.pathname === '/api/settings') {
    const before = desktop.settings().hotkey;
    const r = await desktop.set(body);
    if (r.error) return json(res, 200, r);
    if (desktop.settings().hotkey !== before) restartTray();
    return json(res, 200, await settingsView());
  }
  // the Terminal and Artifacts tabs
  if (url.pathname === '/api/terminal/run') return json(res, 200, terminals.run({ command: body.command, tab: body.tab, cwd: body.cwd || (active ? chatFor(active).chatFolder(chat.currentId()) : HOME) }));
  if (url.pathname === '/api/terminal/open') return json(res, 200, terminals.open({ cwd: body.cwd || (active ? chatFor(active).chatFolder(chat.currentId()) : HOME) }));
  if (url.pathname === '/api/terminal/input') return json(res, 200, terminals.input({ tab: String(body.tab || ''), text: String(body.text ?? '') }));
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
  if (url.pathname === '/api/chat/warm') { chat.warm(); return json(res, 200, { ok: true }); }
  if (url.pathname === '/api/chat/tools') return json(res, 200, chat.setTools(body.tools || {}));
  if (url.pathname === '/api/chat/mode') return json(res, 200, chat.setMode(String(body.mode || '')));
  if (url.pathname === '/api/chat/folder') return json(res, 200, chat.setFolder(body.folder || null));
  if (url.pathname === '/api/chat/stop') { chat.stop(); for (const h of handoffs.values()) h.stop(); return json(res, 200, { ok: true }); }
  if (url.pathname === '/api/handoff') return json(res, 200, await handoff(active, body, req));
  if (url.pathname === '/api/org') { const r = org.apply(active.id, body); if (r.ok && /^(assign|editDept|removeDept)$/.test(body.op)) organizeCabinets(active); refresh(); return json(res, 200, r); }
  if (url.pathname.startsWith('/api/employee/')) return json(res, 200, await employeeApi(active, url.pathname.split('/').pop(), body));
  if (url.pathname === '/api/skills/copy') return json(res, 200, copySkill(active, body));
  if (/^\/api\/skills\/(save|fire|restore)$/.test(url.pathname)) {
    try { const r = skillApi(active, url.pathname.split('/').pop(), body); refresh(); return json(res, 200, r); }
    catch (err) { return json(res, 200, { error: err.message }); }
  }
  if (url.pathname.startsWith('/api/integrations/')) {
    if (!active) return json(res, 200, { error: 'Set up a brain first.' });
    const what = url.pathname.split('/').pop();
    let r;
    if (what === 'refresh') r = { ok: true };
    else if (what === 'add') r = await addIntegration(active, body);
    else if (what === 'remove') r = await removeIntegration(active, String(body.server || ''));
    else if (what === 'login') {
      const server = String(body.server || '');
      if (!/^[\w.: -]{1,80}$/.test(server)) return json(res, 200, { error: 'Unknown integration.' });
      r = loginIntegration(active, server, done => { broadcast('integration-login', { server, ...done }); recheck(active); });
      broadcast('integrations', integrationsView(active));
      return json(res, 200, r);
    } else return json(res, 404, { error: 'not found' });
    if (!r.error) recheck(active);
    broadcast('integrations', integrationsView(active));
    return json(res, 200, r);
  }
  if (url.pathname.startsWith('/api/inbox/') || url.pathname === '/api/brief') {
    const m = managerFor(active), what = url.pathname.split('/').pop();
    if (what === 'brief') return json(res, 200, m.postBrief(body)); // from the chat's post_brief tool
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
  if (url.pathname === '/api/approval/answer') return json(res, 200, chat.answerApproval(body.id, body.allow));
  return json(res, 404, { error: 'not found' });
}

const server = http.createServer((req, res) => {
  if (!LOCAL_HOSTS.has(req.headers.host)) { res.writeHead(421); return res.end('wrong host'); }
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/chat') || url.pathname.startsWith('/api/approval') || url.pathname.startsWith('/api/brains') || url.pathname.startsWith('/api/memory') || url.pathname === '/api/handoff' || url.pathname.startsWith('/api/skill') || url.pathname.startsWith('/api/integrations') || url.pathname === '/api/fs' || url.pathname === '/api/health'
    || url.pathname.startsWith('/api/inbox') || url.pathname === '/api/manager' || url.pathname === '/api/brief' || url.pathname === '/api/org' || url.pathname.startsWith('/api/employee')
    || url.pathname.startsWith('/api/desk/') || url.pathname.startsWith('/api/terminal') || url.pathname.startsWith('/api/artifacts') || url.pathname === '/api/open-file' || url.pathname === '/api/preview' || url.pathname === '/api/settings') {
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
    const html = pageFile('/index.html');
    if (!html) { res.writeHead(500); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
    return res.end(html.toString('utf8').replace('__CLAUDEOS_TOKEN__', TOKEN));
  }
  const buf = pageFile(url.pathname);
  if (!buf) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': MIME[path.extname(url.pathname)] || 'application/octet-stream' });
  res.end(buf);
});

const PAGE_URL = `http://localhost:${PORT}`;
server.listen(PORT, '127.0.0.1', () => {
  console.log(`ClaudeOS running at ${PAGE_URL}  (data: ${DATA})`);
  if (process.argv.includes('--open')) openPage(PAGE_URL);
  if (process.argv.includes('--tray')) {
    trayOn = true;
    restartTray(process.argv.includes('--background') ? '' : 'Click the icon or press your hotkey to open it. Right-click to quit.');
  }
});
server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.log(`ClaudeOS is already running at http://localhost:${PORT}`);
    // double-clicking ClaudeOS.exe again just brings the page back
    const bye = () => setTimeout(() => process.exit(0), 500);
    if (IS_EXE) showWindow(PAGE_URL, { appWindow: desktop.settings().appWindow }, bye); else bye();
    return;
  }
  throw err;
});

function openPage(url) { openWindow(url, { appWindow: desktop.settings().appWindow }); }

// ---------- tray, hotkey and notifications ----------
let tray = null, trayOn = false, hotkeyOk = null;
function restartTray(greet = '') {
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
  if (clients.size) broadcast('notify', { title: t, body, chat });
  else tray?.notify(t, body);
}
async function settingsView() { return { ...(await desktop.get()), tray: trayOn, hotkeyOk }; }

// Quit from the tray: stop anything Claude is doing for us first.
function quit() {
  for (const c of chats.values()) c.stopAll();
  for (const h of handoffs.values()) h.stop();
  for (const m of managers.values()) m.stop();
  terminals.stopAll();
  setTimeout(() => process.exit(0), 800);
}
