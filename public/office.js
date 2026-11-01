// An employee's desk in the side panel: their own chat box (you talk to them, not the Manager), their
// file cabinet (the real folder in the brain's Office folder where their work is filed), and their
// computer (what they're doing right now, step by step, and the logs of what they did before).
// app.js owns the selection and calls render(); this module fetches the employee's data and keeps it live.
import { events } from '/events.js';
import { markdown } from '/markdown.js';

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
let desk = { id: null, data: null, err: '', approvals: [], open: new Set(), draft: '' };
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
async function loadApprovals() {
  const r = await api('/api/chat');
  desk.approvals = (r.approvals || []).filter(c => c.chat);
}
export function select(id) {
  if (desk.id === id) return;
  desk = { id, data: null, err: '', approvals: desk.approvals, open: new Set(), draft: '' };
  load(id, true);
  loadApprovals().then(rerender);
}
events.addEventListener('chat', e => {
  const ev = JSON.parse(e.data);
  if (ev.kind === 'approval' && ev.card.chat) { desk.approvals.push(ev.card); if (ev.card.chat === desk.data?.chat?.id) rerender(); }
  if (ev.kind === 'approval-done') desk.approvals = desk.approvals.filter(c => c.id !== ev.id);
  if (desk.id && ev.chat && ev.chat === desk.data?.chat?.id) load(desk.id);
});
events.addEventListener('tasklog', e => {
  const ev = JSON.parse(e.data);
  const job = desk.data?.work?.find(w => w.key === ev.key);
  if (job) { (job.log ||= []).push(ev.entry); rerender(); }
  else if (desk.id && desk.data?.work) load(desk.id); // a task of theirs that just started
});
events.addEventListener('manager', () => { if (desk.id) load(desk.id); });

// ---------- the three views ----------
// runs: app.js's "Working on" card and recent runs from the activity hook, shown on their computer
export function render(el, s, view, who, runs = '') {
  const key = `${s.id}:${view}`;
  const d = desk.id === s.id ? desk.data : null;
  // keep the half-typed message and the scroll position through live updates
  const input = el.querySelector('#edInput');
  if (input && el.dataset.for === key) desk.draft = input.value;
  const box = el.querySelector('.desk-body');
  const scroll = box && el.dataset.for === key ? { top: box.scrollTop, bottom: box.scrollHeight - box.scrollTop - box.clientHeight < 30 } : null;
  const focused = document.activeElement?.id === 'edInput';
  let body;
  if (!d) body = `<div class="empty">${esc(desk.err || 'Opening their desk…')}</div>`;
  else if (view === 'chat') body = chatView(d, who);
  else if (view === 'cabinet') body = cabinetView(d);
  else body = computerView(d, runs);
  const foot = view === 'chat' && d ? `<div class="ed-compose"><textarea id="edInput" rows="2" placeholder="Message ${esc(stripTags(who))} directly…"></textarea>
    ${d.chat.busy ? '<button class="btn" data-ed="stop">Stop</button>' : '<button class="btn primary" data-ed="send">Send</button>'}</div>` : '';
  el.innerHTML = `${tabs(view, who)}<div class="desk-body">${body}</div>${foot}`;
  el.dataset.for = key;
  const ta = el.querySelector('#edInput');
  if (ta) { ta.value = desk.draft; if (focused) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); } }
  const nb = el.querySelector('.desk-body');
  if (nb) nb.scrollTop = view !== 'chat' ? (scroll ? scroll.top : 0) : scroll && !scroll.bottom ? scroll.top : nb.scrollHeight;
}
const stripTags = s => String(s).replace(/<[^>]*>/g, '').replace(/&amp;/g, '&');

function chatView(d, who) {
  const msgs = d.chat.messages || [];
  const cards = desk.approvals.filter(c => c.chat === d.chat.id);
  let html = `<div class="k">Talk to ${esc(stripTags(who))} directly. What they make goes in their file cabinet.</div>`;
  if (!msgs.length) html += `<div class="empty">No messages yet. Ask them something in their line of work.</div>`;
  for (const m of msgs) {
    if (m.role === 'user') { html += `<div class="ed-msg you">${esc(m.text)}</div>`; continue; }
    const tools = (m.tools || []).map(t => typeof t === 'string' ? t : t.text);
    html += `<div class="ed-msg them">${tools.length ? `<details class="ed-tools"><summary>${tools.length} step${tools.length > 1 ? 's' : ''}</summary>${tools.map(t => `<div>${esc(t)}</div>`).join('')}</details>` : ''}
      ${m.text ? `<div class="body">${markdown(m.text)}</div>` : m.streaming ? '<div class="body dim">working…</div>' : ''}
      ${m.error ? `<div class="err">${esc(m.error)}</div>` : ''}${m.note ? `<div class="dim">${esc(m.note)}</div>` : ''}</div>`;
  }
  for (const c of cards) html += `<div class="ed-ask"><b>Wants to:</b> ${esc(c.summary)}<div><button class="btn" data-ed-allow="0" data-card="${esc(c.id)}">Deny</button><button class="btn primary" data-ed-allow="1" data-card="${esc(c.id)}">Allow</button></div></div>`;
  return html;
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
  const b = e.target.closest('[data-ed], [data-ed-allow], [data-ed-open], [data-ed-abs], [data-ed-job]');
  if (!b) return false;
  if (b.dataset.edAllow !== undefined) { api('/api/approval/answer', { id: b.dataset.card, allow: b.dataset.edAllow === '1' }); desk.approvals = desk.approvals.filter(c => c.id !== b.dataset.card); rerender(); return true; }
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
  if (b.dataset.ed === 'send') return send(), true;
  if (b.dataset.ed === 'stop') { api('/api/employee/stop', { id: desk.id }); return true; }
  return false;
}
async function send() {
  const ta = document.getElementById('edInput');
  const text = ta?.value.trim();
  if (!text) return;
  desk.draft = '';
  ta.value = '';
  const r = await api('/api/employee/send', { id: desk.id, text });
  if (r.error) { desk.draft = text; alertErr(r.error); }
  load(desk.id, true);
}
export function key(e) {
  if (e.target.id === 'edInput' && e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); return true; }
  return false;
}
let toastFn = msg => console.warn(msg);
export function onError(fn) { toastFn = fn; }
const alertErr = m => toastFn(m);
