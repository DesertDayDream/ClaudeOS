import { events } from '/events.js';
import { markdown } from '/markdown.js';
import { preview, loadLocalImages } from '/preview.js';
// ClaudeOS chat panel: send requests to Claude in the active brain's folder, stream replies,
// and answer tool approvals with Allow/Deny.
const TOKEN = window.CLAUDEOS_TOKEN;
const log = document.getElementById('log');
const input = document.getElementById('input');
const sendBtn = document.getElementById('send');
const stopBtn = document.getElementById('stop');
const newBtn = document.getElementById('newChat');
const wrapBtn = document.getElementById('wrapChat');
const form = document.getElementById('composer');
const meter = document.getElementById('meter');
const nudge = document.getElementById('nudge');
const modelSel = document.getElementById('chatModel');
const effortSel = document.getElementById('chatEffort');
const modeSel = document.getElementById('chatMode');

// Every message resends the whole conversation. Past BIG tokens, or once the cache has expired on a
// chat of STALE tokens or more, wrapping up and starting fresh is cheaper than carrying on.
const BIG = 120000, STALE = 50000;
const messages = new Map(); // id -> { msg, el }
let busy = false;
let context = null;        // { tokens, base, window, ttl, at } from the server
const dismissed = new Set(); // nudges closed for this chat ("big" / "stale" + when)

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const kTok = n => n >= 1000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k` : String(n);
const mins = ms => ms >= 3600e3 ? `${Math.round(ms / 3600e3)} h` : `${Math.max(1, Math.round(ms / 60e3))} min`;

function usageLine(u) {
  const pct = u.sent ? Math.round((u.cached / u.sent) * 100) : 0;
  const cost = u.cost != null ? ` · ≈$${u.cost.toFixed(u.cost < 0.1 ? 3 : 2)} at API prices` : '';
  const tip = `Claude read ${u.sent.toLocaleString()} tokens over ${u.calls} step${u.calls === 1 ? '' : 's'}, ${u.cached.toLocaleString()} of them from cache (cheap), and wrote ${u.output.toLocaleString()}.` +
    (u.warm < 0.5 ? ' The cache had expired, so the conversation was sent again at full price.' : '');
  return `<div class="usage" title="${esc(tip)}">${kTok(u.sent)} read · ${pct}% from cache · ${kTok(u.output)} written${cost}</div>`;
}

function showContext() {
  if (!context) { meter.hidden = true; nudge.hidden = true; return; }
  const left = context.ttl - (Date.now() - context.at), warm = left > 0;
  meter.hidden = false;
  meter.classList.toggle('big', context.tokens >= BIG);
  meter.innerHTML = `<span class="bar"><i style="width:${Math.min(100, (context.tokens / BIG) * 100)}%"></i></span>
    <span class="txt">Each message resends ${kTok(context.tokens)} tokens · ${warm ? `cache warm for ${mins(left)}` : 'cache expired'}</span>`;
  meter.title = `This conversation is ${context.tokens.toLocaleString()} tokens. Claude reads all of it again with every message. ` +
    `Within ${mins(context.ttl)} of the last reply most of it comes from cache, which costs far less; after that it is sent at full price. ` +
    `A fresh chat in this brain starts at about ${kTok(context.base)}.`;
  const kind = context.tokens >= BIG ? 'big' : !warm && context.tokens >= STALE ? 'stale' : null;
  const key = kind && `${kind}:${kind === 'stale' ? context.at : ''}`;
  if (!kind || busy || dismissed.has(key)) { nudge.hidden = true; return; }
  nudge.hidden = false;
  nudge.innerHTML = (kind === 'big'
    ? `This chat is big: every message resends about <b>${kTok(context.tokens)}</b> tokens. Wrapping up saves what matters to the brain and starts over at about ${kTok(context.base)}.`
    : `The cache has expired, so your next message resends all <b>${kTok(context.tokens)}</b> tokens at full price. Wrapping up first is cheaper.`) +
    `<div class="acts"><button type="button" class="btn primary" data-act="wrap">Wrap up &amp; start fresh</button><button type="button" class="btn" data-act="keep">Keep going</button></div>`;
  nudge.onclick = e => {
    const act = e.target.closest('button')?.dataset.act;
    if (act === 'wrap') wrap();
    if (act === 'keep') { dismissed.add(key); nudge.hidden = true; }
  };
}
setInterval(showContext, 30000); // the cache countdown

function atBottom() { return log.scrollHeight - log.scrollTop - log.clientHeight < 60; }
function scrollDown(force) { if (force || atBottom()) log.scrollTop = log.scrollHeight; }

function render(msg) {
  let entry = messages.get(msg.id);
  if (!entry) {
    const el = document.createElement('div');
    el.className = `msg ${msg.role}${msg.wrap ? ' wrap' : ''}${msg.carry ? ' carry' : ''}${msg.from ? ' from-' + msg.from : ''}`;
    log.appendChild(el);
    entry = { msg, el };
    messages.set(msg.id, entry);
  }
  entry.msg = msg;
  const stick = atBottom();
  if (msg.role === 'user') {
    entry.el.textContent = msg.text;
    if (msg.files?.length) entry.el.prepend(sentFiles(msg.files));
  } else {
    entry.el.innerHTML =
      (msg.carry ? '<div class="head">Fresh start · handover from your last chat (the details are saved in the brain\'s memory)</div>' : '') +
      (msg.tools?.length ? `<div class="tools">${msg.tools.map(toolRow).join('')}</div>` : '') +
      `<div class="body">${markdown(msg.text)}</div>` +
      (msg.streaming && !msg.text ? '<span class="typing"></span>' : '') +
      (msg.error ? `<div class="err">${esc(msg.error)}</div>` : '') +
      (msg.note ? `<div class="note">${esc(msg.note)}</div>` : '') +
      (msg.usage && !msg.streaming ? usageLine(msg.usage) : '');
    if (!msg.streaming) loadLocalImages(entry.el);
  }
  scrollDown(stick);
}

// ---------- what Claude did: tool lines, and file edits as diffs ----------
// Line diff by longest common subsequence; big inputs just show old as removed and new as added.
function diffLines(a, b) {
  // a file's final newline isn't a line of its own
  const x = a ? a.replace(/\n$/, '').split('\n') : [], y = b ? b.replace(/\n$/, '').split('\n') : [];
  if (x.length * y.length > 250000) return [...x.map(t => ['d', t]), ...y.map(t => ['a', t])];
  const L = Array.from({ length: x.length + 1 }, () => new Uint32Array(y.length + 1));
  for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) { out.push([' ', x[i]]); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) out.push(['d', x[i++]]);
    else out.push(['a', y[j++]]);
  }
  while (i < x.length) out.push(['d', x[i++]]);
  while (j < y.length) out.push(['a', y[j++]]);
  return out;
}
// unchanged runs longer than 6 lines fold to 3 either side
function diffHtml(rows) {
  let html = '';
  for (let k = 0; k < rows.length; k++) {
    if (rows[k][0] === ' ') {
      let e = k;
      while (e < rows.length && rows[e][0] === ' ') e++;
      const run = e - k, head = k === 0 ? 0 : 3, tail = e === rows.length ? 0 : 3;
      if (run > head + tail + 1) {
        for (let q = k; q < k + head; q++) html += `<div class="l">${esc(rows[q][1])}</div>`;
        html += `<div class="gap">… ${run - head - tail} unchanged line${run - head - tail === 1 ? '' : 's'}</div>`;
        for (let q = e - tail; q < e; q++) html += `<div class="l">${esc(rows[q][1])}</div>`;
        k = e - 1;
        continue;
      }
    }
    html += `<div class="l${rows[k][0] === ' ' ? '' : ' ' + rows[k][0]}">${esc(rows[k][1])}</div>`;
  }
  return html;
}
function toolRow(t) {
  if (typeof t === 'string') return `<div title="${esc(t)}">${esc(t)}</div>`;
  const rows = t.write != null ? diffLines('', t.write) : t.edits.flatMap((e, n) => [...(n ? [['gap', '']] : []), ...diffLines(e.old, e.new)]);
  const add = rows.filter(r => r[0] === 'a').length, del = rows.filter(r => r[0] === 'd').length;
  const body = rows.reduce((parts, r) => { if (r[0] === 'gap') parts.push([]); else parts.at(-1).push(r); return parts; }, [[]])
    .map(diffHtml).join('<div class="gap">⋯</div>');
  const name = t.file.split(/[\\/]/).pop();
  return `<details><summary title="${esc(t.text)}">${esc(t.text.replace(t.file, name))}<span class="n"><span class="a">+${add}</span> <span class="d">-${del}</span></span></summary>
    <div class="diff"><div class="hd"><span>${esc(t.file)}</span><a class="file" href="#" data-edit="${esc(t.file)}">Open</a></div>${body}</div></details>`;
}
// Copy and Preview on code blocks; file links open the preview panel, diff headers the editor
log.addEventListener('click', async e => {
  const pv = e.target.closest('.code .pv');
  if (pv) return preview({ content: pv.parentElement.querySelector('code').textContent, type: pv.dataset.pv });
  const copy = e.target.closest('.code .copy');
  if (copy) {
    await navigator.clipboard.writeText(copy.parentElement.querySelector('code').textContent).catch(() => {});
    copy.textContent = 'Copied'; copy.classList.add('done');
    setTimeout(() => { copy.textContent = 'Copy'; copy.classList.remove('done'); }, 1200);
    return;
  }
  const file = e.target.closest('a[data-file]');
  if (file) { e.preventDefault(); return preview({ path: file.dataset.file }); }
  const edit = e.target.closest('a[data-edit]');
  if (edit) {
    e.preventDefault();
    const r = await api('/api/open-file', { path: edit.dataset.edit });
    if (r.error) alert(r.error);
  }
});

function renderApproval(card) {
  const el = document.createElement('div');
  el.className = 'approve';
  el.id = 'ap-' + card.id;
  // a chat you left can still ask; its card shows here, saying which chat it's from
  const elsewhere = card.chat && card.chat !== currentId ? `<span class="in">From the chat “${esc(chatList.find(c => c.id === card.chat)?.title || 'another chat')}”</span>` : '';
  el.innerHTML = `${elsewhere}<b>${esc(card.who || 'Claude')} wants to: ${esc(card.summary)}</b>
    <div class="what">${esc(JSON.stringify(card.input))}</div>
    <button class="btn primary" data-allow="1">Allow</button> <button class="btn" data-allow="0">Deny</button>`;
  el.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    for (const x of el.querySelectorAll('button')) x.disabled = true;
    api('/api/approval/answer', { id: card.id, allow: b.dataset.allow === '1' });
  });
  log.appendChild(el);
  scrollDown(true);
  // an employee working a brief, or a chat you left, may ask while you're on another tab
  const tab = document.querySelector('aside header [data-tab="chat"]');
  if ((card.who || elsewhere) && tab.getAttribute('aria-selected') !== 'true') tab.classList.add('ping');
}
document.querySelector('aside header [data-tab="chat"]').addEventListener('click', e => e.currentTarget.classList.remove('ping'));

function approvalDone(id, allowed) {
  const el = document.getElementById('ap-' + id);
  if (!el) return;
  el.classList.add('done');
  for (const x of el.querySelectorAll('button')) x.remove();
  el.insertAdjacentHTML('beforeend', `<span class="note">${allowed ? 'Allowed' : 'Denied'}</span>`);
}

function setBusy(b) {
  busy = b;
  sendBtn.disabled = b;
  stopBtn.hidden = !b;
  wrapBtn.disabled = b; // New chat stays: the busy one keeps working in the list
  showContext();
}

// the chat box shows the Manager's chat, or an employee's when their desk is open (s.employee)
const MANAGER_HINT = input.placeholder;
let employee = null;
function showEmpty() {
  if (log.children.length) return;
  if (employee) { log.innerHTML = `<div class="empty">Talk to ${esc(employee.name)} directly. They work as the ${esc(employee.skill)} employee and file what they make in their file cabinet.</div>`; return; }
  log.innerHTML = `<div class="empty">Ask anything. Claude works in this brain's folder with its shared brain and team,
    and you can watch the employees it hands work to. Anything not already allowed asks you first, right here.</div>`;
}

async function api(path, body) {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', 'x-claudeos-token': TOKEN },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res.json().catch(() => ({ error: `HTTP ${res.status}` }));
}

async function load() {
  const [s, l] = await Promise.all([api('/api/chat'), api('/api/chats')]);
  if (!l.error) showList(l);
  currentId = s.id || null;
  employee = s.employee || null;
  document.getElementById('chat').classList.toggle('employee', !!employee);
  input.placeholder = employee ? `Message ${employee.name} directly…` : MANAGER_HINT;
  titleEl.textContent = employee ? `${employee.name} · ${employee.skill}` : s.title || 'New chat';
  log.innerHTML = '';
  messages.clear();
  dismissed.clear();
  for (const m of s.messages || []) render(m);
  for (const c of s.approvals || []) renderApproval(c);
  context = s.context || null;
  folder = s.folder || null;
  started = (s.messages || []).some(m => m.role === 'user');
  showFolder();
  tools = s.tools || {};
  showTools();
  showOptions(s.options);
  showMode(s.mode);
  setBusy(!!s.busy);
  showEmpty();
  scrollDown(true);
  warmedAt = 0;
  if (document.activeElement === input) warm();
}

function onEvent(ev) {
  // events carry their chat; only the open one's reach the log (the list shows the others working)
  if (ev.chat && ev.chat !== currentId) return;
  if (ev.kind === 'message') {
    log.querySelector('.empty')?.remove();
    render(ev.message);
    if (ev.message.role === 'user' && !started) { started = true; showFolder(); }
  }
  else if (ev.kind === 'folder') { folder = ev.folder; showFolder(); }
  else if (ev.kind === 'tools') { tools = ev.tools || {}; showTools(); }
  else if (ev.kind === 'delta') { const e = messages.get(ev.id); if (e) { e.msg.text += ev.text; render(e.msg); } }
  else if (ev.kind === 'update') { const e = messages.get(ev.id); if (e) render({ ...e.msg, ...ev.fields }); }
  else if (ev.kind === 'busy') setBusy(ev.busy);
  else if (ev.kind === 'approval') renderApproval(ev.card);
  else if (ev.kind === 'approval-done') approvalDone(ev.id, ev.allowed);
  else if (ev.kind === 'open') { listEl.hidden = true; load(); }
  else if (ev.kind === 'list') showList(ev);
  else if (ev.kind === 'context') { context = ev.context; showContext(); }
  else if (ev.kind === 'options') showOptions(ev.options);
  else if (ev.kind === 'mode') showMode(ev.mode);
}

// ---------- the brain's chats ----------
const listEl = document.getElementById('chatList');
const rowsEl = document.getElementById('chatRows');
const searchEl = document.getElementById('chatSearch');
const titleEl = document.getElementById('chatTitle');
const dotEl = document.getElementById('chatsDot');
let currentId = null;
let chatList = []; // every chat, newest first (the search results come from the server)
let query = '', searchTimer = 0;

function ago(ts) {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} d ago`;
  return new Date(ts).toLocaleDateString();
}
function showList(l) {
  if (!query) chatList = l.chats || [];
  const mine = chatList.find(c => c.id === currentId);
  if (mine) titleEl.textContent = mine.title;
  dotEl.classList.toggle('on', chatList.some(c => c.busy && c.id !== currentId));
  if (!listEl.hidden && !query) drawRows(chatList);
}
function drawRows(rows) {
  const mark = s => query ? esc(s).replace(new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])), 'gi'), m => `<mark>${m}</mark>`) : esc(s);
  rowsEl.innerHTML = rows.length ? rows.map(c => `<div class="crow ${c.id === currentId ? 'on' : ''}" data-id="${c.id}">
      <div class="ct"><b>${mark(c.title)}</b><span>${c.parent ? '<span class="sub">↳ side session · </span>' : ''}${c.busy ? '<span class="busy">● working · </span>' : ''}${ago(c.updated)} · ${c.count} messages</span>${c.snippet ? `<em>${mark(c.snippet)}</em>` : ''}</div>
      <div class="acts"><button type="button" class="btn mini" data-act="rename" title="Rename">✎</button><button type="button" class="btn mini" data-act="delete" title="Delete">×</button></div>
    </div>`).join('')
    : `<div class="empty">${query ? 'No chat mentions that.' : 'No saved chats yet. Your chats show up here once you send a message.'}</div>`;
}
async function search() {
  query = searchEl.value.trim();
  const l = await api('/api/chats' + (query ? `?q=${encodeURIComponent(query)}` : ''));
  if (l.error) return;
  if (!query) chatList = l.chats;
  drawRows(l.chats);
}
document.getElementById('chatsBtn').addEventListener('click', () => {
  listEl.hidden = !listEl.hidden;
  if (!listEl.hidden) { searchEl.value = ''; query = ''; search(); searchEl.focus(); }
});
searchEl.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(search, 200); });
searchEl.addEventListener('keydown', e => { if (e.key === 'Escape') listEl.hidden = true; });
async function rename(id, now) {
  const title = prompt('Name this chat', now);
  if (title === null || !title.trim() || title === now) return;
  const r = await api('/api/chats/rename', { id, title });
  if (r.error) alert(r.error); else if (!listEl.hidden) search();
}
rowsEl.addEventListener('click', async e => {
  const row = e.target.closest('.crow');
  if (!row) return;
  const c = chatList.find(x => x.id === row.dataset.id) || { id: row.dataset.id, title: row.querySelector('b').textContent };
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'rename') return rename(c.id, c.title);
  if (act === 'delete') {
    if (!confirm(`Delete “${c.title}”? It goes to the brain's chat trash (~/.claudeos/chats). What Claude saved to the shared brain stays.`)) return;
    const r = await api('/api/chats/delete', { id: c.id });
    if (r.error) alert(r.error); else search();
    return;
  }
  if (c.id === currentId) { listEl.hidden = true; return; }
  const r = await api('/api/chats/open', { id: c.id });
  if (r.error) alert(r.error);
});
titleEl.addEventListener('dblclick', () => { if (chatList.some(c => c.id === currentId)) rename(currentId, titleEl.textContent); });

// the Manager's model and effort, kept per brain; empty = Claude Code's default
function showOptions(o = {}) {
  modelSel.value = o.model || '';
  effortSel.value = o.effort || '';
  modelSel.classList.toggle('set', !!o.model);
  effortSel.classList.toggle('set', !!o.effort);
}
for (const sel of [modelSel, effortSel]) sel.addEventListener('change', async () => {
  const r = await api('/api/chat/options', { model: modelSel.value, effort: effortSel.value });
  if (r.error) alert(r.error);
  showOptions(r.options);
});

// how much this chat asks first (Claude Code's permission mode)
function showMode(m = '') {
  modeSel.value = m || '';
  modeSel.classList.toggle('set', !!m);
}
modeSel.addEventListener('change', async () => {
  if (modeSel.value === 'bypassPermissions' && !confirm('Don\'t ask: Claude runs every command and edits every file in this chat without asking first, including ones that can\'t be undone. Turn it on for this chat?')) return load();
  const r = await api('/api/chat/mode', { mode: modeSel.value });
  if (r.error) { alert(r.error); return load(); }
  showMode(r.mode);
  warmedAt = 0;
});

async function wrap() {
  if (busy) return;
  nudge.hidden = true;
  const r = await api('/api/chat/wrap', {});
  if (r.error) alert(r.error);
}

// ---------- attachments ----------
// Pasted, dropped or picked files upload right away into the brain's attachments/ folder and wait
// as chips above the message box; Send takes them along (images are shown to Claude directly).
const attachEl = document.getElementById('attach');
const attachInput = document.getElementById('attachFiles');
const chatPane = document.getElementById('chat');
let pending = []; // { key, name, size, url?, file? (once uploaded), error? }
const kb = n => n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
const extOf = name => (name.match(/\.([^.]+)$/)?.[1] || 'file').slice(0, 4);

// thumbnails need the token, so they come through fetch, not a plain <img src>
const blobs = new Map(); // path -> object URL
async function thumb(img, p) {
  if (!blobs.has(p)) {
    const res = await fetch(`/api/chat/file?path=${encodeURIComponent(p)}`, { headers: { 'x-claudeos-token': TOKEN } }).catch(() => null);
    if (!res?.ok) return;
    blobs.set(p, URL.createObjectURL(await res.blob()));
  }
  img.src = blobs.get(p);
}
function sentFiles(files) {
  const box = document.createElement('div');
  box.className = 'files';
  for (const f of files) {
    const a = document.createElement('a');
    a.className = `att${f.image ? ' pic' : ''}`;
    a.title = `${f.path} · ${kb(f.size)}`;
    if (f.image) {
      const img = document.createElement('img');
      img.alt = f.name;
      thumb(img, f.path);
      a.href = '#';
      a.addEventListener('click', e => { e.preventDefault(); if (img.src) window.open(img.src, '_blank'); });
      a.appendChild(img);
    } else a.innerHTML = `<span class="ic">${esc(extOf(f.name))}</span><span>${esc(f.name)}</span>`;
    box.appendChild(a);
  }
  return box;
}
function drawPending() {
  attachEl.innerHTML = pending.map(p => `<div class="att${p.file ? '' : p.error ? ' bad' : ' up'}" data-key="${p.key}" title="${esc(p.error || `${p.name} · ${kb(p.size)}${p.file ? '' : ' · uploading…'}`)}">
      ${p.url ? `<img src="${p.url}" alt="">` : `<span class="ic">${esc(extOf(p.name))}</span>`}<span>${esc(p.error || p.name)}</span><button type="button" title="Remove">×</button></div>`).join('');
}
attachEl.addEventListener('click', e => {
  const key = e.target.closest('button') && e.target.closest('.att')?.dataset.key;
  if (!key) return;
  const p = pending.find(x => x.key === key);
  if (p?.url) URL.revokeObjectURL(p.url);
  pending = pending.filter(x => x.key !== key);
  drawPending();
});
async function attach(files) {
  for (const f of files) {
    // a pasted screenshot is always "image.png"; give it a name worth keeping
    const name = /^image\.(png|jpe?g|gif|webp)$/i.test(f.name) ? `screenshot-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}.${f.name.split('.').pop()}` : f.name;
    const p = { key: Math.random().toString(36).slice(2), name, size: f.size, url: f.type.startsWith('image/') ? URL.createObjectURL(f) : null };
    pending.push(p);
    drawPending();
    const r = await fetch(`/api/chat/upload?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { 'x-claudeos-token': TOKEN }, body: f })
      .then(res => res.json()).catch(err => ({ error: err.message }));
    if (!pending.includes(p)) continue; // removed while uploading
    if (r.error) p.error = r.error; else p.file = r.file;
    drawPending();
  }
  warm();
}
attachInput.addEventListener('change', () => { attach([...attachInput.files]); attachInput.value = ''; });
input.addEventListener('paste', e => {
  const files = [...(e.clipboardData?.files || [])];
  if (!files.length) return; // plain text pastes as usual
  e.preventDefault();
  attach(files);
});
let dragDepth = 0;
const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
chatPane.addEventListener('dragenter', e => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; chatPane.classList.add('drop'); });
chatPane.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
chatPane.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; chatPane.classList.remove('drop'); } });
chatPane.addEventListener('drop', e => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  chatPane.classList.remove('drop');
  attach([...e.dataTransfer.files]);
  input.focus();
});

// ---------- the folder a chat works in ----------
const folderBtn = document.getElementById('chatFolder');
let folder = null, started = false;
function showFolder() {
  folderBtn.textContent = folder ? `📁 ${folder.split(/[\\/]/).filter(Boolean).pop()}` : 'Brain folder';
  folderBtn.classList.toggle('set', !!folder);
  folderBtn.title = (folder ? `This chat works in ${folder}, like a Claude Desktop session there.` : 'This chat works in the brain\'s own folder.') +
    (started ? ' Start a new chat to work in another folder.' : ' Click to pick a project folder (its CLAUDE.md, settings, MCP servers and Claude Code memory apply). Set it before the first message.');
}
folderBtn.addEventListener('click', async () => {
  if (started) return alert(`This chat works in ${folder || 'the brain folder'}. Start a new chat to work in another folder.`);
  let recent = [];
  try { recent = JSON.parse(localStorage.getItem('claudeos.folders') || '[]'); } catch { /* none yet */ }
  const pick = prompt(`Folder for this chat (full path). Leave empty for the brain's own folder.${recent.length ? `\n\nRecent:\n${recent.join('\n')}` : ''}`, folder || recent[0] || '');
  if (pick === null) return;
  const r = await api('/api/chat/folder', { folder: pick.trim().replace(/^"|"$/g, '') });
  if (r.error) return alert(r.error);
  folder = r.folder;
  if (folder) try { localStorage.setItem('claudeos.folders', JSON.stringify([folder, ...recent.filter(x => x !== folder)].slice(0, 6))); } catch { /* fine */ }
  showFolder();
  warm();
});

// ---------- this chat's tools: browser, Claude in Chrome, computer use ----------
const toolsBtn = document.getElementById('chatTools');
const toolsMenu = document.getElementById('toolsMenu');
const TOOL_LABEL = { browser: 'Browser', chrome: 'Chrome', computer: 'Computer' };
let tools = {};
function showTools() {
  const on = Object.keys(TOOL_LABEL).filter(t => tools[t]);
  toolsBtn.textContent = on.length ? `Tools: ${on.map(t => TOOL_LABEL[t]).join(', ')}` : 'Tools';
  toolsBtn.classList.toggle('set', on.length > 0);
  for (const box of toolsMenu.querySelectorAll('input')) box.checked = !!tools[box.dataset.tool];
}
toolsBtn.addEventListener('click', e => { e.stopPropagation(); toolsMenu.hidden = !toolsMenu.hidden; });
document.addEventListener('click', e => { if (!toolsMenu.hidden && !toolsMenu.contains(e.target)) toolsMenu.hidden = true; });
toolsMenu.addEventListener('change', async () => {
  const want = Object.fromEntries([...toolsMenu.querySelectorAll('input')].map(b => [b.dataset.tool, b.checked]));
  const r = await api('/api/chat/tools', { tools: want });
  if (r.error) alert(r.error); else tools = r.tools;
  showTools();
  warmedAt = 0;
});

// a chat's Claude starts ahead of the first message, so the reply doesn't wait for it
let warmedAt = 0;
function warm() {
  if (busy || Date.now() - warmedAt < 60e3) return;
  warmedAt = Date.now();
  api('/api/chat/warm', {});
}
input.addEventListener('focus', warm);

async function send() {
  const text = input.value.trim();
  if (busy || pending.some(p => !p.file && !p.error)) return; // still uploading
  const ready = pending.filter(p => p.file);
  if (!text && !ready.length) return;
  const keep = pending;
  input.value = '';
  pending = [];
  drawPending();
  autosize();
  const r = await api('/api/chat', { text, files: ready.map(p => ({ path: p.file.path, name: p.file.name })) });
  if (r.error) { input.value = text; pending = keep; drawPending(); alert(r.error); }
  else for (const p of keep) if (p.url) URL.revokeObjectURL(p.url);
}

// Queue: keep this request (and its attachments) for the team instead of sending it now
document.getElementById('queueBtn').addEventListener('click', async () => {
  const text = input.value.trim();
  if (pending.some(p => !p.file && !p.error)) return; // still uploading
  const ready = pending.filter(p => p.file);
  if (!text && !ready.length) return input.focus();
  const r = await api('/api/inbox/add', { text, files: ready.map(p => p.file.path) });
  if (r.error) return alert(r.error);
  for (const p of pending) if (p.url) URL.revokeObjectURL(p.url);
  input.value = '';
  pending = [];
  drawPending();
  autosize();
  input.focus();
});

function autosize() { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 160) + 'px'; }
input.addEventListener('input', autosize);
input.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
});
form.addEventListener('submit', e => { e.preventDefault(); send(); });
stopBtn.addEventListener('click', () => api('/api/chat/stop', {}));
wrapBtn.addEventListener('click', wrap);
// this chat stays in the Chats list; the new one starts with only the shared brain
newBtn.addEventListener('click', async () => {
  const r = await api('/api/chat/new', {});
  if (r.error) alert(r.error);
  input.focus();
});

events.addEventListener('chat', e => onEvent(JSON.parse(e.data)));
events.addEventListener('open', () => load()); // also re-syncs after a reconnect
events.addEventListener('brain', () => load()); // each brain has its own conversation
