import { events } from '/events.js';
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

// Every message resends the whole conversation. Past BIG tokens, or once the cache has expired on a
// chat of STALE tokens or more, wrapping up and starting fresh is cheaper than carrying on.
const BIG = 120000, STALE = 50000;
const messages = new Map(); // id -> { msg, el }
let busy = false;
let context = null;        // { tokens, base, window, ttl, at } from the server
const dismissed = new Set(); // nudges closed for this chat ("big" / "stale" + when)

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Small markdown: code fences, inline code, bold, italics, links, lists, paragraphs.
function markdown(src) {
  const parts = String(src).split(/```[^\n]*\n?/);
  return parts.map((part, i) => {
    if (i % 2) return `<pre><code>${esc(part.replace(/\n$/, ''))}</code></pre>`;
    const inline = s => esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    return part.split(/\n{2,}/).map(block => {
      const lines = block.split('\n').filter(l => l.trim());
      if (!lines.length) return '';
      if (lines.every(l => /^\s*[-*]\s+/.test(l))) return `<ul>${lines.map(l => `<li>${inline(l.replace(/^\s*[-*]\s+/, ''))}</li>`).join('')}</ul>`;
      if (lines.every(l => /^\s*\d+[.)]\s+/.test(l))) return `<ol>${lines.map(l => `<li>${inline(l.replace(/^\s*\d+[.)]\s+/, ''))}</li>`).join('')}</ol>`;
      if (/^#{1,6}\s/.test(lines[0])) return `<p><b>${inline(lines[0].replace(/^#+\s*/, ''))}</b>${lines.length > 1 ? '<br>' + lines.slice(1).map(inline).join('<br>') : ''}</p>`;
      return `<p>${lines.map(inline).join('<br>')}</p>`;
    }).join('');
  }).join('');
}

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
  if (msg.role === 'user') entry.el.textContent = msg.text;
  else {
    entry.el.innerHTML =
      (msg.carry ? '<div class="head">Fresh start · handover from your last chat (the details are saved in the brain\'s memory)</div>' : '') +
      (msg.tools?.length ? `<div class="tools">${msg.tools.map(t => `<div title="${esc(t)}">${esc(t)}</div>`).join('')}</div>` : '') +
      `<div class="body">${markdown(msg.text)}</div>` +
      (msg.streaming && !msg.text ? '<span class="typing"></span>' : '') +
      (msg.error ? `<div class="err">${esc(msg.error)}</div>` : '') +
      (msg.note ? `<div class="note">${esc(msg.note)}</div>` : '') +
      (msg.usage && !msg.streaming ? usageLine(msg.usage) : '');
  }
  scrollDown(stick);
}

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

function showEmpty() {
  if (log.children.length) return;
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
  titleEl.textContent = s.title || 'New chat';
  log.innerHTML = '';
  messages.clear();
  dismissed.clear();
  for (const m of s.messages || []) render(m);
  for (const c of s.approvals || []) renderApproval(c);
  context = s.context || null;
  showOptions(s.options);
  setBusy(!!s.busy);
  showEmpty();
  scrollDown(true);
}

function onEvent(ev) {
  // events carry their chat; only the open one's reach the log (the list shows the others working)
  if (ev.chat && ev.chat !== currentId) return;
  if (ev.kind === 'message') { log.querySelector('.empty')?.remove(); render(ev.message); }
  else if (ev.kind === 'delta') { const e = messages.get(ev.id); if (e) { e.msg.text += ev.text; render(e.msg); } }
  else if (ev.kind === 'update') { const e = messages.get(ev.id); if (e) render({ ...e.msg, ...ev.fields }); }
  else if (ev.kind === 'busy') setBusy(ev.busy);
  else if (ev.kind === 'approval') renderApproval(ev.card);
  else if (ev.kind === 'approval-done') approvalDone(ev.id, ev.allowed);
  else if (ev.kind === 'open') { listEl.hidden = true; load(); }
  else if (ev.kind === 'list') showList(ev);
  else if (ev.kind === 'context') { context = ev.context; showContext(); }
  else if (ev.kind === 'options') showOptions(ev.options);
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
      <div class="ct"><b>${mark(c.title)}</b><span>${c.busy ? '<span class="busy">● working · </span>' : ''}${ago(c.updated)} · ${c.count} messages</span>${c.snippet ? `<em>${mark(c.snippet)}</em>` : ''}</div>
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

async function wrap() {
  if (busy) return;
  nudge.hidden = true;
  const r = await api('/api/chat/wrap', {});
  if (r.error) alert(r.error);
}

async function send() {
  const text = input.value.trim();
  if (!text || busy) return;
  input.value = '';
  autosize();
  const r = await api('/api/chat', { text });
  if (r.error) { input.value = text; alert(r.error); }
}

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
