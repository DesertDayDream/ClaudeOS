// How good each run's work was. When a run an employee worked on finishes, Claude Haiku grades the
// result against the task (1-5, with a one-line reason); the user's thumbs up or down replaces that grade.
// Grades live in <data>/grades.json, keyed by the task key the page uses (`${session}:${task ts}`).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const SETTLE_MS = 60 * 1000;            // the chat's own error/stop note can follow the hook's stop by up to a minute
const MAX_AGE_MS = 14 * 24 * 3600 * 1000; // never grade old history in bulk
const KEEP = 2000;                      // grades kept on disk
const TIMEOUT_MS = 90 * 1000;

// Finished runs in the activity log that an employee (skill) worked on: [{ key, prompt, result, files, tools, outcome, end }]
export function finishedRuns(activity) {
  const open = new Map(), latest = new Map(), runs = [];
  for (const ev of activity) {
    let t = open.get(ev.session);
    if (ev.type === 'stop' && !t) {
      const prev = latest.get(ev.session);
      if (prev && ev.outcome && ev.outcome !== 'done' && ev.ts - prev.end < SETTLE_MS) prev.outcome = ev.outcome;
      continue;
    }
    if (ev.type === 'task' || !t) {
      t = { key: `${ev.session}:${ev.ts}`, prompt: ev.type === 'task' ? ev.prompt || '' : '', skills: 0, end: 0, outcome: '' };
      open.set(ev.session, t); latest.set(ev.session, t); runs.push(t);
    }
    if (ev.type === 'skill') t.skills++;
    if (ev.type === 'stop') {
      Object.assign(t, { end: ev.ts, outcome: ev.outcome || 'done', result: ev.result || '', files: ev.files || [], tools: ev.tools || 0 });
      open.delete(ev.session);
    }
  }
  return runs.filter(t => t.end && t.skills);
}

export function gradePrompt(run) {
  return [
    'You are reviewing the work an AI assistant did for a user. Grade the QUALITY of the work, not just whether it finished.',
    'You only see the request, the final reply and the files it changed, so judge whether the reply fully and correctly answers the request,',
    'is specific rather than vague, and reports real results (vs. excuses, partial work, or asking for things it could have done).',
    '',
    `REQUEST: ${run.prompt || '(not recorded)'}`,
    `FINAL REPLY: ${run.result || '(empty)'}`,
    `FILES CHANGED: ${(run.files || []).slice(0, 15).join(', ') || 'none'}`,
    `TOOL CALLS: ${run.tools || 0}`,
    '',
    'Scale: 1 = wrong or useless, 2 = poor, 3 = acceptable, 4 = good, 5 = excellent.',
    'Answer with JSON only, no other text: {"grade": <1-5>, "why": "<one short sentence>"}',
  ].join('\n');
}

export function parseGrade(text) {
  const m = String(text || '').match(/\{[\s\S]*?\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    const g = Math.round(Number(j.grade));
    return g >= 1 && g <= 5 ? { grade: g, why: String(j.why || '').slice(0, 200) } : null;
  } catch { return null; }
}

// Ask Claude Haiku for a grade: no tools, no MCP servers, no hooks, run outside any brain so it never
// shows up as activity itself.
function askHaiku(prompt) {
  return new Promise(resolve => {
    const args = ['-p', '--model', 'haiku', '--output-format', 'json', '--tools', '', '--strict-mcp-config',
      '--setting-sources', '', '--no-session-persistence'];
    let proc;
    try {
      proc = spawn('claude', args, { cwd: os.tmpdir(), windowsHide: true, env: { ...process.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' } });
    } catch { return resolve(null); }
    let out = '';
    const timer = setTimeout(() => { try { proc.kill(); } catch { /* gone */ } }, TIMEOUT_MS);
    proc.stdout.on('data', d => { out += d; });
    proc.stderr.on('data', () => {});
    proc.on('error', () => { clearTimeout(timer); resolve(null); });
    proc.on('close', () => {
      clearTimeout(timer);
      try {
        const r = JSON.parse(out.trim().split('\n').pop());
        resolve(r.is_error ? null : parseGrade(r.result));
      } catch { resolve(null); }
    });
    proc.stdin.end(prompt);
  });
}

export function createGrades({ file, ask = askHaiku, onChange = () => {} }) {
  let grades = {};
  try { grades = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* none yet */ }
  const failed = new Set(); // tried this session and couldn't grade: don't loop on it
  let busy = false;
  function save() {
    const keys = Object.keys(grades);
    if (keys.length > KEEP) for (const k of keys.sort((a, b) => (grades[a].at || 0) - (grades[b].at || 0)).slice(0, keys.length - KEEP)) delete grades[k];
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(grades)); } catch { /* kept in memory */ }
    onChange();
  }
  return {
    // grades for these task keys only (what the page shows)
    for(keys) { const out = {}; for (const k of keys) if (grades[k]) out[k] = grades[k]; return out; },
    // the user's own verdict: 'up', 'down', or '' to clear it
    vote(key, vote) {
      key = String(key || '');
      if (!/^[^:]+:\d+$/.test(key)) return { error: 'Unknown run.' };
      if (!['up', 'down', ''].includes(vote)) return { error: 'Vote up or down.' };
      grades[key] = { ...grades[key], user: vote || undefined, at: grades[key]?.at || Date.now() };
      save();
      return { ok: true };
    },
    // grade the next finished run that has no grade yet (one at a time, newest first)
    async tick(activity) {
      if (busy) return;
      const now = Date.now();
      const run = finishedRuns(activity).reverse().find(r => r.outcome === 'done' && now - r.end > SETTLE_MS && now - r.end < MAX_AGE_MS
        && grades[r.key]?.ai == null && !failed.has(r.key));
      if (!run) return;
      busy = true;
      try {
        const g = await ask(gradePrompt(run));
        if (!g) { failed.add(run.key); return; }
        grades[run.key] = { ...grades[run.key], ai: g.grade, why: g.why, at: Date.now() };
        save();
      } finally { busy = false; }
    },
  };
}
