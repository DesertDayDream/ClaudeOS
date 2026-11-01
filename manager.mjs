// The Manager: one shared inbox per brain. You leave requests there (typed in the Inbox tab, or files
// dropped into the brain's inbox/ folder). "Brief & assign" runs the Manager once, headless in the brain
// folder: it reads everything waiting, writes one brief and splits it into tasks for the employees
// (skills) through the post_brief tool. Then each task runs as its own `claude -p` in the brain folder,
// so employees work at the same time (MAX_PARALLEL at most), and a task that needs another's output
// waits for it and gets its report.
import { spawn, execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const MAX_PARALLEL = 3;
const MAX_TASKS = 12;
const MAX_BRIEFS = 30;
const MANAGER_DENIED = ['Skill', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash', 'Task', 'Agent', 'WebFetch', 'WebSearch'];
const clip = (s, n) => (s = String(s || '').trim()).length > n ? s.slice(0, n - 1) + '…' : s;

export function createManager({ cwd, dataFile, activityFile, memoryFile, helper, memoryServer, port, token, broadcast, team }) {
  let state = { inbox: [], briefs: [] };
  try { state = { ...state, ...JSON.parse(fs.readFileSync(dataFile, 'utf8')) }; } catch { /* first run */ }
  // runs from before a restart are gone
  for (const b of state.briefs) {
    if (b.status === 'briefing' || b.status === 'working') b.status = 'stopped';
    for (const t of b.tasks || []) if (t.status === 'working' || t.status === 'waiting') t.status = 'stopped';
  }

  const procs = new Map(); // task id (or 'manager') -> { proc, session, stopped }
  let pendingBrief = null; // what post_brief handed us during the Manager's run

  function save() {
    state.briefs = state.briefs.slice(-MAX_BRIEFS);
    try { fs.mkdirSync(path.dirname(dataFile), { recursive: true }); fs.writeFileSync(dataFile, JSON.stringify(state)); } catch { /* keep going */ }
  }
  function changed() { save(); broadcast('manager', snapshot()); }
  const current = () => state.briefs.find(b => b.status === 'briefing' || b.status === 'working');
  const busy = () => !!current();

  function inboxFiles() {
    const dir = path.join(cwd, 'inbox'), out = [];
    const walk = (d, rel, depth) => {
      let names = [];
      try { names = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of names) {
        if (out.length >= 60 || e.name.startsWith('.')) continue;
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) { if (depth < 2) walk(path.join(d, e.name), r, depth + 1); continue; }
        let size = 0;
        try { size = fs.statSync(path.join(d, e.name)).size; } catch { /* gone */ }
        out.push({ path: `inbox/${r}`, size });
      }
    };
    walk(dir, '', 0);
    return out;
  }

  function snapshot() {
    return { inbox: state.inbox, files: inboxFiles(), briefs: state.briefs.slice(-10), busy: busy(), max: MAX_PARALLEL };
  }

  function add(text) {
    text = String(text || '').trim();
    if (!text) return { error: 'Write what you need first.' };
    const item = { id: crypto.randomBytes(4).toString('hex'), text: clip(text, 4000), ts: Date.now(), status: 'new' };
    state.inbox.push(item);
    changed();
    return { ok: true, id: item.id };
  }
  function remove(id) {
    const i = state.inbox.findIndex(x => x.id === id);
    if (i < 0) return { error: 'That request is gone.' };
    if (state.inbox[i].status === 'briefed' && busy()) return { error: 'The team is working on it. Stop the brief first.' };
    state.inbox.splice(i, 1);
    changed();
    return { ok: true };
  }
  // Saves a file dropped on the Inbox tab into the brain's inbox/ folder, never over an existing one.
  function upload(req, rawName) {
    const name = path.basename(String(rawName || '')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 120);
    if (!name || /^\.+$/.test(name)) return Promise.resolve({ error: 'That file needs a name.' });
    const dir = path.join(cwd, 'inbox');
    fs.mkdirSync(dir, { recursive: true });
    const ext = path.extname(name), base = name.slice(0, name.length - ext.length);
    let file = path.join(dir, name);
    for (let n = 2; fs.existsSync(file); n++) file = path.join(dir, `${base} (${n})${ext}`);
    return new Promise(resolve => {
      const out = fs.createWriteStream(file, { flags: 'wx' });
      req.pipe(out);
      out.on('finish', () => { changed(); resolve({ ok: true, path: `inbox/${path.basename(file)}` }); });
      out.on('error', err => resolve({ error: err.message }));
      req.on('aborted', () => { out.destroy(); fs.rmSync(file, { force: true }); resolve({ error: 'The upload stopped.' }); });
    });
  }

  // ---------- one headless Claude run in the brain folder ----------
  function runClaude(key, prompt, { who, allowed, denied = [], extraEnv = {} }, onDone) {
    const session = crypto.randomUUID();
    const mcpServers = {
      memory: memoryServer(memoryFile),
      claudeos: { ...helper('approval-mcp'), env: { CLAUDEOS_PORT: String(port), CLAUDEOS_TOKEN: token, CLAUDEOS_WHO: who, ...extraEnv } },
    };
    const args = ['-p', prompt, '--output-format', 'json', '--session-id', session,
      '--mcp-config', JSON.stringify({ mcpServers }), '--permission-prompt-tool', 'mcp__claudeos__approve',
      '--allowedTools', allowed.join(','), ...(denied.length ? ['--disallowedTools', denied.join(',')] : [])];
    const proc = spawn('claude', args, { cwd, windowsHide: true,
      env: { ...process.env, MCP_TOOL_TIMEOUT: String(24 * 3600 * 1000), CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' } });
    const run = { proc, session, stopped: false };
    procs.set(key, run);
    let out = '', err = '';
    proc.stdout.on('data', d => { out += d; });
    proc.stderr.on('data', d => { err += d; });
    let ended = false;
    const end = r => {
      if (ended) return;
      ended = true;
      procs.delete(key);
      // a killed or failed run never reaches Claude's Stop hook, so close its task on the boards here
      if (run.stopped || r.error) logStop(session, run.stopped ? 'stopped' : 'error', run.stopped ? 'Stopped from the Inbox.' : r.error);
      onDone(run.stopped ? { stopped: true } : r);
    };
    proc.on('error', e => end({ error: `Could not start Claude Code: ${e.message}` }));
    proc.on('close', code => {
      try {
        const r = JSON.parse(out.trim().split('\n').pop());
        const usage = { cost: r.total_cost_usd ?? null, turns: r.num_turns || 0,
          sent: ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'].reduce((a, k) => a + (Number(r.usage?.[k]) || 0), 0),
          output: Number(r.usage?.output_tokens) || 0 };
        end(r.is_error ? { error: String(r.result || 'Claude failed.'), usage } : { result: String(r.result || ''), usage });
      } catch { end({ error: err.trim().split('\n').pop() || `Claude exited with code ${code}` }); }
    });
    return run;
  }
  function logStop(session, outcome, result) {
    const ev = { ts: Date.now(), session, cwd, type: 'stop', outcome, result: clip(result, 600) };
    try { fs.appendFileSync(activityFile, JSON.stringify(ev) + '\n'); } catch { /* the board shows it as unfinished */ }
  }

  // ---------- the Manager writes the brief ----------
  function start() {
    if (busy()) return { error: 'The team is still on the last brief. Wait for it, or press Stop.' };
    const items = state.inbox.filter(x => x.status === 'new');
    const files = inboxFiles();
    if (!items.length && !files.length) return { error: 'The inbox is empty. Add a request or drop a file first.' };
    const crew = team();
    if (!crew.length) return { error: 'This brain has no employees yet. Hire one in the Team tab first.' };
    const brief = { id: crypto.randomBytes(4).toString('hex'), ts: Date.now(), status: 'briefing', items: items.map(x => x.id),
      title: '', summary: '', notes: '', skipped: [], tasks: [], managerResult: '', error: '' };
    state.briefs.push(brief);
    for (const x of items) x.status = 'briefed';
    pendingBrief = null;
    const prompt = managerPrompt(items, files, crew);
    runClaude('manager', prompt, {
      who: 'Manager',
      allowed: ['mcp__memory__search_nodes', 'mcp__memory__open_nodes', 'mcp__memory__read_graph', 'mcp__claudeos__post_brief', 'Read', 'Glob', 'Grep', 'LS'],
      denied: MANAGER_DENIED,
      extraEnv: { CLAUDEOS_TEAM: JSON.stringify(crew.map(c => c.skill)) },
    }, r => {
      brief.managerUsage = r.usage || null;
      brief.managerResult = clip(r.result || '', 2000);
      if (r.stopped) { brief.status = 'stopped'; reopen(brief); return changed(); }
      if (!pendingBrief) {
        brief.status = 'failed';
        brief.error = r.error || 'The Manager finished without writing a brief.';
        reopen(brief);
        return changed();
      }
      Object.assign(brief, pendingBrief, { status: 'working' });
      pendingBrief = null;
      // requests the Manager set aside go back to the inbox
      for (const s of brief.skipped) { const it = state.inbox.find(x => x.id === s.request); if (it) it.status = 'new'; }
      changed();
      tick(brief);
    });
    changed();
    return { ok: true, id: brief.id };
  }
  function reopen(brief) { for (const id of brief.items) { const it = state.inbox.find(x => x.id === id); if (it && it.status === 'briefed') it.status = 'new'; } }

  function managerPrompt(items, files, crew) {
    const req = items.length ? items.map(x => `- [${x.id}] ${x.text}`).join('\n') : '(none typed; see the files)';
    const fileList = files.length ? files.map(f => `- ${f.path} (${f.size > 1e6 ? (f.size / 1e6).toFixed(1) + ' MB' : Math.ceil(f.size / 1024) + ' KB'})`).join('\n') : '(empty)';
    return `Manager: brief ${items.length || 'the'} inbox request${items.length === 1 ? '' : 's'}

You are the Manager of this brain's team. You don't do the work yourself: you read the inbox, write ONE brief that splits the work between the employees, and hand it over by calling mcp__claudeos__post_brief once.

Requests in the inbox:
${req}

Files waiting in inbox/:
${fileList}

The team (employee name, skill: what it does):
${crew.map(c => `- ${c.name}, ${c.skill}: ${clip(c.description, 300)}`).join('\n')}

How to brief:
- Search the brain's memory (mcp__memory__search_nodes) when the work depends on the user's preferences, brand rules or past decisions. Read files if you need to understand a request.
- Each task goes to one employee and must stand on its own: the employee can't see the inbox or this brief. Say the goal, the exact input files, where to save the output, and anything from memory they need.
- Put a task id in "after" only when that task needs the other one's output (the edit before its cover image). Everything else runs at the same time, so never chain tasks that don't depend on each other.
- Fewer, bigger tasks beat many tiny ones: every task is a separate run. Use at most ${MAX_TASKS}.
- Only use employees from the list, by their skill name. If a request (or part of one) fits nobody or is too unclear to act on, put it in "skipped" with the reason instead of guessing.
- Files in inbox/ with no typed request are work too when an employee's skill says it takes them (a raw clip for an editor).

After post_brief accepts the brief, reply with one short line.`;
  }

  // Called (long-poll) through approval-mcp.mjs when the Manager calls post_brief.
  function postBrief(args) {
    const brief = current();
    if (!brief || brief.status !== 'briefing') return { error: 'No brief is being written right now.' };
    const crew = team(), skills = new Set(crew.map(c => c.skill));
    const tasks = Array.isArray(args?.tasks) ? args.tasks : [];
    if (!tasks.length && !(args?.skipped || []).length) return { error: 'The brief has no tasks. Add at least one, or put every request in "skipped" with a reason.' };
    if (tasks.length > MAX_TASKS) return { error: `Use at most ${MAX_TASKS} tasks.` };
    const seen = new Set(), problems = [];
    const clean = tasks.map((t, i) => {
      const id = String(t.id || `t${i + 1}`).trim();
      if (seen.has(id)) problems.push(`Task id ${id} is used twice.`);
      const after = (Array.isArray(t.after) ? t.after : []).map(String);
      for (const a of after) if (!seen.has(a)) problems.push(`Task ${id} waits for "${a}", which isn't an earlier task. List tasks so the ones it waits for come first.`);
      seen.add(id);
      if (!skills.has(t.employee)) problems.push(`Task ${id}: "${t.employee}" isn't on the team. Use one of: ${[...skills].join(', ')}.`);
      if (!String(t.task || '').trim()) problems.push(`Task ${id} says nothing to do.`);
      return { id, employee: String(t.employee), name: crew.find(c => c.skill === t.employee)?.name || String(t.employee), task: clip(t.task, 6000), after, request: (Array.isArray(t.request) ? t.request : []).map(String),
        status: 'waiting', result: '', start: 0, end: 0, usage: null, session: null };
    });
    if (problems.length) return { error: problems.join('\n') };
    pendingBrief = {
      title: clip(args.title || 'Brief', 120), summary: clip(args.summary, 1500), notes: clip(args.notes, 1500),
      skipped: (Array.isArray(args.skipped) ? args.skipped : []).map(s => ({ request: String(s.request || ''), reason: clip(s.reason, 400) })),
      tasks: clean,
    };
    return { ok: true, text: `Brief accepted: ${clean.length} task${clean.length === 1 ? '' : 's'}. ClaudeOS starts them now.` };
  }

  // ---------- the employees work it ----------
  function tick(brief) {
    if (brief.status !== 'working') return changed(); // stopped: just save how its tasks ended
    const by = new Map(brief.tasks.map(t => [t.id, t]));
    for (const t of brief.tasks) {
      if (t.status !== 'waiting') continue;
      const deps = t.after.map(id => by.get(id));
      if (deps.some(d => d.status === 'error' || d.status === 'skipped' || d.status === 'stopped')) { t.status = 'skipped'; t.result = 'Skipped: a task it waited for didn\'t finish.'; }
    }
    let running = brief.tasks.filter(t => t.status === 'working').length;
    for (const t of brief.tasks) {
      if (running >= MAX_PARALLEL) break;
      if (t.status !== 'waiting' || !t.after.every(id => by.get(id).status === 'done')) continue;
      startTask(brief, t, t.after.map(id => by.get(id)));
      running++;
    }
    if (brief.tasks.every(t => !['waiting', 'working'].includes(t.status))) {
      brief.status = brief.tasks.some(t => t.status === 'error') ? 'failed' : 'done';
      brief.end = Date.now();
      for (const id of brief.items) {
        const it = state.inbox.find(x => x.id === id);
        if (it && it.status === 'briefed') it.status = brief.tasks.filter(t => t.request.includes(id)).every(t => t.status === 'done') ? 'done' : 'new';
      }
    }
    changed();
  }

  function startTask(brief, t, deps) {
    const crew = team(), me = crew.find(c => c.skill === t.employee) || { name: t.employee, skill: t.employee };
    const earlier = deps.length ? `\n\nWhat the employees before you reported:\n${deps.map(d => {
      const who = crew.find(c => c.skill === d.employee);
      return `- ${who?.name || d.employee} (${d.employee}): ${clip(d.result, 1500)}`;
    }).join('\n')}` : '';
    // the task comes first: the first line is what the boards and the speech bubble show
    const prompt = `${t.task}${earlier}

---
You are ${me.name}, the ${me.skill} employee on this brain's team, working on the Manager's brief "${brief.title}". Start by using the ${me.skill} skill, then do only this task. Other employees may be working in this folder at the same time, so only touch the files your task names or creates. End with a short report: what you did and where the output is.`;
    t.status = 'working';
    t.start = Date.now();
    const run = runClaude(t.id, prompt, { who: `${me.name} (${me.skill})`, allowed: ['mcp__memory'] }, r => {
      t.end = Date.now();
      t.usage = r.usage || null;
      if (r.stopped) { t.status = 'stopped'; t.result = 'Stopped.'; }
      else if (r.error) { t.status = 'error'; t.result = clip(r.error, 2000); }
      else { t.status = 'done'; t.result = clip(r.result, 4000); }
      tick(brief);
    });
    t.session = run.session;
  }

  function stop() {
    const brief = current();
    if (!brief) return { ok: true };
    brief.status = 'stopped';
    for (const t of brief.tasks) if (t.status === 'waiting') { t.status = 'stopped'; t.result = 'Stopped before it started.'; }
    for (const run of procs.values()) {
      run.stopped = true;
      // end Claude and anything it started
      execFile('taskkill', ['/pid', String(run.proc.pid), '/T', '/F'], () => {});
    }
    reopen(brief);
    changed();
    return { ok: true };
  }

  return { snapshot, add, remove, upload, start, stop, postBrief, busy };
}
