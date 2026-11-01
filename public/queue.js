import { events } from '/events.js';
// The team queue and briefs. Requests you Queue in the chat (and files dropped into the brain's inbox/
// folder) wait above the message box; "Send to team" hands them all to the Manager (the open chat),
// which briefs the employees. The Activity tab shows each brief: who does what, what waits for what, and
// how each part ended. The Queue button itself lives in chat.js, beside Send.
const TOKEN = window.CLAUDEOS_TOKEN;
const queueEl = document.getElementById('queue');
const briefsEl = document.getElementById('briefs');
let s = { inbox: [], files: [], briefs: [], busy: false, max: 3 };
let err = '';
const open = new Set(); // task keys with their full report showing

const esc = v => String(v ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const size = n => n > 1e6 ? (n / 1e6).toFixed(1) + ' MB' : Math.ceil(n / 1024) + ' KB';
const STATUS = { waiting: 'Waiting', working: 'Working', done: 'Done', error: 'Failed', stopped: 'Stopped', skipped: 'Skipped' };
const BRIEF = { working: 'Team at work', done: 'Done', failed: 'Finished with problems', stopped: 'Stopped' };
const RUN_CLASS = { waiting: 'stopped', working: 'working', done: '', error: 'error', stopped: 'stopped', skipped: 'stopped' };

async function api(path, body) {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', 'x-claudeos-token': TOKEN },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res.json().catch(() => ({ error: `HTTP ${res.status}` }));
}

function render() {
  const waiting = s.inbox.filter(x => x.status === 'new'), sent = s.inbox.filter(x => x.status === 'sent');
  const count = waiting.length + s.files.length;
  queueEl.hidden = !count && !sent.length && !err;
  let html = `<div class="qh"><span>Queued for the team · ${count}</span>${count ? `<button type="button" class="btn mini primary" data-q="run" ${s.chatting ? 'disabled title="The Manager is answering; wait for it"' : 'title="The Manager briefs everything queued at once and splits the work between the employees"'}>Send to team</button>` : ''}</div>`;
  for (const x of waiting) html += `<div class="qi"><span>${esc(x.text)}${x.files?.length ? ` <em>· ${x.files.length} file${x.files.length > 1 ? 's' : ''}</em>` : ''}</span><button type="button" class="btn mini" data-q="remove" data-id="${x.id}" title="Remove">×</button></div>`;
  for (const x of sent) html += `<div class="qi"><span>${esc(x.text)}</span><em>with the Manager</em></div>`;
  for (const f of s.files) html += `<div class="qi"><span><code>${esc(f.path)}</code></span><em>${size(f.size)}</em></div>`;
  if (err) html += `<div class="ib-err">${esc(err)}</div>`;
  queueEl.innerHTML = html;

  const briefs = [...s.briefs].reverse().slice(0, 5);
  briefsEl.innerHTML = briefs.length ? `<div class="runs-h">Briefs${s.busy ? ' <button type="button" class="btn mini danger" data-q="stop">Stop the team</button>' : ''}</div>${briefs.map(briefCard).join('')}` : '';
}

function briefCard(b) {
  const done = b.tasks.filter(t => t.status === 'done').length;
  const cost = b.tasks.map(t => t.usage).reduce((a, u) => a + (u?.cost || 0), 0);
  let html = `<div class="brief ${b.status}"><div class="bt"><b>${esc(b.title || 'New brief')}</b><span>${BRIEF[b.status] || b.status}${b.tasks.length ? ` · ${done}/${b.tasks.length} done` : ''}${cost ? ` · ≈$${cost.toFixed(2)}` : ''}</span></div>`;
  if (b.summary) html += `<div class="bs">${esc(b.summary)}</div>`;
  if (b.error) html += `<div class="ib-err">${esc(b.error)}</div>`;
  for (const t of b.tasks) {
    const key = b.id + t.id;
    const waits = t.after.length && t.status === 'waiting' ? ` · waits for ${t.after.map(id => esc(b.tasks.find(x => x.id === id)?.name || id)).join(', ')}` : '';
    const took = t.end && t.start ? ` · ${Math.max(1, Math.round((t.end - t.start) / 1000))}s` : '';
    html += `<div class="run ${RUN_CLASS[t.status] ?? ''} ${open.has(key) ? 'open' : ''}" data-key="${key}">
      <div class="top"><i></i><b>${esc(t.name || t.employee)} · ${esc(t.task.split('\n')[0])}</b></div>
      <div class="meta">${t.employee}${t.projectName ? ` · ${esc(t.projectName)}` : ""} · ${STATUS[t.status] || t.status}${waits}${took}${t.usage?.cost ? ` · ≈$${t.usage.cost.toFixed(2)}` : ''}</div>
      ${t.result ? `<div class="res">${esc(t.result)}</div>` : ''}</div>`;
  }
  for (const k of b.skipped || []) html += `<div class="ib-skip">Set aside: ${esc(k.reason)}</div>`;
  if (b.notes) html += `<div class="bs dim">${esc(b.notes)}</div>`;
  return html + '</div>';
}

async function act(what, btn) {
  if (btn) btn.disabled = true;
  const r = what === 'remove' ? await api('/api/inbox/remove', { id: btn.dataset.id }) : await api(`/api/inbox/${what}`, {});
  err = r.error || '';
  render();
}
for (const el of [queueEl, briefsEl]) el.addEventListener('click', e => {
  const b = e.target.closest('[data-q]');
  if (b) { e.stopPropagation(); return act(b.dataset.q, b); }
  const run = e.target.closest('.run[data-key]');
  if (run && run.querySelector('.res')) { e.stopPropagation(); open.has(run.dataset.key) ? open.delete(run.dataset.key) : open.add(run.dataset.key); render(); }
});

async function load() { const r = await api('/api/manager'); if (!r.error) s = r; render(); }
events.addEventListener('manager', e => { s = JSON.parse(e.data); err = ''; render(); });
events.addEventListener('chat', e => { const ev = JSON.parse(e.data); if (ev.kind === 'busy') { s.chatting = !!ev.any; render(); } });
events.addEventListener('open', () => load());
events.addEventListener('brain', () => load()); // each brain has its own queue
// files may have landed in inbox/ from outside
for (const tab of ['chat', 'team']) document.querySelector(`aside header [data-tab="${tab}"]`).addEventListener('click', () => load());
