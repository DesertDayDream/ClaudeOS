// The Manager's team desk: one shared inbox per brain, and the briefs it hands out. The Manager is the
// chat: talking in the Chat tab is talking to the Manager. Requests you Queue in the chat (with their
// attachments), and files dropped into the brain's inbox/ folder, wait until "Send to team" hands them to the chat; the
// Manager (or any chat message that is work for the team) splits the work into tasks through the
// post_brief tool. Tasks run sequentially through the originating warm chat.
// Each completed turn is persisted before the next employee starts.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { workFolder, logFile } from './cabinets.mjs';
import { MODEL_GUIDANCE, cleanSelection } from './model-routing.mjs';
import { runModelTask } from './model-runner.mjs';
import { LONG_TOOL_TIMEOUT_MS } from './tool-timeouts.mjs';
import { checkTask, fixPrompt } from './task-check.mjs';

const MAX_PARALLEL = 1;
const MAX_TASKS = 12;
const MAX_BRIEFS = 30;
const clip = (s, n) => (s = String(s || '').trim()).length > n ? s.slice(0, n - 1) + '…' : s;

export function createManager({ cwd, dataFile, activityFile, memoryFile, helper, memoryServer, port, token, broadcast, team, project = () => null, logWork = () => {}, cabinet = () => null, chatBusy = () => false, onBriefDone = () => {}, scope = () => ({ disallowed: [], settings: null }), optionsFor = () => ({}), onApproval, taskRunner = runModelTask, inlineRunner, taskCatalog, checker = checkTask }) {
  let state = { inbox: [], briefs: [] };
  try { state = { ...state, ...JSON.parse(fs.readFileSync(dataFile, 'utf8')) }; } catch { /* first run */ }
  // runs from before a restart are gone
  for (const x of state.inbox) if (x.status === 'sent') x.status = 'new';
  for (const b of state.briefs) {
    if (b.status === 'briefing' || b.status === 'working') b.status = 'stopped';
    for (const t of b.tasks || []) if (t.status === 'working' || t.status === 'waiting') t.status = 'stopped';
  }

  const procs = new Map(); // brief id + task id -> { proc, session, stopped }
  const logs = new Map();  // brief id + task id -> { employee, entries } since this start

  // an employee's brief tasks, newest first, with their live logs (the page's view of their computer)
  function workOf(skill) {
    const out = [];
    for (const b of [...state.briefs].reverse()) for (const t of b.tasks) {
      if (t.employee !== skill) continue;
      out.push({ key: `${b.id}:${t.id}`, brief: b.title, task: t.task, status: t.status, result: t.result, start: t.start, end: t.end,
        folder: t.folder || null, logFile: t.logFile || null, model: t.model || null, project: t.projectName || null, log: logs.get(`${b.id}:${t.id}`)?.entries || null });
      if (out.length >= 15) return out;
    }
    return out;
  }

  function save() {
    state.briefs = state.briefs.slice(-MAX_BRIEFS);
    try { fs.mkdirSync(path.dirname(dataFile), { recursive: true }); fs.writeFileSync(dataFile, JSON.stringify(state)); } catch { /* keep going */ }
  }
  function changed() { save(); broadcast('manager', snapshot()); }
  const working = () => state.briefs.filter(b => b.status === 'working');
  const busy = () => working().length > 0;

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
    return { inbox: state.inbox, files: inboxFiles(), briefs: state.briefs.slice(-10), busy: busy(), chatting: chatBusy(), max: MAX_PARALLEL };
  }

  // files: chat attachments queued with the request, as paths relative to the brain
  function add(text, files = []) {
    text = String(text || '').trim();
    files = (Array.isArray(files) ? files : []).map(String).filter(Boolean).slice(0, 20);
    if (!text && !files.length) return { error: 'Write what you need first.' };
    const item = { id: crypto.randomBytes(4).toString('hex'), text: clip(text || 'See the attached files.', 4000), ts: Date.now(), status: 'new', ...(files.length ? { files } : {}) };
    state.inbox.push(item);
    changed();
    return { ok: true, id: item.id };
  }
  function remove(id) {
    const i = state.inbox.findIndex(x => x.id === id);
    if (i < 0) return { error: 'That request is gone.' };
    if (state.inbox[i].status === 'briefed' && busy()) return { error: 'The team is working on it. Stop the brief first.' };
    if (state.inbox[i].status === 'sent') return { error: 'The Manager is reading it in the Chat tab right now.' };
    state.inbox.splice(i, 1);
    changed();
    return { ok: true };
  }
  // Saves a file dropped into the brain's inbox/ folder, never over an existing one.
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

  // ---------- the Manager (the chat) writes the brief ----------
  // "Brief & assign": the message the chat gets, the short line the chat shows, and the requests it covers
  function handOver() {
    const items = state.inbox.filter(x => x.status === 'new');
    const files = inboxFiles();
    if (!items.length && !files.length) return { error: 'Nothing is queued. Type a request and press Queue first.' };
    if (!team().length) return { error: 'This brain has no employees yet. Hire one in the Team tab first.' };
    const req = items.length ? items.map(x => `- [${x.id}] ${x.text}${x.files?.length ? `\n  Attached: ${x.files.map(f => path.join(cwd, f)).join(', ')}` : ''}`).join('\n') : '(none typed; see the files)';
    const fileList = files.length ? files.map(f => `- ${f.path} (${f.size > 1e6 ? (f.size / 1e6).toFixed(1) + ' MB' : Math.ceil(f.size / 1024) + ' KB'})`).join('\n') : '(empty)';
    const text = `Brief the team on the queued requests.

Requests (put their ids in each task's "request"):
${req}

Files waiting in inbox/:
${fileList}

Files in inbox/ with no typed request are work too when an employee's skill says it takes them (a raw clip for an editor). Brief it all with mcp__claudeos__post_brief, then tell me in a few lines who does what.`;
    const n = (k, w) => `${k} ${w}${k === 1 ? '' : 's'}`;
    const label = `Send to team: ${[items.length && n(items.length, 'queued request'), files.length && n(files.length, 'file from inbox/')].filter(Boolean).join(' and ')}`;
    return { text, label, ids: items.map(x => x.id) };
  }
  function markSent(ids, chat) { for (const x of state.inbox) if (ids.includes(x.id) && x.status === 'new') { x.status = 'sent'; x.chat = chat; } changed(); }
  // a chat's answer ended: requests it was handed but didn't brief are waiting again
  function chatDone(chat) {
    let n = 0;
    for (const x of state.inbox) if (x.status === 'sent' && x.chat === chat) { x.status = 'new'; n++; }
    if (n) changed(); else broadcast('manager', snapshot());
  }

  function reopen(brief) { for (const id of brief.items) { const it = state.inbox.find(x => x.id === id); if (it && it.status === 'briefed') it.status = 'new'; } }

  // Called (long-poll) through approval-mcp.mjs when the chat calls post_brief.
  function postBrief(args) {
    const crew = team(), skills = new Set(crew.map(c => c.skill));
    if (!crew.length) return { error: 'This brain has no employees yet. The user can hire one in the Team tab.' };
    const tasks = Array.isArray(args?.tasks) ? args.tasks : [];
    if (!tasks.length) return { error: 'The brief has no tasks. Give at least one, or don\'t brief: answer the user yourself.' };
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
      const chosen = cleanSelection(t.selection);
      if (chosen.error) problems.push(`Task ${id}: ${chosen.error}`);
      const caller = optionsFor(String(args.chat || ''));
      const engine = caller.engine || 'claude';
      const pick = chosen.selection;
      if (pick && ((pick.requiredEngine && pick.requiredEngine !== engine) ||
          (pick.engine !== 'auto' && pick.engine !== engine) ||
          (pick.model && pick.model !== (engine === 'codex' ? caller.codexModel : caller.model)))) {
        problems.push(`Task ${id}: briefs inherit the warm chat model. Use an explicitly authorized specialist task for a different model.`);
      }
      const proj = t.project ? project(String(t.project)) : null;
      if (t.project && (!proj || proj.p.status !== 'active')) problems.push(`Task ${id}: "${t.project}" isn't an active project id. Leave "project" out, or use one from the project list.`);
      return { id, employee: String(t.employee), name: crew.find(c => c.skill === t.employee)?.name || String(t.employee), task: clip(t.task, 6000), after, request: (Array.isArray(t.request) ? t.request : []).map(String),
        ...(proj ? { project: proj.p.id, projectName: proj.p.name } : {}),
        selection: chosen.selection, status: 'waiting', result: '', start: 0, end: 0, usage: null, session: null };
    });
    if (problems.length) return { error: problems.join('\n') };
    const skipped = (Array.isArray(args.skipped) ? args.skipped : []).map(s => ({ request: String(s.request || ''), reason: clip(s.reason, 400) }));
    const asked = new Set([...clean.flatMap(t => t.request), ...skipped.map(s => s.request)]);
    const items = state.inbox.filter(x => asked.has(x.id) && (x.status === 'new' || x.status === 'sent'));
    // chat: the chat that briefed it, which gets the team's reports
    const brief = { id: crypto.randomBytes(4).toString('hex'), ts: Date.now(), status: 'working', chat: String(args.chat || ''), items: items.map(x => x.id),
      title: clip(args.title || 'Brief', 120), summary: clip(args.summary, 1500), notes: clip(args.notes, 1500), skipped, tasks: clean, error: '' };
    state.briefs.push(brief);
    // a request the Manager only set aside goes back to waiting
    for (const x of items) x.status = clean.some(t => t.request.includes(x.id)) ? 'briefed' : 'new';
    tickAll();
    return { ok: true, text: `Brief accepted: ${clean.length} task${clean.length === 1 ? '' : 's'}. ClaudeOS queues them sequentially in this chat and reports back in this chat when the team is done; don't wait or check on it.` };
  }

  // ---------- the employees work it ----------
  // starts what can start, in every brief at work, up to MAX_PARALLEL employees at once
  function tickAll() {
    for (const b of working()) tick(b);
    changed();
  }
  function tick(brief) {
    const by = new Map(brief.tasks.map(t => [t.id, t]));
    for (const t of brief.tasks) {
      if (t.status !== 'waiting') continue;
      const deps = t.after.map(id => by.get(id));
      if (deps.some(d => d.status === 'error' || d.status === 'skipped' || d.status === 'stopped')) { t.status = 'skipped'; t.result = 'Skipped: a task it waited for didn\'t finish.'; }
    }
    let running = working().reduce((n, b) => n + b.tasks.filter(t => t.status === 'working').length, 0);
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
      onBriefDone(brief, report(brief));
    }
  }
  // what the Manager hears back in the chat when a brief is finished
  function report(b) {
    const lines = b.tasks.map(t => `- ${t.name} (${t.employee}), task ${t.id}: ${t.status === 'done' ? 'done' : t.status}\n${String(t.result).replace(/^/gm, '  ')}`);
    return `The team finished the brief "${b.title}". Their reports:\n${lines.join('\n')}\n\nTell me in a few lines what was done and where the output is, and what (if anything) needs my decision.`;
  }

  function startTask(brief, t, deps) {
    const crew = team(), me = crew.find(c => c.skill === t.employee) || { name: t.employee, skill: t.employee };
    const earlier = deps.length ? `\n\nWhat the employees before you reported:\n${deps.map(d => {
      const who = crew.find(c => c.skill === d.employee);
      return `- ${who?.name || d.employee} (${d.employee}): ${clip(d.result, 1500)}`;
    }).join('\n')}` : '';
    // the project's goal and what colleagues reported on it lately; the department's other people
    const proj = t.project ? project(t.project) : null;
    const projText = proj ? `\n\nThis is work on the project "${proj.p.name}" (${proj.d.name} department).${proj.p.goal ? ` Goal: ${proj.p.goal}` : ''}${proj.p.folder ? `\nThe project's files are in ${proj.p.folder}.` : ''}${proj.p.log.length ? `\nWhat colleagues reported on it lately:\n${proj.p.log.slice(-5).map(l => `- ${l.name} (${l.employee}), ${new Date(l.ts).toISOString().slice(0, 10)}: ${l.task} -> ${l.status}. ${clip(l.result, 400)}`).join('\n')}` : ''}` : '';
    const mates = me.dept ? crew.filter(c => c.dept?.id === me.dept.id && c.skill !== me.skill) : [];
    const deptText = me.dept ? ` You work in the ${me.dept.name} department${mates.length ? ` with ${mates.map(c => `${c.name} (${c.skill})`).join(', ')}` : ''}.` : '';
    // their file cabinet: a folder of its own for this task, and the run's log beside it
    const title = t.task.split('\n')[0];
    let cab = null;
    try {
      cab = cabinet(t.employee);
      if (cab) { t.folder = workFolder(cab, proj ? proj.p.name : 'General', title); t.logFile = logFile(cab, title); }
    } catch { cab = null; /* no cabinet: they work as before */ }
    const cabText = t.folder ? `\nYour file cabinet is ${cab}. Save everything you make for this task in ${t.folder} (add subfolders there if it helps, and give files clear names). Write somewhere else only when the task names that exact place.` : '';
    // the task comes first: the first line is what the boards and the speech bubble show
    const skillFile = path.join(cwd, '.claude', 'skills', me.skill, 'SKILL.md');
    const prompt = `${t.task}${earlier}${projText}

---
You are ${me.name}, the ${me.skill} employee on this brain's team, working on the Manager's brief "${brief.title}".${deptText} Read the current ${skillFile} from disk, including its Dynamic Performance Review Corrections & Constraints, even if this skill was already loaded in this warm conversation. If your engine exposes the Skill tool, invoke ${me.skill}; otherwise read and follow ${skillFile}, including its referenced role playbooks, then do only this task. Do not call post_brief, run_model_task, or start_session from this Skill Sphere turn; load colleague skills inline if needed. Follow this folder's AGENTS.md and CLAUDE.md. Employees execute sequentially in this same conversation. Retain the preceding work and only touch the files your task names or creates.${cabText} End with a short report: what you did and where the output is.
${MODEL_GUIDANCE}`;
    t.status = 'working';
    t.start = Date.now();
    const key = brief.id + ':' + t.id;
    const log = { employee: t.employee, entries: [] };
    logs.set(key, log);
    const note = entry => {
      log.entries.push(entry);
      if (log.entries.length > 300) log.entries.shift();
      broadcast('tasklog', { key, employee: t.employee, entry });
      if (t.logFile) try { fs.appendFileSync(t.logFile, `- ${new Date(entry.ts).toLocaleTimeString()} ${entry.kind === 'tool' ? '**' + entry.text + '**' : entry.kind === 'error' ? '! ' + entry.text : entry.text.replace(/\n/g, ' ')}\n`); } catch { /* the page still has it */ }
    };
    if (t.logFile) try { fs.writeFileSync(t.logFile, `# ${title}\n\n${me.name} (${me.skill}) · brief "${brief.title}"${proj ? ` · project ${proj.p.name}` : ''} · ${new Date().toLocaleString()}\nFolder: ${t.folder}\n\n## Task\n\n${t.task}\n\n## Log\n\n`); } catch { /* fine */ }
    const session = brief.chat;
    const reviewSession = `brief-${brief.id}-${t.id}`;
    activity({ session: reviewSession, type: 'task', prompt: t.task });
    activity({ session: reviewSession, type: 'skill', skill: t.employee });
    const caller = optionsFor(brief.chat);
    const activeFile = path.join(cwd, '.claude', 'active_brief.json');
    const payload = { version: 2, execution: { caller, cwd, key }, employee: { ...me }, chatId: brief.chat, brief: { ...brief },
      task: { ...t }, dependencies: deps.map(d => ({ ...d })),
      skill: { id: me.skill, name: me.name, file: skillFile, department: me.dept || null }, instructions: prompt };
    let dispatchError;
    try {
      fs.mkdirSync(path.dirname(activeFile), { recursive: true });
      const pending = activeFile + '.tmp';
      fs.writeFileSync(pending, JSON.stringify(payload, null, 2));
      fs.renameSync(pending, activeFile);
    } catch (err) { dispatchError = `Could not write active brief: ${err.message}`; }
    const directive = "SYSTEM_DIRECTIVE: Headless Execution Mode Active. Read the JSON matrix at .claude/active_brief.json, execute the specified skill sphere task, write outputs directly to the designated Office cabinets, and terminate the current run sequence with an explicit [TASK_COMPLETE] token.";
    let run;
    try { run = !dispatchError && inlineRunner
      ? inlineRunner({ chat: brief.chat, skillId: me.skill, headless: true, matrixFile: activeFile, prompt: directive, onLog: note })
      : { done: Promise.resolve({ error: dispatchError || 'The warm chat runner is unavailable.' }), stop() {} };
    } catch (err) { run = { done: Promise.resolve({ error: err.message }), stop() {} }; }
    procs.set(key, run);
    t.session = session;
    const settle = p => Promise.resolve(p).catch(err => ({ error: err.message || String(err) }));
    settle(run.done).then(async r => {
      // checked before it counts: a reviewer with a clean context, and one fix turn if it finds problems
      if (!r.stopped && !r.error && checker) {
        t.phase = 'checking'; changed();
        let check = await settle(checker({ task: t.task, report: r.result, folder: t.folder, projectFolder: proj?.p.folder, since: t.start }));
        if (check && !check.skipped && !check.pass && check.issues?.length && inlineRunner && brief.status !== 'stopped') {
          note({ ts: Date.now(), kind: 'error', text: 'Reviewer found: ' + check.issues.join(' | ') });
          t.phase = 'fixing'; changed();
          const fix = inlineRunner({ chat: brief.chat, skillId: me.skill, headless: true, prompt: `${fixPrompt(check.issues)}\nEnd with [TASK_COMPLETE].`, onLog: note });
          procs.set(key, fix);
          const fixed = await settle(fix.done);
          if (fixed.stopped || fixed.error) r = { ...fixed, usage: r.usage };
          else {
            const again = await settle(checker({ task: t.task, report: fixed.result, folder: t.folder, projectFolder: proj?.p.folder, since: t.start }));
            r = { ...r, result: fixed.result };
            check = { ...again, fixed: true, first: check.issues };
          }
        }
        t.check = check && !check.error ? check : { skipped: true, issues: [] };
        delete t.phase;
        if (t.logFile && !t.check.skipped) {
          const lines = [...(t.check.first || []).map(i => '- first: ' + i), ...(t.check.issues.length ? t.check.issues.map(i => '- ' + i) : ['No problems found.'])];
          try { fs.appendFileSync(t.logFile, `\n## Review (${t.check.pass ? 'passed' : 'problems remain'}${t.check.fixed ? ' after one fix' : ''})\n\n${lines.join('\n')}\n`); } catch { /* fine */ }
        }
      }
      procs.delete(key);
      t.end = Date.now();
      t.usage = r.usage || null;
      t.model = r.model || caller;
      t.session = r.session || session;
      if (r.stopped) { t.status = 'stopped'; t.result = 'Stopped.'; }
      else if (r.error) { t.status = 'error'; t.result = clip(r.error, 2000); }
      else { t.status = 'done'; t.result = clip(r.result, 4000); }
      activity({ session: reviewSession, type: 'stop', outcome: t.status, result: r.result || t.result });
      note({ ts: Date.now(), kind: t.status === 'done' ? 'done' : 'error', text: t.status === 'done' ? 'Finished.' : t.result });
      if (t.logFile) try { fs.appendFileSync(t.logFile, `\n## Report (${t.status})\n\n${r.result || t.result}\n`); } catch { /* fine */ }
      if (proj && !r.stopped) logWork(proj.p.id, { employee: t.employee, name: t.name, task: t.task.split('\n')[0], status: t.status, result: t.result });
      tickAll();
    });
  }

  function stop() {
    for (const brief of working()) {
      brief.status = 'stopped';
      for (const t of brief.tasks) if (t.status === 'waiting') { t.status = 'stopped'; t.result = 'Stopped before it started.'; }
      reopen(brief);
    }
    for (const run of procs.values()) {
      run.stop();
    }
    changed();
    return { ok: true };
  }

  function taskServers({ who, chat, nested, caller, selection }) {
    let project = {};
    try {
      const file = path.join(cwd, '.mcp.json');
      if (fs.existsSync(file)) project = JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers || {};
    } catch { throw new Error('This brain’s .mcp.json could not be read. Fix it before delegating model tasks.'); }
    return { ...project, memory: memoryServer(memoryFile), claudeos: { ...helper('approval-mcp'), timeout: LONG_TOOL_TIMEOUT_MS, env: {
      CLAUDEOS_PORT: String(port), CLAUDEOS_TOKEN: token, CLAUDEOS_WHO: who, CLAUDEOS_CHAT: chat || '',
      ...(nested ? { CLAUDEOS_MODEL_TASK: '1', CLAUDEOS_MODEL_CALLER: JSON.stringify(caller || {}), CLAUDEOS_MODEL_SELECTION: JSON.stringify(selection || {}) } : {}) } } };
  }

  function activity(event) {
    try { fs.appendFileSync(activityFile, JSON.stringify({ ts: Date.now(), cwd, ...event }) + '\n'); } catch { /* task report is still saved */ }
  }

  function launchTask(options, info) {
    try { return taskRunner({ ...options, mcpServers: taskServers(info) }); }
    catch (e) { return { done: Promise.resolve({ error: e.message }), stop() {} }; }
  }

  async function specialist({ task, selection, chat, caller, requiredEngine, requiredModel, allowFallback = true, workDir, fromBrief = false }) {
    const checked = cleanSelection(selection);
    if (checked.error) return checked;
    if (!String(task || '').trim() || String(task).length > 20000) return { error: 'Give a specialist task of 1–20000 characters.' };
    if (requiredEngine && checked.selection.requiredEngine && checked.selection.requiredEngine !== requiredEngine) return { error: 'Specialist selection conflicts with the parent task provider requirement.' };
    if (requiredModel && checked.selection.model && checked.selection.model !== requiredModel) return { error: 'Specialist selection conflicts with the parent task exact-model requirement.' };
    const chosen = { ...checked.selection, ...(requiredEngine ? { requiredEngine } : {}), ...(requiredModel ? { model: requiredModel } : {}), ...(!allowFallback ? { fallback: false } : {}) };
    if (procs.size >= MAX_PARALLEL + 2) return { error: 'Specialist capacity is full. Continue locally or wait for existing work.' };
    const key = `specialist-${crypto.randomUUID()}`;
    const who = 'Model specialist';
    const log = [];
    const run = launchTask({ prompt: `${task}\n\nFollow ${cwd}/AGENTS.md and CLAUDE.md if present. You are a bounded specialist. Verify your output; report files/actions completed and uncertainties. Do not launch other model processes or delegate.`,
      selection: chosen, caller: caller || optionsFor(chat), cwd: workDir || cwd, addDirs: workDir && workDir !== cwd ? [cwd] : [], scope: scope(),
      ...(taskCatalog ? { catalog: taskCatalog } : {}),
      onApproval: request => onApproval?.(chat, request, who) || Promise.resolve('decline'),
      onLog: e => { log.push(e.text); broadcast('tasklog', { key, employee: who, entry: e }); } }, { who, chat, nested: false });
    procs.set(key, run);
    run.parentChat = chat;
    run.fromBrief = fromBrief;
    try { const r = await run.done; return r.error || r.stopped ? { error: r.error || 'Specialist stopped.' }
      : { text: `${log.filter(s => s.startsWith('Model:') || s.startsWith('Usage limit')).join('\n')}\n\n${String(r.result || '').slice(0, 20000)}` }; }
    finally { procs.delete(key); }
  }

  const stopChatSpecialists = chat => { for (const [key, run] of procs) if (key.startsWith('specialist-') && run.parentChat === chat && !run.fromBrief) run.stop(); };
  return { snapshot, add, remove, upload, handOver, markSent, chatDone, stop, stopChatSpecialists, postBrief, specialist, busy: () => busy() || procs.size > 0, workOf };
}
