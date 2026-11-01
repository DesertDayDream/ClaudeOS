import { events } from '/events.js';
// ClaudeOS chat panel: send requests to Claude in the active brain's folder, stream replies,
// and answer tool approvals with Allow/Deny.
const TOKEN = window.CLAUDEOS_TOKEN;
const log = document.getElementById('log');
const input = document.getElementById('input');
const sendBtn = document.getElementById('send');
const stopBtn = document.getElementById('stop');
const newBtn = document.getElementById('newChat');
const form = document.getElementById('composer');

const messages = new Map(); // id -> { msg, el }
let busy = false;

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

function atBottom() { return log.scrollHeight - log.scrollTop - log.clientHeight < 60; }
function scrollDown(force) { if (force || atBottom()) log.scrollTop = log.scrollHeight; }

function render(msg) {
  let entry = messages.get(msg.id);
  if (!entry) {
    const el = document.createElement('div');
    el.className = `msg ${msg.role}`;
    log.appendChild(el);
    entry = { msg, el };
    messages.set(msg.id, entry);
  }
  entry.msg = msg;
  const stick = atBottom();
  if (msg.role === 'user') entry.el.textContent = msg.text;
  else {
    entry.el.innerHTML =
      (msg.tools?.length ? `<div class="tools">${msg.tools.map(t => `<div title="${esc(t)}">${esc(t)}</div>`).join('')}</div>` : '') +
      `<div class="body">${markdown(msg.text)}</div>` +
      (msg.streaming && !msg.text ? '<span class="typing"></span>' : '') +
      (msg.error ? `<div class="err">${esc(msg.error)}</div>` : '') +
      (msg.note ? `<div class="note">${esc(msg.note)}</div>` : '');
  }
  scrollDown(stick);
}

function renderApproval(card) {
  const el = document.createElement('div');
  el.className = 'approve';
  el.id = 'ap-' + card.id;
  el.innerHTML = `<b>Claude wants to: ${esc(card.summary)}</b>
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
}

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
  else if (ev.kind === 'reset') { log.innerHTML = ''; messages.clear(); showEmpty(); }
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
newBtn.addEventListener('click', async () => {
  if (!confirm('Start a new conversation? Claude forgets this chat (the shared brain keeps everything it saved).')) return;
  api('/api/chat/new', {});
});

events.addEventListener('chat', e => onEvent(JSON.parse(e.data)));
events.addEventListener('open', () => load()); // also re-syncs after a reconnect
events.addEventListener('brain', () => load()); // each brain has its own conversation
