// Built-in ClaudeOS benchmark: mounted at /benchmark on the authenticated app server.
//   Pair buttons  -> fresh blank working folders + windows side by side (ClaudeOS left, the other app right, panel below)
//   Run           -> starts ClaudeOS through its local API and pastes the same prompt into the other app
//   Live metrics  -> read from each app's own session log and from its working folder
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { measure, snapshotDir } from './metrics.mjs';
const graders = {};
import { createTasks } from '../grader/tasks.mjs';
import { scoreSide, verdict, replyRule } from '../grader/scoring.mjs';

export function createBenchmark({ kit, dataDir, port, token, context, start, stop }) {
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
const APP = { // how to reach each contestant
  'claudeos-claude': { engine: 'claude', via: 'claudeos' },
  'claudeos-codex': { engine: 'codex', via: 'claudeos' },
  'claude-desktop': { engine: 'claude', via: 'paste', proc: 'claude' },
  'chatgpt': { engine: 'codex', via: 'paste', proc: 'ChatGPT' },
};
const JUDGE_FOR = { claude: 'codex', codex: 'claude' }; // the judge comes from the other model family
const PAIRS = { claude: ['claudeos-claude', 'claude-desktop'], codex: ['claudeos-codex', 'chatgpt'] };
const TEMPLATES = [''];
const nameOf = id => contestants.find(c => c.id === id)?.name || id;

fs.mkdirSync(LIVE, { recursive: true });
const stateFile = path.join(LIVE, 'state.json'), resultsFile = path.join(LIVE, 'results.jsonl');
let round = null;
try { round = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { /* first start */ }
const save = () => fs.writeFileSync(stateFile, JSON.stringify(round));
if (round?.grading) { round.grading = null; round.gradeError = 'Grading was interrupted. Retry grading to finish.'; save(); }
const log = (...a) => console.log(new Date().toLocaleTimeString(), ...a);

// ---------- windows ----------
function ps(file, args, timeout = 60e3) {
  if (NOWIN) return { ok: true, out: 'DRY' };
  const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file, ...args], { encoding: 'utf8', timeout, windowsHide: true });
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
  return { ok: r.status === 0, out };
}
const arrange = () => ({ok: true, out: 'Use the folder shown below in a new chat in the other app.'});

// ---------- fresh folders ----------
function prepare({ pair, template = '' }) {
  if (!context()) return {error: 'Select a brain in ClaudeOS first.'};
  if (!PAIRS[pair]) return { error: 'Unknown pair.' };
  let task = null;
  if (template.startsWith('task:')) { task = loadTask(template.slice(5)); if (!task) return { error: 'Unknown task.' }; template = ''; }
  if (!TEMPLATES.includes(template)) return { error: 'Unknown starting files.' };
  if (round?.runId && !round.saved) return {error: 'Stop or finish the current round first.'};
  if (round?.grading) return {error: 'Wait for grading to finish.'};
  if (round?.sides) {
    const archiveId = round.runId || 'prepared-' + crypto.randomUUID();
    for (const side of round.sides) {
      if (!fs.existsSync(side.dir)) continue;
      const dest = path.join(LIVE, 'archive', archiveId, side.id);
      fs.mkdirSync(path.dirname(dest), {recursive:true});
      if (fs.existsSync(dest)) throw new Error('Archive already exists; previous files were preserved.');
      fs.renameSync(side.dir, dest);
    }
  }
  const sides = PAIRS[pair].map(id => {
    const dir = path.join(LIVE, id);
    if (fs.existsSync(dir)) {
      const archive = path.join(LIVE, 'archive', round?.runId || crypto.randomUUID(), id);
      fs.mkdirSync(path.dirname(archive), {recursive: true});
      if (!fs.existsSync(archive)) fs.renameSync(dir, archive);
      else throw new Error('Archive already exists; previous files have been preserved.');
    }
    fs.mkdirSync(dir, {recursive: true});
    if (template) fs.cpSync(path.join(kit, 'template', template), dir, { recursive: true });
    return { id, name: nameOf(id), dir, engine: APP[id].engine, via: APP[id].via, proc: APP[id].proc || null, baseline: snapshotDir(dir) };
  });
  round = { context: context(), accounting: 'Matched session and Claude native subagents only. Separate employee, coaching and judge sessions are not included. Token counts are usage, not subscription charges.', pair, template, task: task?.id || null, preparedAt: Date.now(), runId: null, prompt: '', sides, saved: false, notes: [] };
  save();
  const w = arrange(pair);
  log('prepared', pair, task ? 'task ' + task.id : template || '(empty)', w.out);
  return { ok: true, arranged: w.ok, arrangeOutput: w.out, prompt: task?.prompt || null };
}

// ---------- starting the contestants ----------
async function startClaudeOS(side, text) {
  if (DRY) return 'DRY';
  return await start(side, text, round.context);
}
function startPaste(side, text, auto) {
  if (!auto) return 'waiting for you to send the tagged prompt';
  const file = path.join(LIVE, `prompt-${side.id}.txt`);
  fs.writeFileSync(file, text);
  if (NOWIN) return 'DRY';
  const r = ps(path.join(here, 'paste.ps1'), ['-Proc', side.proc, '-TextFile', file, ...(auto ? [] : ['-NoEnter'])], 20e3);
  if (/NOWINDOW/.test(r.out)) throw new Error(`${side.name} isn't open.`);
  if (/NOFOCUS/.test(r.out)) throw new Error(`Couldn't bring ${side.name} to the front. The prompt is on the clipboard: click its message box, Ctrl+V, Enter.`);
  if (!r.ok) throw new Error(r.out || 'paste failed');
  return auto ? 'pasted + sent' : 'pasted (press Enter)';
}
async function run({ prompt, autoSend = true }) {
  prompt = String(prompt || '').trim();
  if (!round) return { error: 'Pick a pair first.' };
  if (context()?.brainId !== round.context?.brainId) return {error: 'The active brain changed. Prepare a new pair.'};
  if (prompt.length > 80000) return {error: 'Prompt exceeds 80,000 characters.'};
  if (round.context == null) return {error: 'Prepare a new pair.'};
  if (!prompt) return { error: 'Write a prompt first.' };
  if (round.runId) return { error: 'This round already ran. Press a pair button for a fresh round.' };
  const d = new Date(), pad = n => String(n).padStart(2, '0');
  round.runId = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${crypto.randomBytes(3).toString('hex')}`;
  round.prompt = prompt;
  const results = [];
  for (const s of round.sides) {
    s.tag = `Benchmark run ${round.runId}-${s.id}.`;
    s.startedAt = Date.now();
    const text = `${s.tag}\n\n${prompt}`;
    if (s.via === 'paste' && round.sides.find(x => x.via === 'claudeos')?.failed) {s.start = 'failed'; s.failed = true; s.error = 'ClaudeOS did not start; comparison was not sent.'; results.push({name:s.name,start:s.start,error:s.error}); continue;}
    try { s.start = s.via === 'claudeos' ? await startClaudeOS(s, text) : startPaste(s, text, autoSend); }
    catch (e) { s.start = 'failed'; s.error = e.message; s.failed = true; }
    results.push({ name: s.name, start: s.start, error: s.error || null });
  }
  save();
  log('run', round.runId, JSON.stringify(results));
  return { ok: true, runId: round.runId, results };
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
    s.evidence = Object.entries(snapshotDir(s.dir)).map(([file, lines]) => ({file, text: lines ? lines.join('\n').slice(0, 100000) : null})).slice(0, 100);
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
    return { ...metrics, settings: {engine:s.engine, permissionMode:r.context?.mode, tools:{}}, evidence: s.evidence || null, score: s.score, web: s.web ? { ...s.web, shots: undefined } : null };
  });
  return { context: r.context, accounting: r.accounting, runId: r.runId, at: Date.now(), pair: r.pair, template: r.template, task: r.task || null, prompt: r.prompt, ended: r.ended, grading: r.grading || null,
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
const names = r => Object.fromEntries(Object.entries(r.blind).map(([k, id]) => [k, nameOf(id)]));
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
  if (!round) return { round: null, templates: TEMPLATES, tasks: listTasks(), pairs: Object.fromEntries(Object.entries(PAIRS).map(([k, v]) => [k, v.map(nameOf)])) };
  const sides = round.sides.map(sideView);
  if (round.runId && !round.saved && sides.every(s => ['done', 'failed'].includes(s.metrics.status))) finish('both done');
  for (const s of sides) {
    const o = round.sides.find(x => x.id === s.id);
    s.grade = o?.grade || null; s.score = o?.score || null; s.web = o?.web ? { F: o.web.F, R: o.web.R } : null; delete s.final;
  }
  const { sides: _, ...r } = round;
  return { round: { ...r, sides, replyRule: replyRule(round.prompt, round.task ? loadTask(round.task)?.checks : null) }, templates: TEMPLATES, tasks: listTasks(), pairs: Object.fromEntries(Object.entries(PAIRS).map(([k, v]) => [k, v.map(nameOf)])) };
}
async function stopRound() {
  if (!round?.runId) return { error: 'Nothing is running.' };
  const left = round.sides.find(s => s.via === 'claudeos');
  if (left && !DRY) await stop(left).catch(() => {});
  finish('stopped by you');
  return { ok: true, note: `Stop ${round.sides.find(s => s.via === 'paste')?.name} yourself if it's still working.` };
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
const monitor = setInterval(() => { if (round?.runId && !round.saved) { try {state();} catch (e) {log('benchmark monitor', e.message);} } }, 2000);
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
      if (route === '/report') return report(res, url.searchParams.get('run'));
      if (route === '/api/state') return send(res, 200, state());
      if (route === '/api/history') return send(res, 200, readResults().reverse());
      if (route === '/api/vote') return send(res, 200, voteInfo(url.searchParams.get('run')));
      if (/^\/(shot|site)\//.test(route)) return serveBlind(res, route.slice(1).split('/'));
    }
    if (req.method !== 'POST') return send(res, 404, {error: 'not found'});
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
      if (route === '/api/vote') return send(res, 200, castVote(body));
      if (route === '/api/open') { const s = round?.sides.find(x => x.id === body.id); if (s && !DRY) spawn('explorer.exe', [s.dir], {detached:true, windowsHide:true}).unref(); return send(res, 200, {ok:!!s}); }
      return send(res, 404, {error:'not found'});
    } finally { mutating = false; }
  } catch (e) { log('benchmark error', e.message); return send(res, 500, {error: e.message}); }
}, close: () => clearInterval(monitor), busy: () => !!round?.grading || !!round?.runId && !round.saved };
}
