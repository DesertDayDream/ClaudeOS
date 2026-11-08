// Built-in ClaudeOS benchmark: mounted at /benchmark on the authenticated app server.
//   Pair buttons  -> fresh blank working folders + windows side by side (ClaudeOS left, the other app right, panel below)
//   Run           -> starts ClaudeOS through its local API and pastes the same prompt into the other app
//   Live metrics  -> read from each app's own session log and from its working folder
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { measure, snapshotDir, changedFiles } from './metrics.mjs';
const graders = {};
import { createTasks } from '../grader/tasks.mjs';
import { scoreSide, verdict, replyRule } from '../grader/scoring.mjs';
import { createHarbor, SUITES } from '../harbor/runner.mjs';

export function createBenchmark({ kit, dataDir, port, token, context, start, stop, environments, launcher, watch, harbor: harborDeps = {} }) {
const { listTasks, loadTask } = createTasks(path.join(kit, 'tasks'));
const require = createRequire(path.join(kit, 'package.json'));
let web = null, judge = null; // loaded on first use (Playwright is only needed for web tasks)
const webGrader = async () => (web ||= require('./grader/web.cjs'));
const judgeMod = async () => (judge ||= await import('../grader/judge.mjs'));
const DRY_JUDGE = process.env.BENCH_NO_JUDGE === '1';

const here = path.join(kit, 'panel');
const PORT = port;
const LIVE = path.resolve(process.env.BENCH_HOME || path.join(dataDir, 'benchmarks'));
const DRY = process.env.BENCH_DRY === '1'; // tests: don't touch windows or the real ClaudeOS
const NOWIN = DRY || process.env.BENCH_NO_WINDOWS === '1'; // tests: don't move or type into windows

const { contestants } = JSON.parse(fs.readFileSync(path.join(kit, 'contestants.json'), 'utf8'));
const JUDGE_FOR = { claude: 'codex', codex: 'claude' }; // the judge comes from the other model family
const nameOf = id => contestants.find(c => c.id === id)?.name || id;

fs.mkdirSync(LIVE, { recursive: true });
const stateFile = path.join(LIVE, 'state.json'), resultsFile = path.join(LIVE, 'results.jsonl');
let round = null;
try { round = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { /* first start */ }
const save = () => fs.writeFileSync(stateFile, JSON.stringify(round));
if (round?.grading) { round.grading = null; round.gradeError = 'Grading was interrupted. Retry grading to finish.'; save(); }
const log = (...a) => console.log(new Date().toLocaleTimeString(), ...a);
// Harbor: repeated, isolated runs of ClaudeOS and Claude Code in containers (setup and jobs from buttons)
const harbor = createHarbor({ kit, home: path.join(LIVE, 'harbor'), loadPty: harborDeps.loadPty, loadTask, log,
  harness: harborDeps.harness || (() => ({ error: 'Harbor benchmarks need the ClaudeOS app.' })),
  gradeWeb: async (...a) => (await webGrader()).gradeWeb(...a) });

// ---------- the environments that can compete ----------
// Every ClaudeOS brain (Claude or Codex engine), and the user's own Claude Code / Codex setup
// (what Claude Desktop's Code tab and the Codex app run), each in a window of its own.
function contestantList() {
  const e = environments ? environments() : { brains: [], claude: null, codex: null };
  const list = [];
  for (const b of e.brains) list.push({ id: `claudeos:${b.id}`, name: `ClaudeOS · ${b.name}`, engine: 'claude', via: 'claudeos', brainId: b.id, active: b.active });
  if (e.claude) list.push({ id: 'desktop-claude', name: 'Claude Desktop settings', engine: 'claude', via: 'window',
    note: 'Claude Code with your own setup (plugins, MCP servers, skills, CLAUDE.md, sign-in), in its own window. The first time, answer its question about trusting the benchmark folder.' });
  if (e.codex) {
    for (const b of e.brains) list.push({ id: `claudeos-codex:${b.id}`, name: `ClaudeOS · ${b.name} (Codex engine)`, engine: 'codex', via: 'claudeos', brainId: b.id });
    list.push({ id: 'desktop-codex', name: 'Codex settings', engine: 'codex', via: 'window', note: 'Codex with your own setup and ChatGPT sign-in, in its own window' });
  }
  return list;
}

// ---------- the contestants' own windows ----------
const winFile = (s, ext) => path.join(LIVE, `window-${s.id}.${ext}`);
function closeWindows(r) {
  for (const s of r?.sides || []) {
    if (s.via !== 'window') continue;
    let pid = 0; try { pid = Number(fs.readFileSync(winFile(s, 'pid'), 'utf8')); } catch { /* never opened */ }
    if (pid && !NOWIN) spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {});
    fs.rmSync(winFile(s, 'pid'), { force: true });
  }
}
// Claude Code or Codex, started with the user's own setup in a console window of its own
function startWindow(side, text) {
  const e = environments ? environments() : {};
  const cli = side.engine === 'codex' ? e.codex : e.claude;
  if (!cli) throw new Error(`${side.engine === 'codex' ? 'Codex' : 'Claude Code'} isn't installed. Install it from Apps → Accounts.`);
  const o = side.options || {}, mode = side.mode || '';
  const args = side.engine === 'codex'
    ? [...(o.codexModel ? ['-m', o.codexModel] : []), ...(o.codexEffort ? ['-c', `model_reasoning_effort="${o.codexEffort}"`] : []),
       ...(mode === 'bypassPermissions' ? ['--dangerously-bypass-approvals-and-sandbox'] : mode === 'plan' ? ['-s', 'read-only'] : mode ? ['--full-auto'] : []), text]
    : [...(o.model ? ['--model', o.model] : []), ...(o.effort ? ['--effort', o.effort] : []), ...(mode ? ['--permission-mode', mode] : []), text];
  const job = { title: `Benchmark ${side.id}: ${side.name}`, command: cli.command, args: [...cli.args, ...args], env: cli.env || {}, cwd: side.dir, pidFile: winFile(side, 'pid') };
  fs.writeFileSync(winFile(side, 'json'), JSON.stringify(job));
  if (NOWIN) return 'DRY';
  if (!launcher) throw new Error('This ClaudeOS build cannot open benchmark windows.');
  const q = s => `"${String(s).replace(/"/g, '')}"`;
  // `start` gives it a console window of its own; the helper then runs the program with the exact arguments
  const line = ['start', q(job.title), '/D', q(side.dir), q(launcher.command), ...launcher.args.map(q), q(winFile(side, 'json'))].join(' ');
  spawn('cmd.exe', ['/d', '/s', '/c', `"${line}"`], { windowsVerbatimArguments: true, windowsHide: true, stdio: 'ignore', detached: true }).unref();
  return 'opened its window';
}

// ---------- fresh folders ----------
// a copy of the user's project for each side, so the two never touch each other or the original
const COPY_SKIP = new Set(['node_modules', '.venv', 'venv', '__pycache__', '.next', '.cache']);
function copyProject(from, to) {
  let files = 0;
  fs.cpSync(from, to, { recursive: true, filter: src => {
    if (COPY_SKIP.has(path.basename(src))) return false;
    if (++files > 200000) throw new Error('That folder has more than 200,000 files. Pick a smaller one.');
    return true;
  } });
  return relink(from, to);
}
// Settings and notes in the copy that name the original folder (a memory server's file, a project path in
// CLAUDE.md) would let a contestant read or write the original. They now name the copy instead.
// Returns the files changed.
function relink(from, to) {
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const forms = [[from, to], [from.replace(/\\/g, '/'), to.replace(/\\/g, '/')], [from.replace(/\\/g, '\\\\'), to.replace(/\\/g, '\\\\')]]
    .filter(([f], i, all) => all.findIndex(([g]) => g === f) === i)
    // only where the folder's name ends: a separator, a quote, punctuation or the end of a line
    // ("My Game" must not match inside "My Game Old")
    .map(([f, t]) => [new RegExp(esc(f) + '(?=[\\\\/"\'`,;)\\]}>|\\r\\n]|\\.(?=\\s|$)|$)', 'gi'), t]);
  const changed = [];
  let seen = 0;
  (function walk(dir) {
    let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isSymbolicLink() || e.name === '.git' || COPY_SKIP.has(e.name) || ++seen > 50000) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      let buf; try { if (fs.statSync(p).size > 2e6) continue; buf = fs.readFileSync(p); } catch { continue; }
      if (buf.includes(0)) continue;
      const before = buf.toString('utf8');
      let after = before;
      for (const [re, t] of forms) after = after.replace(re, () => t);
      if (after !== before) { fs.writeFileSync(p, after); changed.push(path.relative(to, p)); }
    }
  })(to);
  return changed;
}
const inside = (child, parent) => { const r = path.relative(parent, child); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };
function prepare(body = {}) {
  const list = contestantList(), pick = id => list.find(c => c.id === id);
  const A = pick(body.a), B = pick(body.b);
  if (!A || !B) return { error: 'Pick two contestants.' };
  if (A.id === B.id) return { error: 'Pick two different contestants.' };
  if (round?.runId && !round.saved) return { error: 'Stop or finish the current round first.' };
  if (round?.grading) return { error: 'Wait for grading to finish.' };
  const start = String(body.start || '');
  let task = null, folder = null;
  if (start.startsWith('task:')) { task = loadTask(start.slice(5)); if (!task) return { error: 'Unknown task.' }; }
  else if (start.startsWith('folder:')) {
    folder = path.resolve(start.slice(7));
    try { if (!fs.statSync(folder).isDirectory()) throw 0; } catch { return { error: `No such folder: ${folder}` }; }
    if (inside(LIVE, folder) || inside(folder, LIVE)) return { error: "Pick a project folder outside ClaudeOS's benchmark folder." };
  } else if (start) return { error: 'Unknown starting files.' };
  // the same model, effort and permissions for both sides
  const ctx = context() || {};
  const set = body.settings || {}, base = ctx.options || {};
  const options = { model: set.model ?? base.model ?? '', effort: set.effort ?? base.effort ?? '', codexModel: set.codexModel ?? base.codexModel ?? '', codexEffort: set.codexEffort ?? base.codexEffort ?? '' };
  for (const k of Object.keys(options)) if (!options[k]) delete options[k];
  const mode = String(set.mode ?? ctx.mode ?? '');
  // two ClaudeOS chats can't work at once; a single app (an editor, a device) may need one at a time too
  const order = A.via === 'claudeos' && B.via === 'claudeos' ? 'sequence' : body.order === 'sequence' ? 'sequence' : 'together';
  const repeats = Math.max(1, Math.min(10, Number(body.repeats) || 1));
  closeWindows(round);
  if (round?.sides) {
    const archiveId = round.runId || 'prepared-' + crypto.randomUUID();
    for (const side of round.sides) {
      if (!fs.existsSync(side.dir)) continue;
      const dest = path.join(LIVE, 'archive', archiveId, side.id);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      if (fs.existsSync(dest)) throw new Error('Archive already exists; previous files were preserved.');
      fs.renameSync(side.dir, dest);
    }
  }
  // a repeat alternates who goes first
  const flip = order === 'sequence' && body.flip;
  const sides = (flip ? [B, A] : [A, B]).map(c => {
    const id = c === A ? 'A' : 'B', dir = path.join(LIVE, `side-${id}`);
    fs.rmSync(dir, { recursive: true, force: true });
    let relinked = [];
    if (folder) relinked = copyProject(folder, dir); else fs.mkdirSync(dir, { recursive: true });
    return { id, name: c.name, contestant: c.id, dir, engine: c.engine, via: c.via, brainId: c.brainId || null, options, mode, relinked: relinked.slice(0, 50), baseline: snapshotDir(dir) };
  });
  const config = { a: A.id, b: B.id, start, settings: { ...options, mode }, order, repeats };
  const series = body.series || { id: crypto.randomBytes(4).toString('hex'), total: repeats, n: 1, prompt: '' };
  round = { context: ctx, config, series, accounting: 'Every Claude Code / Codex session tagged for this round, with its native subagents. Background sessions a contestant starts on its own (grading, coaching) are not included. Token counts are usage, not subscription charges.',
    pair: A.engine, template: '', task: task?.id || null, folder, order, preparedAt: Date.now(), runId: null, prompt: '', sides, saved: false, notes: [] };
  save();
  log('prepared', A.id, 'vs', B.id, task ? 'task ' + task.id : folder || '(empty)', order, `x${repeats}`);
  return { ok: true, prompt: task?.prompt || null, order };
}

// ---------- starting the contestants ----------
async function startSide(s, text) {
  if (s.via === 'claudeos') return DRY ? 'DRY' : await start(s, text, round.context);
  return startWindow(s, text);
}
async function launch(s) {
  s.waiting = false;
  s.startedAt = Date.now();
  try { s.start = await startSide(s, `${s.tag}\n\n${round.prompt}`); }
  catch (e) { s.start = 'failed'; s.error = e.message; s.failed = true; }
  save();
  return { name: s.name, start: s.start, error: s.error || null };
}
async function run({ prompt }) {
  prompt = String(prompt || '').trim();
  if (!round) return { error: 'Pick the contestants first.' };
  if (prompt.length > 80000) return { error: 'Prompt exceeds 80,000 characters.' };
  if (!prompt) return { error: 'Write a prompt first.' };
  if (round.runId) return { error: 'This round already ran. Press Run for a fresh round.' };
  const d = new Date(), pad = n => String(n).padStart(2, '0');
  round.runId = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${crypto.randomBytes(3).toString('hex')}`;
  round.prompt = prompt;
  round.series.prompt = prompt;
  for (const s of round.sides) { s.tag = `Benchmark run ${round.runId}-${s.id}.`; s.waiting = true; }
  const results = [];
  if (round.order === 'sequence') results.push(await launch(round.sides[0]));
  else for (const s of round.sides) results.push(await launch(s));
  save();
  log('run', round.runId, JSON.stringify(results));
  return { ok: true, runId: round.runId, results, watch: round.sides.filter(s => s.via === 'claudeos').map(s => s.id) };
}
// one after the other: the next side starts when the one before it has finished
let advancing = false;
async function advance() {
  if (advancing || !round?.runId || round.saved) return;
  const next = round.sides.find(s => s.waiting);
  if (!next) return;
  const before = round.sides.slice(0, round.sides.indexOf(next));
  if (!before.every(s => s.failed || ['done', 'failed'].includes(cache.get(s.id)?.metrics?.status))) return;
  advancing = true;
  try { closeWindows({ sides: before }); await launch(next); } finally { advancing = false; }
}
// repeats: once a round is recorded and graded, the next one starts with fresh copies
async function repeat() {
  const r = round;
  if (!r?.saved || r.grading || !r.series || r.series.stopped || r.series.n >= r.series.total) return;
  const series = { ...r.series, n: r.series.n + 1 };
  const p = prepare({ ...r.config, series, flip: series.n % 2 === 0 });
  if (p.error) { r.series.stopped = true; r.notes.push('Repeats stopped: ' + p.error); save(); return; }
  await run({ prompt: series.prompt });
}

// ---------- live state ----------
const cache = new Map();
function sideView(s) {
  if (round.saved && s.final) { const {baseline, ...rest} = s; return {...rest, metrics:s.final}; }
  const now = Date.now();
  let m = cache.get(s.id);
  if (!m || now - m.at > 1000 || m.runId !== round.runId) {
    const live = { ...s, logFile: s.logFile, startedAt: s.startedAt || 0 };
    const metrics = measure(live, now);
    if (live.logFile && !s.logFile) { s.logFile = live.logFile; save(); }
    m = { at: now, runId: round.runId, metrics };
    cache.set(s.id, m);
  }
  const { baseline, ...rest } = s;
  return { ...rest, metrics: s.failed ? {...m.metrics, status: 'failed'} : m.metrics };
}
function finish(why) {
  if (!round?.runId || round.saved) return;
  const sides = round.sides.map(s => {
    const v = sideView(s);
    let grade = null;
    if (round.template && graders[round.template]) try { grade = graders[round.template](s.dir); } catch (e) { grade = { correct: null, detail: e.message }; }
    s.grade = grade; s.final = v.metrics;
    // what this side made or changed: listed and previewable on the page; only these files are kept as evidence
    const now = snapshotDir(s.dir);
    s.results = changedFiles(s.baseline || {}, now).slice(0, 200);
    s.page = pickPage(s.results);
    s.evidence = s.results.filter(r => r.kind !== 'deleted').slice(0, 100).map(r => ({ file: r.file, text: now[r.file] ? now[r.file].join('\n').slice(0, 100000) : null }));
    return { id: s.id, name: s.name, ...v.metrics, grade, error: s.error || null };
  });
  round.saved = true; round.ended = why;
  if (why !== 'both done') for (const s of round.sides) if (s.final?.status !== 'done') s.final = {...s.final, status: 'stopped'};
  round.grading = round.task && why !== 'stopped by you' ? 'checking the pages' : null;
  rescore(round);
  save(); upsert(record(round));
  log('saved', round.runId, why);
  if (round.grading) { const r = round; gradeRound(r).catch(e => { r.grading = null; r.gradeError = e.message; rescore(r); save(); upsert(record(r)); log('grading failed', e.stack); }); }
}

// ---------- scoring ----------
const shotsRoot = path.join(LIVE, 'shots');
function rescore(r) { // r: the live round, or a saved record (whose sides carry their metrics)
  const task = r.task ? loadTask(r.task) : null;
  for (const s of r.sides) s.score = scoreSide({ id: s.id, metrics: s.final || s, web: s.web, grade: s.grade }, { prompt: r.prompt, task, judge: r.judge, vote: r.vote });
  r.verdict = verdict(r.sides.map(s => ({ id: s.id, name: s.name, metrics: s.final || s, score: s.score })), task?.checks.tieMargin);
  if (r.grading || r.gradeError) r.verdict = {winner:null, why:r.gradeError || 'Grading is in progress.'};
  if (r.sides.some(s => s.score?.parts?.lookBy === 'pending')) r.verdict = {winner:null, why:'Appearance judgement is pending. Cast your blind vote to finish scoring.'};
}
function record(r, rows) {
  const sides = r.sides.map((s, i) => {
    const metrics = rows ? rows[i] : { id: s.id, name: s.name, ...(s.final || {}), grade: s.grade, error: s.error || null };
    return { ...metrics, settings: {engine:s.engine, contestant:s.contestant || s.id, options:s.options || null, permissionMode:s.mode ?? r.context?.mode, tools:{}}, evidence: s.evidence || null, results: s.results || null, page: s.page || null, relinked: s.relinked || [], score: s.score, web: s.web ? { ...s.web, shots: undefined } : null };
  });
  return { context: r.context, accounting: r.accounting, runId: r.runId, at: Date.now(), series: r.series ? { id: r.series.id, n: r.series.n, total: r.series.total } : null, config: r.config || null, pair: r.pair, template: r.template, task: r.task || null, prompt: r.prompt, ended: r.ended, grading: r.grading || null,
    gradeError: r.gradeError || null, judge: r.judge || null, vote: r.vote || null, blind: r.blind || null, verdict: r.verdict || null, sides };
}
function readResults() { return fs.existsSync(resultsFile) ? fs.readFileSync(resultsFile, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []; }
function upsert(rec) {
  const rows = readResults().filter(x => x.runId !== rec.runId);
  rows.push(rec);
  fs.writeFileSync(resultsFile, rows.map(x => JSON.stringify(x)).join('\n') + '\n');
}
async function gradeRound(r) {
  const task = loadTask(r.task), { gradeWeb } = await webGrader();
  for (const s of r.sides) {
    r.grading = `checking ${s.name}`; save();
    s.web = await gradeWeb(s.dir, task, path.join(shotsRoot, r.runId, s.id));
  }
  r.blind = Math.random() < 0.5 ? { A: r.sides[0].id, B: r.sides[1].id } : { A: r.sides[1].id, B: r.sides[0].id };
  rescore(r);
  if (r.sides.every(s => s.web?.shots?.desktop) && !DRY_JUDGE) {
    r.grading = `${JUDGE_FOR[r.pair] === 'codex' ? 'Codex (GPT)' : 'Claude'} is judging the look`; save(); upsert(record(r));
    const { judgePair } = await judgeMod();
    r.judge = await judgePair(JUDGE_FOR[r.pair], task, r.sides.map(s => ({ id: s.id, shots: s.web.shots })), task.checks.judge);
  }
  if (r.judge && !r.judge.valid) throw new Error('The AI judge could not complete. You can cast a blind vote instead.');
  r.grading = null; rescore(r); save(); upsert(record(r));
  log('graded', r.runId, JSON.stringify(r.verdict));
}
function findRound(runId) { // the live round, or a saved one
  if (runId && round?.runId === runId) return { live: true, r: round };
  const rec = readResults().find(x => x.runId === runId);
  return rec ? { live: false, r: rec } : null;
}
const names = r => Object.fromEntries(Object.entries(r.blind).map(([k, id]) => [k, r.sides.find(x => x.id === id)?.name || nameOf(id)]));
function voteInfo(runId) {
  const f = findRound(runId);
  if (!f) return { error: 'Unknown round.' };
  if (!f.r.blind) return { error: f.r.grading ? 'Still checking the pages. Try again in a minute.' : 'This round has no pages to compare.' };
  const slot = f.r.vote ? Object.keys(f.r.blind).find(k => f.r.blind[k] === f.r.vote.pick) || f.r.vote.pick : null;
  return { runId, prompt: f.r.prompt, vote: f.r.vote ? { slot, note: f.r.vote.note } : null, revealed: f.r.vote ? names(f.r) : null };
}
function castVote({ runId, slot, note = '' }) {
  const f = findRound(runId);
  if (!f?.r.blind) return { error: 'Unknown round.' };
  if (!['A', 'B', 'tie', 'bad', 'clear'].includes(slot)) return { error: 'Bad vote.' };
  const r = f.r;
  r.vote = slot === 'clear' ? null : { pick: slot === 'A' || slot === 'B' ? r.blind[slot] : slot, note: String(note).slice(0, 500), at: Date.now() };
  if (r.vote && r.sides.every(s => s.web)) r.gradeError = null;
  rescore(r);
  if (f.live) { save(); upsert(record(r)); } else upsert(r);
  log('vote', runId, slot);
  const judgeSlot = r.judge?.winner ? (r.judge.winner === 'tie' ? 'tie' : Object.keys(r.blind).find(k => r.blind[k] === r.judge.winner)) : null;
  return { ok: true, verdict: r.verdict, revealed: r.vote ? names(r) : null, judge: r.judge ? { slot: judgeSlot, agreement: r.judge.agreement, engine: r.judge.engine } : null };
}
// the web page a side made, to preview: an index.html first, else the shallowest .html it made or changed
function pickPage(results = []) {
  const html = results.filter(r => r.kind !== 'deleted' && /\.html?$/i.test(r.file));
  return (html.find(r => /(^|[\\/])index\.html?$/i.test(r.file)) || html[0])?.file.replace(/\\/g, '/') || null;
}
// /result/<run>/<A|B>/<file...>: what a side made, for the page's side-by-side results (sandboxed like /site)
// The sandbox comes from this header (an opaque origin, like artifacts): the preview frame adds no sandbox attribute,
// because with one the browser would not show the page at all.
function serveResult(res, [, runId, id, ...rest]) {
  const f = findRound(runId), dir = f && sideDir(f.r, id);
  if (!dir || !rest.join('')) return send(res, 404, { error: 'not found' });
  let base, file;
  try { base = fs.realpathSync(path.resolve(dir)); file = fs.realpathSync(path.resolve(base, ...rest.map(decodeURIComponent))); } catch { return send(res, 404, { error: 'not found' }); }
  if (!file.startsWith(base + path.sep) || !fs.statSync(file).isFile()) return send(res, 404, { error: 'not found' });
  res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'text/plain; charset=utf-8', 'cache-control': 'no-store',
    // a sandboxed page has no origin of its own, so 'self' would refuse the Benchmark page's preview: name the app
    'content-security-policy': `sandbox allow-scripts allow-forms; default-src http://127.0.0.1:${PORT}/benchmark/result/ http://localhost:${PORT}/benchmark/result/ 'unsafe-inline' data: blob:; connect-src 'none'; frame-ancestors http://127.0.0.1:${PORT} http://localhost:${PORT}`, 'x-content-type-options': 'nosniff' });
  fs.createReadStream(file).pipe(res);
}
function sideDir(r, id) { const s = r.sides.find(x => x.id === id); if (!s) return null; return round?.runId === r.runId ? s.dir : path.join(LIVE, 'archive', r.runId, id); }
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon', '.webp': 'image/webp', '.gif': 'image/gif', '.woff2': 'font/woff2' };
function serveBlind(res, parts) { // /shot/<run>/<A|B>/<view>.png  and  /site/<run>/<A|B>/<file...>
  const [kind, runId, slot, ...rest] = parts;
  const f = findRound(runId), id = f?.r.blind?.[slot];
  if (!id) return send(res, 404, { error: 'not found' });
  const base = path.resolve(kind === 'shot' ? path.join(shotsRoot, runId, id) : sideDir(f.r, id));
  const file = path.resolve(base, ...(rest.join('') ? rest.map(decodeURIComponent) : ['index.html']));
  if (!file.startsWith(base + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile() || !fs.realpathSync(file).startsWith(fs.realpathSync(base) + path.sep)) return send(res, 404, { error: 'not found' });
  res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store',
    ...(kind === 'site' ? { 'content-security-policy': "sandbox allow-scripts allow-forms; default-src 'self' 'unsafe-inline' data: blob:; connect-src 'none'; frame-ancestors 'self'" } : {}) });
  fs.createReadStream(file).pipe(res);
}
function state() {
  const base = { tasks: listTasks(), contestants: contestantList(), defaults: context() || null };
  if (!round) return { round: null, ...base };
  let sides = round.sides.map(sideView);
  // finishing records each side's results: show them in this same reply
  if (round.runId && !round.saved && sides.every(s => ['done', 'failed'].includes(s.metrics.status))) { finish('both done'); sides = round.sides.map(sideView); }
  for (const s of sides) {
    const o = round.sides.find(x => x.id === s.id);
    s.grade = o?.grade || null; s.score = o?.score || null; s.web = o?.web ? { F: o.web.F, R: o.web.R } : null; delete s.final;
  }
  const { sides: _, ...r } = round;
  return { round: { ...r, sides, replyRule: replyRule(round.prompt, round.task ? loadTask(round.task)?.checks : null) }, series: seriesSummary(round.series), ...base };
}
async function stopRound() {
  if (!round?.runId) return { error: 'Nothing is running.' };
  if (round.series) round.series.stopped = true;
  if (round.saved) { save(); return { ok: true, note: 'Repeats stopped.' }; }
  for (const s of round.sides) if (s.via === 'claudeos' && s.chatId && !DRY) await stop(s).catch(() => {});
  for (const s of round.sides) if (s.waiting) { s.waiting = false; s.failed = true; s.error = 'Not started: stopped by you.'; }
  closeWindows(round);
  finish('stopped by you');
  return { ok: true, note: 'Stopped. Their windows are closed and both folders are kept.' };
}
// medians over the rounds of one series (the repeats of one comparison)
function seriesSummary(series) {
  if (!series) return null;
  const rows = readResults().filter(x => x.series?.id === series.id);
  const med = a => { const v = a.filter(n => typeof n === 'number').sort((x, y) => x - y); return v.length ? (v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2) : null; };
  const by = {};
  for (const r of rows) for (const sd of r.sides) {
    const b = by[sd.id] ||= { name: sd.name, rounds: 0, done: 0, elapsed: [], fresh: [], cached: [], output: [], total: [], cost: [], quality: [], wins: 0 };
    b.rounds++; if (sd.status === 'done') b.done++;
    b.elapsed.push(sd.elapsedMs); b.fresh.push(sd.tokens?.fresh); b.cached.push(sd.tokens?.cacheRead); b.output.push(sd.tokens?.output); b.total.push(sd.tokens?.total); b.cost.push(sd.tokens?.cost);
    if (sd.score?.quality != null) b.quality.push(sd.score.quality);
    if (r.verdict?.winner === sd.id) b.wins++;
  }
  const out = Object.fromEntries(Object.entries(by).map(([k, b]) => [k, { name: b.name, rounds: b.rounds, done: b.done, wins: b.wins,
    elapsedMs: med(b.elapsed), fresh: med(b.fresh), cached: med(b.cached), output: med(b.output), total: med(b.total), cost: med(b.cost), quality: med(b.quality) }]));
  return { id: series.id, n: series.n, total: series.total, stopped: !!series.stopped, recorded: rows.length, sides: out };
}
// Windows' own folder picker, for "a copy of my project"
function pickFolder() {
  if (NOWIN) return { ok: true, folder: '' };
  const script = 'Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = "Pick the project both contestants get a copy of"; $d.ShowNewFolderButton = $false; $f = New-Object System.Windows.Forms.Form; $f.TopMost = $true; if ($d.ShowDialog($f) -eq "OK") { [Console]::Out.Write($d.SelectedPath) }';
  const r = spawnSync('powershell.exe', ['-NoProfile', '-STA', '-Command', script], { encoding: 'utf8', timeout: 10 * 60e3, windowsHide: false });
  return { ok: true, folder: String(r.stdout || '').trim() };
}

// ---------- http ----------
const send = (res, code, body, type = 'application/json') => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' }); res.end(type === 'application/json' ? JSON.stringify(body) : body); };
function page(res, file) {
  let html = fs.readFileSync(path.join(here, file), 'utf8');
  html = html.replace(/(href|src)="\/(?!\/|benchmark\/)/g, '$1="/benchmark/');
  html = html.replace('<script>', `<script>
const benchFetch = (p, o = {}) => fetch('/benchmark' + p, {...o, headers: {...o.headers, 'x-claudeos-token': ${JSON.stringify(token)}}});
`);
  html = html.replaceAll("fetch('/api/", "benchFetch('/api/").replaceAll('await fetch(p,', 'await benchFetch(p,');
  return send(res, 200, html, 'text/html; charset=utf-8');
}
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function report(res, id) {
  const f = findRound(id);
  if (!f) return send(res, 404, {error: 'Unknown round.'});
  const r = f.live ? record(f.r) : f.r;
  const evidence = JSON.stringify(r, null, 2);
  res.setHeader('content-disposition', `attachment; filename="benchmark-${r.runId}.html"`);
  return send(res, 200, `<!doctype html><meta charset="utf-8"><title>ClaudeOS Benchmark</title><style>body{font:16px/1.6 system-ui;max-width:1000px;margin:40px auto;padding:20px}pre{white-space:pre-wrap;background:#f1f3f5;padding:20px}h1{font-size:28px}</style><h1>ClaudeOS Benchmark</h1><p>${esc(r.runId)} ? ${esc(r.verdict?.why || 'No final verdict')}</p><p>${esc(r.accounting)}</p><p>Scoring weights are provisional. A custom prompt without task checks does not receive a quality score. Settings in the competing app must be matched manually. This report contains local paths and your prompt; review before sharing.</p><h2>Prompt</h2><pre>${esc(r.prompt)}</pre><h2>Recorded evidence</h2><pre>${esc(evidence)}</pre>`, 'text/html; charset=utf-8');
}
const monitor = setInterval(() => {
  try { if (round?.runId && !round.saved) { state(); advance().catch(e => log('benchmark next side', e.message)); } else repeat().catch(e => log('benchmark repeat', e.message)); }
  catch (e) { log('benchmark monitor', e.message); }
}, 2000);
monitor.unref();
let mutating = false;
return { async handle(req, res, url) {
  const route = url.pathname.slice('/benchmark'.length) || '/';
  const origin = req.headers.origin;
  const hosts = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
  if (origin && !hosts.has(origin.replace(/^https?:\/\//, ''))) return send(res, 403, {error: 'origin'});
  if (route.startsWith('/api/') && req.headers['x-claudeos-token'] !== token) return send(res, 403, {error: 'forbidden'});
  try {
    if (req.method === 'GET') {
      if (route === '/') return page(res, 'index.html');
      if (route === '/history') return page(res, 'history.html');
      if (route === '/vote') return page(res, 'vote.html');
      if (route === '/harbor') return page(res, 'harbor.html');
      if (route === '/watch') return page(res, 'watch.html');
      if (route === '/api/watch') { const sd = round?.sides.find(x => x.id === url.searchParams.get('side')); if (!sd) return send(res, 404, {error: 'No such contestant in this round.'}); const v = sd.chatId && watch ? watch(sd) : { ok: true, messages: [] }; return send(res, 200, { name: sd.name, side: sd.id, waiting: !!sd.waiting, failed: !!sd.failed, error: sd.error || null, runId: round.runId, ...v }); }
      if (route === '/api/harbor') return send(res, 200, { ...(await harbor.status()), jobs: harbor.listJobs(), tasks: listTasks(), suites: Object.entries(SUITES).map(([id, s]) => ({ id, name: s.name })) });
      if (route === '/report') return report(res, url.searchParams.get('run'));
      if (route === '/api/state') return send(res, 200, state());
      if (route === '/api/history') return send(res, 200, readResults().reverse());
      if (route === '/api/vote') return send(res, 200, voteInfo(url.searchParams.get('run')));
      if (/^\/(shot|site)\//.test(route)) return serveBlind(res, route.slice(1).split('/'));
      if (route.startsWith('/result/')) return serveResult(res, route.slice(1).split('/'));
    }
    if (req.method !== 'POST') return send(res, 404, {error: 'not found'});
    if (route.startsWith('/api/harbor/')) {
      let raw = ''; for await (const ch of req) { raw += ch; if (raw.length > 10000) return send(res, 413, {error: 'Too large.'}); }
      const body = raw ? JSON.parse(raw) : {};
      const act = { 'docker-install': harbor.dockerInstall, 'docker-start': harbor.dockerStart, 'harbor-install': harbor.harborInstall,
        'claude-connect': harbor.claudeConnect, 'claude-code': () => harbor.claudeCode(body.code), 'claude-cancel': harbor.claudeCancel,
        'claude-disconnect': harbor.claudeDisconnect, run: () => harbor.runJob(body), stop: harbor.stopJob }[route.slice('/api/harbor/'.length)];
      return act ? send(res, 200, await act()) : send(res, 404, {error: 'not found'});
    }
    if (mutating) return send(res, 409, {error: 'Another benchmark action is in progress.'});
    mutating = true;
    try {
      let raw = ''; for await (const c of req) { raw += c; if (raw.length > 100000) return send(res, 413, {error: 'Prompt too large.'}); }
      const body = raw ? JSON.parse(raw) : {};
      if (route === '/api/prepare') return send(res, 200, prepare(body));
      if (route === '/api/run') return send(res, 200, await run(body));
      if (route === '/api/grade') {
        if (!round?.saved || !round.task || round.grading) return send(res, 409, {error:'No completed task ready to grade.'});
        const r = round; r.gradeError = null; r.grading = 'checking the pages'; save();
        gradeRound(r).catch(e => {r.grading=null; r.gradeError=e.message; rescore(r); save(); upsert(record(r));});
        return send(res, 200, {ok:true});
      }
      if (route === '/api/stop') return send(res, 200, await stopRound());
      if (route === '/api/pick-folder') return send(res, 200, pickFolder());
      if (route === '/api/vote') return send(res, 200, castVote(body));
      if (route === '/api/open') { const s = round?.sides.find(x => x.id === body.id); if (s && !DRY) spawn('explorer.exe', [s.dir], {detached:true, windowsHide:true}).unref(); return send(res, 200, {ok:!!s}); }
      return send(res, 404, {error:'not found'});
    } finally { mutating = false; }
  } catch (e) { log('benchmark error', e.message); return send(res, 500, {error: e.message}); }
}, close: () => clearInterval(monitor), busy: () => !!round?.grading || !!round?.runId && !round.saved || harbor.busy() };
}
