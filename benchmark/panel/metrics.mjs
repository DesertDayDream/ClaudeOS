// Live metrics for one contestant: read from the app's own session log (Claude: ~/.claude/projects,
// Codex: ~/.codex/sessions) and from the files in its working folder.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const claudeHome = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');

const walk = (dir, since, out = []) => {
  let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, since, out);
    else if (e.name.endsWith('.jsonl')) { try { if (fs.statSync(p).mtimeMs >= since) out.push(p); } catch { /* gone */ } }
  }
  return out;
};
const readLines = f => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };
const ts = o => Date.parse(o?.timestamp || '') || null;
const humanText = o => {
  if (o.type === 'user' && !o.isSidechain) { const c = o.message?.content; return typeof c === 'string' ? c : Array.isArray(c) ? c.filter(b => b.type === 'text').map(b => b.text).join('\n') : ''; }
  if (o.type === 'event_msg' && o.payload?.type === 'user_message') return String(o.payload.message || '');
  if (o.type === 'response_item' && o.payload?.type === 'message' && o.payload.role === 'user') // newer Codex logs
    return (o.payload.content || []).filter(b => b.type === 'input_text').map(b => b.text).join('\n');
  return '';
};

// Find the session whose typed prompt carries this run's tag (cached once found).
export function findSession(side) {
  if (side.logFile) return side.logFile;
  const root = side.engine === 'codex' ? path.join(codexHome, 'sessions') : path.join(claudeHome, 'projects');
  for (const f of walk(root, side.startedAt - 10e3)) {
    if (f.includes(`${path.sep}subagents${path.sep}`)) continue;
    let raw; try { raw = fs.readFileSync(f, 'utf8'); } catch { continue; }
    if (raw.includes(side.tag) && readLines(f).some(o => humanText(o).includes(side.tag))) return (side.logFile = f);
  }
  return null;
}

const empty = () => ({ found: false, done: false, promptAt: null, firstAt: null, lastAt: null, doneAt: null, calls: 0, tools: 0, toolErrors: 0, toolNames: {},
  input: 0, cacheWrite: 0, cacheRead: 0, output: 0, reasoning: 0, contextPeak: 0, models: new Set(), efforts: new Set(), cwd: null, subagents: 0, app: null, reply: null, writes: [] });

function claudeMetrics(side) {
  const m = empty(), f = findSession(side);
  if (!f) return m;
  const rows = readLines(f), at = rows.findIndex(o => humanText(o).includes(side.tag));
  if (at < 0) return m;
  m.found = true; m.promptAt = ts(rows[at]); m.cwd = rows[at].cwd || null; m.app = rows[at].entrypoint || null;
  const subDir = path.join(f.slice(0, -'.jsonl'.length), 'subagents');
  const subs = walk(subDir, 0); m.subagents = subs.length;
  const seen = new Set(), toolIds = new Set();
  let lastMain = null;
  const take = (o, main) => {
    const t = ts(o);
    if (o.type === 'assistant') {
      if (t && !m.firstAt && main) m.firstAt = t;
      if (t) m.lastAt = Math.max(m.lastAt || 0, t);
      if (main) lastMain = o;
      const msg = o.message || {};
      const blocks = Array.isArray(msg.content) ? msg.content : [];
      if (main) { const txt = blocks.filter(b => b.type === 'text').map(b => b.text).join('\n'); if (txt.trim()) m.reply = txt; }
      for (const b of blocks) if (b.type === 'tool_use' && !toolIds.has(b.id)) {
        toolIds.add(b.id); m.tools++; m.toolNames[b.name] = (m.toolNames[b.name] || 0) + 1;
        const fp = b.input?.file_path || b.input?.notebook_path; if (fp && /^(Write|Edit|MultiEdit|NotebookEdit)$/.test(b.name)) m.writes.push(fp);
      }
      const u = msg.usage, key = msg.id || o.requestId;
      if (u && key && !seen.has(key)) {
        seen.add(key); m.calls++;
        if (msg.model && msg.model !== '<synthetic>') m.models.add(msg.model);
        if (o.effort) m.efforts.add(o.effort);
        m.input += u.input_tokens || 0; m.cacheWrite += u.cache_creation_input_tokens || 0; m.cacheRead += u.cache_read_input_tokens || 0; m.output += u.output_tokens || 0;
        m.contextPeak = Math.max(m.contextPeak, (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0));
      }
    } else if (o.type === 'user' && Array.isArray(o.message?.content)) {
      for (const b of o.message.content) if (b.type === 'tool_result' && b.is_error) m.toolErrors++;
    }
  };
  for (const o of rows.slice(at + 1)) take(o, true);
  for (const s of subs) for (const o of readLines(s)) take(o, false);
  if (lastMain?.message?.stop_reason === 'end_turn' || lastMain?.message?.stop_reason === 'stop_sequence') { m.done = true; m.doneAt = ts(lastMain); }
  return m;
}

function codexMetrics(side) {
  const m = empty(), f = findSession(side);
  if (!f) return m;
  const rows = readLines(f), at = rows.findIndex(o => humanText(o).includes(side.tag));
  if (at < 0) return m;
  m.found = true; m.promptAt = ts(rows[at]);
  const meta = rows.find(o => o.type === 'session_meta')?.payload || {};
  m.cwd = meta.cwd || null; m.app = meta.originator || null;
  let before = {}, after = null;
  for (const [i, o] of rows.entries()) {
    const p = o.payload || {};
    if (o.type === 'turn_context' && i >= at - 3) { if (p.model) m.models.add(p.model); const e = p.effort || p.reasoning_effort || p.collaboration_mode?.settings?.reasoning_effort; if (e) m.efforts.add(e); if (p.cwd) m.cwd = p.cwd; }
    if (o.type === 'event_msg' && p.type === 'token_count' && p.info?.total_token_usage) {
      if (i < at) before = p.info.total_token_usage;
      else {
        after = p.info.total_token_usage; m.calls++;
        const l = p.info.last_token_usage; if (l) m.contextPeak = Math.max(m.contextPeak, l.input_tokens || 0);
      }
    }
    if (i <= at) continue;
    const t = ts(o);
    if (o.type === 'response_item') {
      if (t && !m.firstAt) m.firstAt = t;
      if (t) m.lastAt = t;
      if (/^(function_call|custom_tool_call|local_shell_call|web_search_call)$/.test(p.type)) { m.tools++; const n = p.name || p.type; m.toolNames[n] = (m.toolNames[n] || 0) + 1; }
      if (/_output$/.test(p.type) && /exit code:? *[1-9]|"exit_code":\s*[1-9]/i.test(typeof p.output === 'string' ? p.output : JSON.stringify(p.output || ''))) m.toolErrors++;
    }
    if (o.type === 'event_msg' && p.type === 'agent_message' && p.message) m.reply = p.message;
    if (o.type === 'event_msg' && p.type === 'task_complete') { m.done = true; m.doneAt = t; if (p.last_agent_message) m.reply = p.last_agent_message; }
    if (o.type === 'event_msg' && p.type === 'task_started') { m.done = false; m.doneAt = null; }
  }
  if (after) {
    const d = k => (after[k] || 0) - (before[k] || 0);
    m.cacheRead = d('cached_input_tokens'); m.input = d('input_tokens') - m.cacheRead;
    m.reasoning = d('reasoning_output_tokens'); m.output = d('output_tokens'); // output includes reasoning
  }
  return m;
}

// ---------- the working folder ----------
const SKIP = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'venv', 'dist', 'build', '.next', '.cache']);
export function snapshotDir(dir) {
  const files = {};
  const go = d => {
    let entries; try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (SKIP.has(e.name) || e.isSymbolicLink()) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { go(p); continue; }
      let buf; try { const st = fs.statSync(p); if (st.size > 2e6) { files[path.relative(dir, p)] = null; continue; } buf = fs.readFileSync(p); } catch { continue; }
      files[path.relative(dir, p)] = buf.includes(0) ? null : buf.toString('utf8').split(/\r?\n/).filter((l, i, a) => i < a.length - 1 || l !== '');
    }
  };
  go(dir);
  return files;
}
// lines added/removed per file as a multiset difference (order-insensitive, cheap, good enough for a live view)
export function diffDirs(base, now) {
  let added = 0, removed = 0, created = 0, changed = 0, deleted = 0, lines = 0, files = 0;
  for (const [f, cur] of Object.entries(now)) {
    files++; if (cur) lines += cur.length;
    const old = base[f];
    if (old === undefined) { created++; if (cur) added += cur.length; continue; }
    if (!cur || !old) { if (cur !== old) changed++; continue; }
    const count = new Map(); for (const l of old) count.set(l, (count.get(l) || 0) + 1);
    let a = 0; for (const l of cur) { const c = count.get(l); if (c) count.set(l, c - 1); else a++; }
    const r = [...count.values()].reduce((s, v) => s + v, 0);
    if (a || r) changed++; added += a; removed += r;
  }
  for (const [f, old] of Object.entries(base)) if (!(f in now)) { deleted++; if (old) removed += old.length; }
  return { added, removed, created, changed, deleted, lines, files };
}

export function measure(side, now = Date.now()) {
  const m = !side.tag || !side.startedAt ? empty() : side.engine === 'codex' ? codexMetrics(side) : claudeMetrics(side);
  const start = m.promptAt || side.startedAt;
  const end = m.done ? (m.doneAt || m.lastAt || now) : now;
  const fresh = m.input + m.cacheWrite, totalIn = fresh + m.cacheRead;
  const disk = side.baseline ? diffDirs(side.baseline, snapshotDir(side.dir)) : null;
  const minutes = Math.max(1e-6, (end - start) / 60e3);
  return {
    status: !side.startedAt ? 'ready' : !m.found ? 'waiting for log' : m.done ? 'done' : 'working',
    elapsedMs: side.startedAt ? end - start : 0,
    firstMs: m.firstAt && m.promptAt ? m.firstAt - m.promptAt : null,
    calls: m.calls, tools: m.tools, toolErrors: m.toolErrors, toolNames: m.toolNames, subagents: m.subagents,
    tokens: { input: m.input, cacheWrite: m.cacheWrite, fresh, cacheRead: m.cacheRead, output: m.output, reasoning: m.reasoning, total: totalIn + m.output },
    cacheHit: totalIn ? m.cacheRead / totalIn : null,
    contextPeak: m.contextPeak || null,
    outPerMin: m.found && m.output ? m.output / minutes : null,
    model: [...m.models].join(', ') || null, effort: [...m.efforts].join(', ') || null,
    cwdOk: m.cwd ? path.resolve(m.cwd).toLowerCase() === path.resolve(side.dir).toLowerCase() : null, cwd: m.cwd, app: m.app,
    disk, logFile: side.logFile || null,
    reply: m.reply,
    outsideWrites: m.writes.filter(f => { const r = path.relative(path.resolve(side.dir), path.resolve(m.cwd || side.dir, f)); return r.startsWith('..') || path.isAbsolute(r); }),
  };
}
