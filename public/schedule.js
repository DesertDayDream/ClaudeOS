// Scheduled tasks (⏰ in the chat bar): prompts that run by themselves, once or on repeat, each run as
// a new chat in this brain. Claude can make them too (schedule_task); /schedule opens this panel.
import { events } from '/events.js';

const TOKEN = window.CLAUDEOS_TOKEN;
const btn = document.getElementById('schedBtn');
const panel = document.getElementById('schedList');
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
async function api(p, body) {
  const res = await fetch(p, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', 'x-claudeos-token': TOKEN }, body: body === undefined ? undefined : JSON.stringify(body) });
  return res.json().catch(() => ({ error: `HTTP ${res.status}` }));
}
let list = [], folder = null, editing = null; // editing: a task (or {} for a new one) while the form is open
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const when = ts => {
  if (!ts) return '';
  const d = new Date(ts), today = new Date();
  const t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === today.toDateString()) return `today ${t}`;
  if (d.toDateString() === new Date(Date.now() + 86400e3).toDateString()) return `tomorrow ${t}`;
  return `${d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} ${t}`;
};

function draw() {
  if (editing) return drawForm();
  panel.innerHTML = `<div class="sch-h"><b>Scheduled tasks</b><button type="button" class="btn mini primary" data-s="new">+ New</button><button type="button" class="btn mini" data-s="close" title="Close">✕</button></div>
    <div class="sch-note">Each run starts a new chat in this brain and notifies you when Claude answers. ClaudeOS has to be running; a run missed while it was closed happens when it starts again.</div>
    ${list.length ? list.map(s => `<div class="sch-row${s.enabled ? '' : ' off'}" data-id="${esc(s.id)}">
      <div class="sch-t"><b>${esc(s.title)}</b><span>${esc(s.when)}${s.enabled ? (s.nextRun ? ` · next ${esc(when(s.nextRun))}` : '') : ' · paused'}</span>
        ${s.lastRun ? `<span class="sch-last">Last run ${esc(when(s.lastRun))}${s.lastResult ? ` · ${esc(s.lastResult)}` : ''}${s.lastChat ? ` · <a href="#" data-s="open" data-chat="${esc(s.lastChat)}">open it</a>` : ''}</span>` : ''}</div>
      <div class="sch-acts"><button type="button" class="btn mini" data-s="run" title="Run it now">Run now</button><button type="button" class="btn mini" data-s="toggle">${s.enabled ? 'Pause' : 'Resume'}</button><button type="button" class="btn mini" data-s="edit">Edit</button><button type="button" class="btn mini danger" data-s="delete" title="Delete">×</button></div>
    </div>`).join('') : '<div class="empty">No scheduled tasks yet. Make one with + New, type /schedule in the chat, or ask Claude (“every weekday at 9, summarize…”).</div>'}`;
}
function drawForm() {
  const s = editing;
  const repeat = s.repeat || 'daily';
  const today = new Date(Date.now() + 3600e3);
  const date = s.date || `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  panel.innerHTML = `<form class="sch-form">
    <div class="sch-h"><b>${s.id ? 'Edit scheduled task' : 'New scheduled task'}</b></div>
    <label>Name<input name="title" value="${esc(s.title || '')}" placeholder="e.g. Morning summary" maxlength="80"></label>
    <label>What Claude does each time<textarea name="prompt" rows="6" placeholder="Write it so it stands on its own: each run starts a fresh chat.">${esc(s.prompt || '')}</textarea></label>
    <div class="sch-when">
      <label>Repeat<select name="repeat">${['once', 'hourly', 'daily', 'weekdays', 'weekly'].map(r => `<option value="${r}"${r === repeat ? ' selected' : ''}>${{ once: 'Once', hourly: 'Every few hours', daily: 'Every day', weekdays: 'Weekdays', weekly: 'Every week' }[r]}</option>`).join('')}</select></label>
      <label data-for="once">Date<input type="date" name="date" value="${esc(date)}"></label>
      <label data-for="weekly">Day<select name="day">${DAYS.map((d, n) => `<option value="${n}"${n === (Number.isInteger(s.day) ? s.day : 1) ? ' selected' : ''}>${d[0].toUpperCase() + d.slice(1)}</option>`).join('')}</select></label>
      <label data-for="hourly">Every<span class="sch-n"><input type="number" name="every" min="1" max="168" value="${esc(s.every || 1)}"> hours</span></label>
      <label data-for="time">Time<input type="time" name="time" value="${esc(s.time || '09:00')}"></label>
    </div>
    <label class="sch-folder">Works in<input name="folder" value="${esc(s.id ? s.folder || '' : folder || '')}" placeholder="The brain's folder" spellcheck="false"></label>
    <div class="sch-acts"><button type="button" class="btn mini" data-s="cancel">Cancel</button><button type="submit" class="btn mini primary">${s.id ? 'Save' : 'Schedule it'}</button></div>
  </form>`;
  showFields();
  panel.querySelector(s.prompt ? '[name=title]' : '[name=prompt]').focus();
}
function showFields() {
  const r = panel.querySelector('[name=repeat]')?.value;
  for (const l of panel.querySelectorAll('[data-for]')) {
    const f = l.dataset.for;
    l.hidden = f === 'time' ? r === 'hourly' : f !== r;
  }
}
async function load() {
  const r = await api('/api/schedules');
  list = r.list || [];
  folder = r.folder || null;
  if (!panel.hidden) draw();
}
export function openSchedules(prompt) {
  panel.hidden = false;
  editing = prompt != null ? { prompt } : null;
  load().then(draw);
  draw();
}
btn.addEventListener('click', () => { if (panel.hidden) openSchedules(); else panel.hidden = true; });
document.addEventListener('claudeos:schedule', e => openSchedules(e.detail?.prompt ?? ''));
panel.addEventListener('change', e => { if (e.target.name === 'repeat') showFields(); });
panel.addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target;
  const body = { id: editing.id, title: f.title.value, prompt: f.prompt.value, repeat: f.repeat.value, time: f.time.value, date: f.date.value, day: Number(f.day.value), every: Number(f.every.value), folder: f.folder.value.trim().replace(/^"|"$/g, '') || null };
  const r = await api('/api/schedules/save', body);
  if (r.error) return alert(r.error);
  editing = null;
  load();
});
panel.addEventListener('click', async e => {
  const b = e.target.closest('[data-s]');
  if (!b) return;
  const act = b.dataset.s, id = b.closest('[data-id]')?.dataset.id, s = list.find(x => x.id === id);
  if (act === 'close') { panel.hidden = true; return; }
  if (act === 'new') { editing = {}; return draw(); }
  if (act === 'cancel') { editing = null; return draw(); }
  if (act === 'edit' && s) { editing = { ...s }; return draw(); }
  if (act === 'open') { e.preventDefault(); const r = await api('/api/chats/open', { id: b.dataset.chat }); if (r.error) alert(r.error); else panel.hidden = true; return; }
  if (!s) return;
  if (act === 'toggle') { const r = await api('/api/schedules/save', { id, enabled: !s.enabled }); if (r.error) alert(r.error); return load(); }
  if (act === 'run') { b.disabled = true; const r = await api('/api/schedules/run', { id }); if (r.error) alert(r.error); else panel.hidden = true; return load(); }
  if (act === 'delete' && confirm(`Delete the scheduled task “${s.title}”? Chats it already made stay.`)) { const r = await api('/api/schedules/delete', { id }); if (r.error) alert(r.error); return load(); }
});
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !panel.hidden && !e.target.closest('textarea')) { if (editing) { editing = null; draw(); } else panel.hidden = true; } });
events.addEventListener('schedules', () => { if (!panel.hidden && !editing) load(); });
events.addEventListener('brain', () => { editing = null; panel.hidden = true; });
