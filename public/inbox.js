import { events } from '/events.js';
// ClaudeOS Inbox tab: leave requests (and files) for the Manager, press "Brief & assign" to hand them to
// the Manager (the chat), and follow its briefs: which employee does what, what waits for what, and how
// each part ended.
const TOKEN = window.CLAUDEOS_TOKEN;
const el = document.getElementById('inbox');
const tabBtn = document.querySelector('aside header [data-tab="inbox"]');
let s = { inbox: [], files: [], briefs: [], busy: false, max: 3 };
let draft = '', err = '', uploading = 0;
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
  tabBtn.textContent = count ? `Inbox (${count})` : 'Inbox';
  const focus = document.activeElement?.id === 'inboxText';
  let html = `<div class="ib-intro">Leave requests for the <b>Manager</b>, the one you talk to in the Chat tab. <i>Brief &amp; assign</i> hands everything waiting to it: it writes one brief and splits the work between the employees. Up to ${s.max} work at the same time; a part that needs another's output waits for it. The team's reports come back in Chat. You can also just ask the Manager in Chat.</div>
    <textarea id="inboxText" rows="3" placeholder="e.g. “Turn the desert clip into a reel with a cover and post copy”">${esc(draft)}</textarea>
    <div class="ib-row"><label class="btn" title="Saved into this brain's inbox/ folder">Add files<input type="file" id="inboxFiles" multiple hidden></label>
      <button class="btn" data-ib="add">Add to inbox</button></div>
    ${err ? `<div class="ib-err">${esc(err)}</div>` : ''}
    <div class="runs-h">Waiting · ${count}</div>`;
  if (!count && !uploading) html += '<div class="empty">Nothing waiting. Add a request above, or drop files anywhere on this tab.</div>';
  for (const x of waiting) html += `<div class="ib-item"><span>${esc(x.text)}</span><button class="btn mini" data-ib="remove" data-id="${x.id}" title="Remove">×</button></div>`;
  for (const x of sent) html += `<div class="ib-item sent"><span>${esc(x.text)}</span><em>With the Manager in Chat</em></div>`;
  for (const f of s.files) html += `<div class="ib-item file"><code>${esc(f.path)}</code><em>${size(f.size)}</em></div>`;
  if (uploading) html += `<div class="ib-item file"><em>Uploading ${uploading} file${uploading > 1 ? 's' : ''}…</em></div>`;
  html += `<div class="ib-row"><button class="btn primary" data-ib="run" ${count && !s.chatting ? '' : 'disabled'} title="${s.chatting ? 'The Manager is answering in Chat' : 'Hand everything waiting to the Manager in Chat'}">Brief &amp; assign</button>${s.busy ? ' <button class="btn danger" data-ib="stop">Stop the team</button>' : ''}</div>`;
  const briefs = [...s.briefs].reverse();
  if (briefs.length) html += '<div class="runs-h">Briefs</div>';
  for (const b of briefs) html += briefCard(b);
  el.innerHTML = html;
  if (focus) { const t = document.getElementById('inboxText'); t.focus(); t.setSelectionRange(t.value.length, t.value.length); }
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
      <div class="meta">${t.employee} · ${STATUS[t.status] || t.status}${waits}${took}${t.usage?.cost ? ` · ≈$${t.usage.cost.toFixed(2)}` : ''}</div>
      ${t.result ? `<div class="res">${esc(t.result)}</div>` : ''}</div>`;
  }
  for (const k of b.skipped || []) html += `<div class="ib-skip">Set aside: ${esc(k.reason)}</div>`;
  if (b.notes) html += `<div class="bs dim">${esc(b.notes)}</div>`;
  return html + '</div>';
}

async function upload(files) {
  for (const f of files) {
    uploading++; render();
    const res = await fetch(`/api/inbox/upload?name=${encodeURIComponent(f.name)}`, { method: 'POST', headers: { 'x-claudeos-token': TOKEN }, body: f })
      .then(r => r.json()).catch(() => ({ error: 'The upload failed.' }));
    uploading--;
    err = res.error || '';
    render();
  }
}

el.addEventListener('input', e => { if (e.target.id === 'inboxText') draft = e.target.value; });
el.addEventListener('keydown', e => {
  if (e.target.id === 'inboxText' && e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); act('add'); }
});
el.addEventListener('change', e => { if (e.target.id === 'inboxFiles') upload([...e.target.files]); });
el.addEventListener('dragover', e => { e.preventDefault(); el.classList.add('drop'); });
el.addEventListener('dragleave', e => { if (!el.contains(e.relatedTarget)) el.classList.remove('drop'); });
el.addEventListener('drop', e => { e.preventDefault(); el.classList.remove('drop'); upload([...e.dataTransfer.files]); });
el.addEventListener('click', e => {
  const b = e.target.closest('[data-ib]');
  if (b) return act(b.dataset.ib, b);
  const run = e.target.closest('.run[data-key]');
  if (run && run.querySelector('.res')) { open.has(run.dataset.key) ? open.delete(run.dataset.key) : open.add(run.dataset.key); render(); }
});

async function act(what, btn) {
  if (btn) btn.disabled = true;
  let r;
  if (what === 'add') { r = await api('/api/inbox/add', { text: draft }); if (r.ok) draft = ''; }
  else if (what === 'remove') r = await api('/api/inbox/remove', { id: btn.dataset.id });
  else r = await api(`/api/inbox/${what}`, {});
  err = r.error || '';
  render();
}

async function load() { const r = await api('/api/manager'); if (!r.error) s = r; render(); }
events.addEventListener('manager', e => { s = JSON.parse(e.data); render(); });
events.addEventListener('chat', e => { const ev = JSON.parse(e.data); if (ev.kind === 'busy') { s.chatting = !!ev.any; render(); } });
events.addEventListener('open', () => load());
events.addEventListener('brain', () => load()); // each brain has its own inbox
tabBtn.addEventListener('click', () => load()); // files may have landed in inbox/ from outside
