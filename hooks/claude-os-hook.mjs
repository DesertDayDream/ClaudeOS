// Claude Code hook: logs tasks, skill hand-offs and task ends to <data folder>/activity.jsonl
// so ClaudeOS can show which employees (skills) are working and what their runs produced. The data
// folder is passed as the first argument (ClaudeOS writes it into each brain's hooks), else ~/.claudeos.
// Never blocks Claude: any error is swallowed and the hook always exits 0.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA = process.argv[2] || process.env.CLAUDEOS_HOME || path.join(os.homedir(), '.claudeos');
const LOG = path.join(DATA, 'activity.jsonl');
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

function tail(file, bytes) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const text = buf.toString('utf8');
    return start ? text.slice(text.indexOf('\n') + 1) : text;
  } finally { fs.closeSync(fd); }
}

// When this session's latest task started, from our own log.
function taskStart(session) {
  try {
    const lines = tail(LOG, 1 << 20).split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes(session)) continue;
      const ev = JSON.parse(lines[i]);
      if (ev.session === session && ev.type === 'task') return ev.ts;
    }
  } catch { /* no log yet */ }
  return 0;
}

// What the task produced: Claude's last words, how many tools it used, and the files each skill wrote.
function results(h) {
  const out = { result: '', tools: 0, files: [], bySkill: {} };
  if (!h.transcript_path) return out;
  const since = taskStart(h.session_id) - 2000;
  const rel = f => { const r = path.relative(h.cwd || '', f); return r && !r.startsWith('..') && !path.isAbsolute(r) ? r : f; };
  let skill = null;
  for (const line of tail(h.transcript_path, 4 << 20).split('\n')) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.type !== 'assistant' || (e.timestamp && Date.parse(e.timestamp) < since)) continue;
    for (const b of e.message?.content || []) {
      if (b.type === 'text' && b.text.trim()) out.result = b.text;
      if (b.type !== 'tool_use') continue;
      out.tools++;
      if (b.name === 'Skill') { skill = b.input?.skill || b.input?.command; out.bySkill[skill] ||= { files: [], tools: 0 }; continue; }
      if (skill) out.bySkill[skill].tools++;
      const f = WRITE_TOOLS.has(b.name) && (b.input?.file_path || b.input?.notebook_path);
      if (!f) continue;
      const r = rel(f);
      if (!out.files.includes(r)) out.files.push(r);
      if (skill && !out.bySkill[skill].files.includes(r)) out.bySkill[skill].files.push(r);
    }
  }
  out.result = clip(out.result, 600);
  out.files = out.files.slice(0, 30);
  return out;
}

let input = '';
process.stdin.on('data', d => { input += d; });
process.stdin.on('end', () => {
  try {
    const h = JSON.parse(input);
    const base = { ts: Date.now(), session: h.session_id, cwd: h.cwd };
    let ev = null;
    if (h.hook_event_name === 'UserPromptSubmit') {
      ev = { ...base, type: 'task', prompt: clip(h.prompt, 140) };
    } else if (h.hook_event_name === 'PreToolUse' && h.tool_name === 'Skill') {
      ev = { ...base, type: 'skill', skill: h.tool_input?.skill || h.tool_input?.command || 'unknown' };
    } else if (h.hook_event_name === 'Stop') {
      let r = {};
      try { r = results(h); } catch { /* the stop still counts without results */ }
      ev = { ...base, type: 'stop', outcome: 'done', ...r };
    }
    if (ev) {
      fs.mkdirSync(DATA, { recursive: true });
      fs.appendFileSync(LOG, JSON.stringify(ev) + '\n');
    }
  } catch { /* never break Claude over a log line */ }
  process.exit(0);
});
