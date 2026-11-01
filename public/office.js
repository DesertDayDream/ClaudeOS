// An employee's desk in the side panel: their chat (the same chat box as the Manager's, showing their own
// conversation: chat.js draws it, app.js asks the server to show it), their file cabinet (the real folder in the brain's Office folder where their work is filed), and their
// computer (what they're doing right now, step by step, and the logs of what they did before).
// app.js owns the selection and calls render(); this module fetches the employee's data and keeps it live.
import { events } from '/events.js';
import { preview } from '/preview.js';

const TOKEN = window.CLAUDEOS_TOKEN;
async function api(path, body) {
  const res = await fetch(path, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', 'x-claudeos-token': TOKEN }, body: body === undefined ? undefined : JSON.stringify(body) });
  return res.json().catch(() => ({ error: `HTTP ${res.status}` }));
}
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function ago(ts) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 86400 ? `${Math.floor(s / 3600)} h ago` : `${Math.floor(s / 86400)} d ago`;
}
const size = n => n > 1e6 ? (n / 1e6).toFixed(1) + ' MB' : n > 1024 ? Math.ceil(n / 1024) + ' KB' : n + ' B';
const STATUS = { working: 'working', waiting: 'waiting', done: 'done', error: 'failed', stopped: 'stopped', skipped: 'skipped' };

export const VIEWS = [['chat', 'Chat'], ['cabinet', 'File cabinet'], ['computer', 'Computer'], ['profile', 'Profile']];
let desk = { id: null, data: null, err: '', open: new Set() };
let rerender = () => {};
export function onChange(fn) { rerender = fn; }

// an employee takes over the whole side panel; this goes back to the Manager's (Chat, Memory, Team…)
export const backBar = () => `<div class="desk-top"><button class="btn mini" data-desk-back title="Back to the Manager's panel (Esc)">← Manager</button></div>`;
export function tabs(view, who) {
  return `${backBar()}<div class="desk-tabs">${VIEWS.map(([v, label]) => `<button class="${v === view ? 'on' : ''}" data-desk-view="${v}">${esc(label)}</button>`).join('')}</div>
    ${who ? `<h3>${who}</h3>` : ''}`;
}

// fetch the employee's desk (again); throttled so a streaming answer refreshes a few times a second
let pending = null;
function load(id, now) {
  if (pending && !now) return;
  pending = setTimeout(async () => {
    pending = null;
    const r = await api(`/api/employee?id=${encodeURIComponent(id)}`);
    if (desk.id !== id) return;
    if (r.error) desk.err = r.error; else { desk.data = r; desk.err = ''; }
    rerender();
  }, now ? 0 : 300);
}
export function select(id) {
  if (desk.id === id) return;
  desk = { id, data: null, err: '', open: new Set() };
  load(id, true);
}
events.addEventListener('chat', e => {
  const ev = JSON.parse(e.data);
  // their chat moved on: the computer's "Chat work" follows
  if (desk.id && ev.chat && ev.chat === desk.data?.chat?.id) load(desk.id);
});
events.addEventListener('tasklog', e => {
  const ev = JSON.parse(e.data);
  const job = desk.data?.work?.find(w => w.key === ev.key);
  if (job) { (job.log ||= []).push(ev.entry); rerender(); }
  else if (desk.id && desk.data?.work) load(desk.id); // a task of theirs that just started
});
events.addEventListener('manager', () => { if (desk.id) load(desk.id); });

// ---------- the cabinet and the computer (the chat is the chat box itself) ----------
// runs: app.js's "Working on" card and recent runs from the activity hook, shown on their computer
export function render(el, s, view, who, runs = '') {
  const key = `${s.id}:${view}`;
  const d = desk.id === s.id ? desk.data : null;
  // the Chat tab is only the desk's header: the chat box sits under it
  if (view === 'chat') { el.innerHTML = tabs(view, who); el.dataset.for = key; return; }
  // keep the scroll position through live updates
  const box = el.querySelector('.desk-body');
  const scroll = box && el.dataset.for === key ? { top: box.scrollTop, bottom: box.scrollHeight - box.scrollTop - box.clientHeight < 30 } : null;
  let body;
  if (!d) body = `<div class="empty">${esc(desk.err || 'Opening their desk…')}</div>`;
  else if (view === 'cabinet') body = cabinetView(d);
  else body = computerView(d, runs);
  el.innerHTML = `${tabs(view, who)}<div class="desk-body">${body}</div>`;
  el.dataset.for = key;
  const nb = el.querySelector('.desk-body');
  if (nb) nb.scrollTop = scroll ? scroll.top : 0;
}
function cabinetView(d) {
  const files = d.files || [];
  let html = `<div class="ed-path"><code title="${esc(d.cabinet)}">${esc(d.cabinet)}</code><button class="btn mini" data-ed-open="">Open folder</button></div>`;
  if (!files.length) return html + `<div class="empty">Empty so far. Each task they do gets its own folder here, filed under its project; chats go in Chats, and every run's log in Logs.</div>`;
  html += '<div class="ed-tree">';
  for (const f of files) {
    const name = f.path.split('/').pop();
    html += `<div class="ed-f ${f.dir ? 'dir' : ''}" style="padding-left:${6 + f.depth * 16}px" data-ed-open="${esc(f.path)}" title="${esc(f.path)}">
      <i>${f.dir ? '▸' : '·'}</i><span>${esc(name)}</span><em>${f.dir ? '' : size(f.size) + ' · '}${ago(f.mtime)}</em></div>`;
  }
  return html + '</div>';
}

function computerView(d, runs) {
  const work = d.work || [];
  const now = work.filter(w => w.status === 'working');
  let html = '';
  const hookBusy = runs.includes('class="nowcard"');
  if (now.length) for (const w of now) html += job(w, true);
  else if (!hookBusy) html += `<div class="ed-screen idle">Screensaver. Nothing running right now.</div>`;
  html += runs;
  const before = work.filter(w => w.status !== 'working');
  if (before.length) { html += `<div class="runs-h">Brief work</div>`; for (const w of before) html += job(w, desk.open.has(w.key)); }
  // what they did in their chat box
  const turns = [];
  const msgs = d.chat.messages || [];
  for (let i = 0; i < msgs.length; i++) if (msgs[i].role === 'user') turns.push({ ask: msgs[i], reply: msgs[i + 1] });
  if (turns.length) {
    html += `<div class="runs-h">Chat work</div>`;
    for (const t of turns.slice(-8).reverse()) {
      const tools = (t.reply?.tools || []).map(x => typeof x === 'string' ? x : x.text);
      html += `<div class="ed-job"><div class="top"><b>${esc(t.ask.text.split('\n')[0].slice(0, 120))}</b><em>${ago(t.ask.ts)}</em></div>
        ${tools.length ? `<div class="ed-log">${tools.slice(-12).map(x => `<div class="tool">${esc(x)}</div>`).join('')}</div>` : ''}</div>`;
    }
  }
  return html;
}
function job(w, open) {
  const log = w.log || [];
  return `<div class="ed-job ${w.status} ${open ? 'open' : ''}" data-ed-job="${esc(w.key)}">
    <div class="top"><i></i><b>${esc(w.task.split('\n')[0].slice(0, 140))}</b><em>${STATUS[w.status] || w.status}${w.start ? ' · ' + ago(w.start) : ''}</em></div>
    <div class="meta">brief “${esc(w.brief)}”${w.project ? ` · project ${esc(w.project)}` : ''}</div>
    ${open ? `${log.length ? `<div class="ed-log">${log.slice(-80).map(e => `<div class="${e.kind}"><time>${new Date(e.ts).toLocaleTimeString()}</time>${esc(e.text)}</div>`).join('')}</div>`
      : w.status === 'working' ? '<div class="ed-log"><div class="dim">Starting…</div></div>' : ''}
      ${w.result && w.status !== 'working' ? `<div class="res">${esc(w.result)}</div>` : ''}
      <div class="pacts">${w.folder ? `<button class="btn mini" data-ed-abs="${esc(w.folder)}">Open its folder</button>` : ''}${w.logFile ? `<button class="btn mini" data-ed-abs="${esc(w.logFile)}">Open the log file</button>` : ''}</div>` : ''}
  </div>`;
}

// ---------- clicks ----------
export async function click(e) {
  if (!desk.id) return false;
  const b = e.target.closest('[data-ed-open], [data-ed-abs], [data-ed-job]');
  if (!b) return false;
  // a file in the cabinet (or its log) shows in the preview panel; folders open in Explorer
  const sep = desk.data?.cabinet?.includes('\\') ? '\\' : '/';
  if (b.dataset.edOpen && !b.classList.contains('dir') && desk.data?.cabinet) { preview({ path: desk.data.cabinet + sep + b.dataset.edOpen }); return true; }
  if (b.dataset.edAbs && /\.\w+$/.test(b.dataset.edAbs)) { preview({ path: b.dataset.edAbs }); return true; }
  if (b.dataset.edOpen !== undefined) { const r = await api('/api/employee/open', { id: desk.id, path: b.dataset.edOpen }); if (r.error) alertErr(r.error); return true; }
  if (b.dataset.edAbs) {
    const rel = desk.data?.cabinet && b.dataset.edAbs.startsWith(desk.data.cabinet) ? b.dataset.edAbs.slice(desk.data.cabinet.length).replace(/^[\\/]/, '') : null;
    const r = rel !== null ? await api('/api/employee/open', { id: desk.id, path: rel }) : await api('/api/open-file', { path: b.dataset.edAbs });
    if (r.error) alertErr(r.error);
    return true;
  }
  if (b.dataset.edJob) {
    if (e.target.closest('button')) return true;
    desk.open.has(b.dataset.edJob) ? desk.open.delete(b.dataset.edJob) : desk.open.add(b.dataset.edJob);
    rerender();
    return true;
  }
  return false;
}
let toastFn = msg => console.warn(msg);
export function onError(fn) { toastFn = fn; }
const alertErr = m => toastFn(m);
