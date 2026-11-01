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
    el.className = `msg ${msg.role}${msg.wrap ? ' wrap' : ''}${msg.carry ? ' carry' : ''}`;
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
  el.innerHTML = `<b>${esc(card.who || 'Claude')} wants to: ${esc(card.summary)}</b>
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
  // an employee working a brief may ask while you're on another tab
  const tab = document.querySelector('aside header [data-tab="chat"]');
  if (card.who && tab.getAttribute('aria-selected') !== 'true') tab.classList.add('ping');
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
  newBtn.disabled = b;
  wrapBtn.disabled = b;
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
  const s = await api('/api/chat');
  log.innerHTML = '';
  messages.clear();
  for (const m of s.messages || []) render(m);
  for (const c of s.approvals || []) renderApproval(c);
  context = s.context || null;
  setBusy(!!s.busy);
  showEmpty();
  scrollDown(true);
}

function onEvent(ev) {
  if (ev.kind === 'message') { log.querySelector('.empty')?.remove(); render(ev.message); }
  else if (ev.kind === 'delta') { const e = messages.get(ev.id); if (e) { e.msg.text += ev.text; render(e.msg); } }
  else if (ev.kind === 'update') { const e = messages.get(ev.id); if (e) render({ ...e.msg, ...ev.fields }); }
  else if (ev.kind === 'busy') setBusy(ev.busy);
  else if (ev.kind === 'approval') renderApproval(ev.card);
  else if (ev.kind === 'approval-done') approvalDone(ev.id, ev.allowed);
  else if (ev.kind === 'reset') { log.innerHTML = ''; messages.clear(); dismissed.clear(); showEmpty(); }
  else if (ev.kind === 'context') { context = ev.context; showContext(); }
}

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
newBtn.addEventListener('click', async () => {
  if (!confirm('Start a new conversation? Claude forgets this chat (the shared brain keeps everything it saved).')) return;
  api('/api/chat/new', {});
});

events.addEventListener('chat', e => onEvent(JSON.parse(e.data)));
events.addEventListener('open', () => load()); // also re-syncs after a reconnect
events.addEventListener('brain', () => load()); // each brain has its own conversation
