import { events } from '/events.js';
import { markdown, highlight, langOf } from '/markdown.js';
import { preview, previewUrl, loadLocalImages } from '/preview.js';
import { enableReview } from '/review.js';
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
const engineSel = document.getElementById('chatEngine');
const modelSel = document.getElementById('chatModel');
const effortSel = document.getElementById('chatEffort');
const advisorSel = document.getElementById('chatAdvisor');
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
  const tip = `${u.engine === 'codex' ? 'Codex' : 'Claude'} read ${u.sent.toLocaleString()} tokens over ${u.calls} step${u.calls === 1 ? '' : 's'}, ${u.cached.toLocaleString()} of them from cache (cheap), and wrote ${u.output.toLocaleString()}.` +
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
  if (entry.editing) return; // the message is open for editing; it's redrawn when that ends
  const stick = atBottom();
  if (msg.role === 'user') {
    entry.el.textContent = msg.text;
    if (msg.files?.length) entry.el.prepend(sentFiles(msg.files));
    // your own messages can be edited or sent again (rewinding the chat to them)
    if (!msg.wrap && !msg.from) entry.el.insertAdjacentHTML('beforeend', `<div class="macts"><button type="button" data-mact="edit" title="Edit this message and send it again: the chat goes back to here">Edit</button><button type="button" data-mact="retry" title="Send this message again from here">Retry</button></div>`);
  } else {
    entry.el.innerHTML =
      (msg.engine === 'codex' ? '<div class="engine" title="Answered by Codex">Codex</div>' : '') +
      (msg.carry ? '<div class="head">Fresh start · handover from your last chat (the details are saved in the brain\'s memory)</div>' : '') +
      (msg.tools?.length ? `<div class="tools">${msg.tools.map((t, n) => toolRow(t, `${msg.id}:${n}`)).join('')}</div>` : '') +
      `<div class="body">${markdown(msg.text)}</div>` +
      (msg.streaming && !msg.text ? '<span class="typing"></span>' : '') +
      (msg.error ? `<div class="err">${esc(msg.error)}</div>` : '') +
      (msg.note ? `<div class="note">${esc(msg.note)}</div>` : '') +
      (msg.usage && !msg.streaming ? usageLine(msg.usage) : '') +
      (!msg.streaming && !msg.carry && askedBefore(msg.id) ? `<div class="macts"><button type="button" data-mact="again" title="Ask again: the chat goes back to your message before this reply and sends it again">Retry</button></div>` : '');
    if (!msg.streaming) loadLocalImages(entry.el);
    // details you opened stay open while the reply streams in
    for (const d of entry.el.querySelectorAll('details[data-k]')) if (openDetails.has(d.dataset.k)) d.open = true;
  }
  if (msg.todos) showTodos(msg.todos);
  showCrew();
  scrollDown(stick);
}
// who has worked in this chat: each employee (and other skill) once, the latest one marked while busy
const crewEl = document.getElementById('crewon');
function showCrew() {
  const seen = new Map();
  let last = null;
  for (const { msg } of messages.values()) for (const t of msg.tools || []) {
    if (!t?.skill) continue;
    const k = t.skill.who || t.skill.name;
    seen.delete(k);
    seen.set(k, t.skill);
    last = k;
  }
  if (!seen.size) { crewEl.hidden = true; return; }
  crewEl.hidden = false;
  crewEl.innerHTML = `<span title="Employees and skills that worked in this chat">Working here:</span>` + [...seen].map(([k, s]) =>
    `<span class="who${s.who ? '' : ' sk'}${busy && k === last ? ' now' : ''}" title="${s.who ? `${esc(s.who)}, the ${esc(s.role)} employee` : `The ${esc(s.name)} skill`}">${esc(s.who || s.name)}</span>`).join('');
}
const openDetails = new Set();
log.addEventListener('toggle', e => {
  const k = e.target.dataset?.k;
  if (k) e.target.open ? openDetails.add(k) : openDetails.delete(k);
}, true);
// the message of yours a reply answers (null for team reports and handovers)
function askedBefore(replyId) {
  const list = [...messages.values()].map(x => x.msg);
  const i = list.findIndex(m => m.id === replyId);
  for (let j = i - 1; j >= 0; j--) if (list[j].role === 'user') return list[j].wrap || list[j].from ? null : list[j];
  return null;
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
function diffHtml(rows, lang = '') {
  const code = t => highlight(t, lang);
  let html = '';
  for (let k = 0; k < rows.length; k++) {
    if (rows[k][0] === ' ') {
      let e = k;
      while (e < rows.length && rows[e][0] === ' ') e++;
      const run = e - k, head = k === 0 ? 0 : 3, tail = e === rows.length ? 0 : 3;
      if (run > head + tail + 1) {
        for (let q = k; q < k + head; q++) html += `<div class="l">${code(rows[q][1])}</div>`;
        html += `<div class="gap">… ${run - head - tail} unchanged line${run - head - tail === 1 ? '' : 's'}</div>`;
        for (let q = e - tail; q < e; q++) html += `<div class="l">${code(rows[q][1])}</div>`;
        k = e - 1;
        continue;
      }
    }
    html += `<div class="l${rows[k][0] === ' ' ? '' : ' ' + rows[k][0]}">${code(rows[k][1])}</div>`;
  }
  return html;
}
const AGENT_STATE = { running: '◐', done: '✓', failed: '✕', stopped: '■' };
function toolRow(t, key) {
  if (typeof t === 'string') return `<div title="${esc(t)}">${esc(t)}</div>`;
  // an employee (or another skill) taking over this part of the work, in this same chat
  if (t.skill) {
    const s = t.skill;
    return s.who
      ? `<div class="skill" title="${esc(s.who)} works here, in this chat, using the ${esc(s.name)} skill">${esc(s.who)} <span>· ${esc(s.role)} is working on this</span></div>`
      : `<div class="skill plain" title="${esc(t.text || '')}">Using the ${esc(s.name)} skill</div>`;
  }
  // a subagent, with the steps it took folded under it
  if (t.agent) {
    const a = t.agent;
    const label = a.state === 'running' ? (a.background ? 'working in the background' : 'working') : a.state;
    return `<details class="agent ${esc(a.state)}" data-k="${esc(key)}"><summary title="${esc(a.text)}"><i class="ag">${AGENT_STATE[a.state] || '◐'}</i>Agent · ${esc(a.type)}: ${esc(a.text)}<span class="n">${a.count || 0} step${a.count === 1 ? '' : 's'} · ${esc(label)}</span></summary>
      <div class="ag-steps">${a.steps?.length ? a.steps.map(s => `<div title="${esc(s)}">${esc(s)}</div>`).join('') : '<div>No steps yet.</div>'}${a.count > (a.steps?.length || 0) ? `<div class="more">… ${a.count - a.steps.length} earlier steps not shown</div>` : ''}</div></details>`;
  }
  const rows = t.write != null ? diffLines('', t.write) : t.edits.flatMap((e, n) => [...(n ? [['gap', '']] : []), ...diffLines(e.old, e.new)]);
  const add = rows.filter(r => r[0] === 'a').length, del = rows.filter(r => r[0] === 'd').length;
  const body = rows.reduce((parts, r) => { if (r[0] === 'gap') parts.push([]); else parts.at(-1).push(r); return parts; }, [[]])
    .map(part => diffHtml(part, langOf(t.file))).join('<div class="gap">⋯</div>');
  const name = t.file.split(/[\\/]/).pop();
  return `<details data-k="${esc(key)}"><summary title="${esc(t.text)}">${esc(t.text.replace(t.file, name))}<span class="n"><span class="a">+${add}</span> <span class="d">-${del}</span></span></summary>
    <div class="diff" data-file="${esc(t.file)}" title="Click a line to comment on it for Claude"><div class="hd"><span>${esc(t.file)}</span><a class="file" href="#" data-edit="${esc(t.file)}">Open</a></div>${body}</div></details>`;
}
// Copy and Preview on code blocks; file links open the preview panel, diff headers the editor
log.addEventListener('click', async e => {
  const mact = e.target.closest('[data-mact]');
  if (mact) {
    const id = mact.closest('.msg') && [...messages.values()].find(x => x.el === mact.closest('.msg'))?.msg.id;
    if (!id) return;
    if (mact.dataset.mact === 'edit') return editMessage(id);
    const asked = mact.dataset.mact === 'again' ? askedBefore(id) : messages.get(id)?.msg;
    if (asked) return retry(asked.id);
    return;
  }
  // a local dev server opens beside the chat (Ctrl+click: in your browser)
  const web = e.target.closest('a[href^="http"]');
  if (web && !e.ctrlKey && !e.metaKey && /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?(\/|$)/i.test(web.href)) {
    e.preventDefault();
    return previewUrl(web.href.replace('0.0.0.0', 'localhost'));
  }
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

// ---------- rewind: edit or retry one of your messages ----------
// Did Claude change files after this message? Then going back can put them back too.
function editsAfter(id) {
  const list = [...messages.values()].map(x => x.msg);
  const i = list.findIndex(m => m.id === id);
  return list.slice(i + 1).some(m => m.tools?.some(t => t && typeof t === 'object' && t.file));
}
async function rewind(id, text, restoreFiles) {
  const r = await api('/api/chat/rewind', { id, ...(text != null ? { text } : {}), restoreFiles });
  if (r.error) { alert(r.error); return false; }
  return true;
}
// a small bar asking whether to put files back as well
function askFiles(el, verb) {
  return new Promise(resolve => {
    const bar = document.createElement('div');
    bar.className = 'rw-ask';
    bar.innerHTML = `<span>Claude changed files after this message.</span><button type="button" class="btn mini" data-r="keep">${verb}, keep files</button><button type="button" class="btn mini primary" data-r="undo">${verb} and undo file changes</button><button type="button" class="btn mini" data-r="cancel">Cancel</button>`;
    el.after(bar);
    bar.addEventListener('click', e => { const r = e.target.closest('[data-r]')?.dataset.r; if (!r) return; bar.remove(); resolve(r); });
  });
}
async function retry(id) {
  if (busy) return alert('Claude is still answering. Wait for it, or press Stop.');
  const el = messages.get(id)?.el;
  let restore = false;
  if (editsAfter(id)) {
    const r = await askFiles(el, 'Retry');
    if (r === 'cancel') return;
    restore = r === 'undo';
  } else if (!confirm('Send this message again? The replies after it are replaced.')) return;
  rewind(id, null, restore);
}
function editMessage(id) {
  if (busy) return alert('Claude is still answering. Wait for it, or press Stop.');
  const entry = messages.get(id);
  if (!entry || entry.editing) return;
  entry.editing = true;
  const edits = editsAfter(id);
  entry.el.classList.add('editing');
  entry.el.innerHTML = `<textarea class="rw-text"></textarea>
    ${edits ? '<label class="rw-files"><input type="checkbox"> Also undo the file changes Claude made after this message</label>' : ''}
    <div class="rw-acts"><span>The chat goes back to here; the replies after it are replaced.</span><button type="button" class="btn mini" data-rw="cancel">Cancel</button><button type="button" class="btn mini primary" data-rw="send">Send</button></div>`;
  const ta = entry.el.querySelector('textarea');
  ta.value = entry.msg.text;
  ta.style.height = Math.min(ta.scrollHeight + 4, 260) + 'px';
  ta.focus();
  const on = e => {
    const a = e.target.closest('[data-rw]')?.dataset.rw;
    if (a === 'cancel') done(); else if (a === 'send') go();
  };
  const done = () => { entry.el.removeEventListener('click', on); entry.editing = false; entry.el.classList.remove('editing'); render(entry.msg); };
  let sending = false;
  const go = async () => {
    const text = ta.value.trim();
    if (sending || (!text && !entry.msg.files?.length)) return;
    sending = true;
    const ok = await rewind(id, text, !!entry.el.querySelector('.rw-files input')?.checked);
    sending = false;
    if (ok) done();
  };
  entry.el.addEventListener('click', on);
  ta.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); go(); }
    if (e.key === 'Escape') done();
  });
}

function renderApproval(card) {
  if (document.getElementById('ap-' + card.id)) return;
  const el = document.createElement('div');
  el.className = 'approve';
  el.id = 'ap-' + card.id;
  // a chat you left can still ask; its card shows here, saying which chat it's from
  const elsewhere = card.chat && card.chat !== currentId ? `<span class="in">From the chat “${esc(chatList.find(c => c.id === card.chat)?.title || 'another chat')}”</span>` : '';
  el.innerHTML = `${elsewhere}<b>${esc(card.who || (card.engine === 'codex' ? 'Codex' : 'Claude'))} wants to: ${esc(card.summary)}</b>
    <div class="what">${esc(JSON.stringify(card.input))}</div>
    ${card.engine === 'codex' ? (card.choices || []).map(choice => `<button class="btn ${choice === 'accept' ? 'primary' : ''}" data-decision="${esc(choice)}">${esc({ accept: 'Allow once', acceptForSession: 'Allow for session', decline: 'Deny', cancel: 'Cancel turn' }[choice] || choice)}</button>`).join(' ') : '<button class="btn primary" data-allow="1">Allow</button> <button class="btn" data-allow="0">Deny</button>'}`;
  el.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    for (const x of el.querySelectorAll('button')) x.disabled = true;
    api('/api/approval/answer', { id: card.id, allow: b.dataset.allow === '1', ...(b.dataset.decision ? { decision: b.dataset.decision } : {}) })
      .then(result => { if (result.error) { alert(result.error); for (const x of el.querySelectorAll('button')) x.disabled = false; } })
      .catch(() => { for (const x of el.querySelectorAll('button')) x.disabled = false; });
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
  if (todos) showTodos(todos);
  showCrew();
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
  commands = s.commands || commands;
  todos = null;
  todosEl.hidden = true;
  if (s.todos) showTodos(s.todos);
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
  else if (ev.kind === 'reset') load();
  else if (ev.kind === 'commands') commands = ev.commands || [];
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
      <div class="ct"><b>${mark(c.title)}</b><span>${c.parent ? '<span class="sub">↳ side session · </span>' : ''}${c.schedule ? '<span class="sched">⏰ scheduled · </span>' : ''}${c.busy ? '<span class="busy">● working · </span>' : ''}${ago(c.updated)} · ${c.count} messages</span>${c.snippet ? `<em>${mark(c.snippet)}</em>` : ''}</div>
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

// The Manager's engine, model and effort, kept per brain; empty = the engine's own default.
// Claude's picks and Codex's are kept apart (model/effort and codexModel/codexEffort), and the model and
// effort lists show the ones of the engine picked.
const CLAUDE_MODELS = [['fable', 'Fable'], ['opus', 'Opus'], ['sonnet', 'Sonnet'], ['haiku', 'Haiku']];
const CLAUDE_EFFORTS = [['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'Extra high'], ['max', 'Max']];
const EFFORT_NAMES = Object.fromEntries([...CLAUDE_EFFORTS, ['ultra', 'Ultra']]);
let opts = {};
let codex = null; // { models, installed, signedIn, text } once asked
async function codexInfo(fresh = false) {
  if (!codex || fresh) codex = await api('/api/codex');
  return codex;
}
function fill(sel, first, list, value) {
  sel.innerHTML = `<option value="">${first}</option>` + list.map(([v, t]) => `<option value="${esc(v)}">${esc(t)}</option>`).join('');
  if (value && ![...sel.options].some(o => o.value === value)) sel.insertAdjacentHTML('beforeend', `<option value="${esc(value)}">${esc(value)}</option>`);
  sel.value = value || '';
  sel.classList.toggle('set', !!value);
}
function showOptions(o = {}) {
  opts = o || {};
  const cx = opts.engine === 'codex';
  engineSel.value = cx ? 'codex' : '';
  engineSel.classList.toggle('set', cx);
  advisorSel.hidden = cx; // Codex has no advisor
  if (!cx) {
    fill(modelSel, 'Default model', CLAUDE_MODELS, opts.model);
    fill(effortSel, 'Default effort', CLAUDE_EFFORTS, opts.effort);
    advisorSel.value = opts.advisor || '';
    advisorSel.classList.toggle('set', !!opts.advisor);
  } else {
    const models = codex?.models || [];
    const m = models.find(x => x.id === opts.codexModel);
    fill(modelSel, 'Default model', models.map(x => [x.id, x.name]), opts.codexModel);
    fill(effortSel, 'Default effort', (m?.efforts?.length ? m.efforts : ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']).map(e => [e, EFFORT_NAMES[e] || e]), opts.codexEffort);
    if (!codex) codexInfo().then(() => { if (opts.engine === 'codex') showOptions(opts); });
  }
  modeSel.title = cx
    ? "Codex permissions: Ask first reviews untrusted commands; Accept edits and Auto ask when Codex requests approval; Plan only is read-only; Don't ask requests full access. Managed policy may still restrict actions."
    : modeSel.dataset.claudeTitle || modeSel.title;
  if (typeof showLimits === 'function') try { showLimits(); } catch { /* meters not set up yet */ }
}
modeSel.dataset.claudeTitle = modeSel.title;
async function saveOptions(change) {
  const r = await api('/api/chat/options', { ...opts, ...change });
  if (r.error) alert(r.error);
  showOptions(r.options || opts);
}
engineSel.addEventListener('change', async () => {
  if (engineSel.value === 'codex') {
    const c = await codexInfo(true);
    if (!c.installed) {
      if (confirm("Codex isn't installed on this PC yet. Install it now? This runs OpenAI's official installer and takes a minute or two; Apps → Accounts shows how it goes, and you sign in there next.")) {
        const r = await api('/api/accounts', { key: 'codex', act: 'install' });
        if (r.error) alert(r.error); else document.dispatchEvent(new CustomEvent('claudeos:open-apps'));
      }
      return showOptions(opts);
    }
    if (!c.signedIn) {
      if (!confirm("Codex isn't signed in yet. Sign in with your ChatGPT account now? A sign-in page opens in your browser.")) return showOptions(opts);
      const r = await api('/api/codex/login', {});
      if (r.error) { alert(r.error); return showOptions(opts); }
      alert('Finish signing in on the page that opened, then press OK.');
      if (!(await codexInfo(true)).signedIn) { alert("Codex still isn't signed in. Try again once the sign-in page says you're done."); return showOptions(opts); }
    }
  }
  saveOptions({ engine: engineSel.value });
});
modelSel.addEventListener('change', () => saveOptions(opts.engine === 'codex' ? { codexModel: modelSel.value } : { model: modelSel.value }));
effortSel.addEventListener('change', () => saveOptions(opts.engine === 'codex' ? { codexEffort: effortSel.value } : { effort: effortSel.value }));
advisorSel.addEventListener('change', () => saveOptions({ advisor: advisorSel.value }));

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
  hideSuggest();
  if (!pending.length && await builtin(text)) { input.value = ''; autosize(); return; }
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
  if (suggestKeys(e)) return;
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

// ---------- Claude's plan: the checklist from TodoWrite / TaskCreate ----------
const todosEl = document.getElementById('todos');
let todos = null, todosOpen = localStorage.getItem('claudeos.todosOpen') !== '0';
const TODO_ICON = { completed: '✓', in_progress: '◐', pending: '○' };
function showTodos(list) {
  todos = list?.length ? list : null;
  if (!todos) { todosEl.hidden = true; return; }
  const done = todos.filter(t => t.status === 'completed').length;
  const now = todos.find(t => t.status === 'in_progress');
  // a finished plan stays as a folded "all done" line until the next plan starts (click to unfold)
  const finished = done === todos.length && !busy;
  const open = finished ? todosOpen === 'all' : !!todosOpen;
  todosEl.hidden = false;
  todosEl.classList.toggle('open', open);
  todosEl.classList.toggle('finished', finished);
  todosEl.innerHTML = `<button type="button" class="td-h" title="Claude's plan for this task">${open ? '▾' : '▸'} ${finished ? `✓ Plan · all ${todos.length} done` : `Plan · ${done} of ${todos.length} done`}${now ? ` · <span>${esc(now.active || now.text)}</span>` : ''}</button>
    <ul>${todos.map(t => `<li class="${esc(t.status)}"><i>${TODO_ICON[t.status] || '○'}</i>${esc(t.status === 'in_progress' && t.active ? t.active : t.text)}</li>`).join('')}</ul>`;
}
todosEl.addEventListener('click', e => {
  if (!e.target.closest('.td-h')) return;
  // a finished plan unfolds just for now; a running one remembers the choice
  if (todosEl.classList.contains('finished')) todosOpen = todosOpen === 'all' ? true : 'all';
  else { todosOpen = !todosOpen; localStorage.setItem('claudeos.todosOpen', todosOpen ? '1' : '0'); }
  showTodos(todos);
});

// ---------- / commands and @ files ----------
// Typing / at the start lists ClaudeOS's own commands, Claude Code's commands and the skills; @ lists
// the files in the chat's folder. Up/Down picks, Enter or Tab takes it, Esc closes.
const suggestEl = document.getElementById('suggest');
let commands = [];
const MODE_WORDS = { ask: '', 'ask-first': '', edits: 'acceptEdits', accept: 'acceptEdits', acceptedits: 'acceptEdits', auto: 'auto', plan: 'plan', dontask: 'bypassPermissions', bypass: 'bypassPermissions', 'dont-ask': 'bypassPermissions' };
function pick(sel, word, map) {
  word = String(word || '').toLowerCase().trim();
  const value = map ? map[word] : [...sel.options].find(o => o.value && (o.value === word || o.textContent.toLowerCase().startsWith(word)))?.value;
  if (value === undefined || (!word && !map)) { alert(`Pick one of: ${[...sel.options].map(o => o.textContent).join(', ')}`); return; }
  sel.value = value;
  sel.dispatchEvent(new Event('change'));
}
const BUILTIN = [
  { name: 'new', hint: 'Start a new chat', run: () => newBtn.click() },
  { name: 'clear', hint: 'Start a new chat (this one stays in Chats)', run: () => newBtn.click() },
  { name: 'wrap', hint: 'Save what matters to the brain and start fresh', run: () => wrap() },
  { name: 'engine', arg: 'claude · codex', hint: 'Who answers: Claude or Codex', run: a => pick(engineSel, a, { claude: '', codex: 'codex' }) },
  { name: 'model', arg: 'fable · opus · sonnet · haiku (or a Codex model)', hint: 'Model for the next replies', run: a => pick(modelSel, a) },
  { name: 'effort', arg: 'low · medium · high · xhigh · max', hint: 'Effort for the next replies', run: a => pick(effortSel, a) },
  { name: 'mode', arg: 'ask · edits · auto · plan · dontask', hint: 'How much Claude asks first', run: a => pick(modeSel, a, MODE_WORDS) },
  { name: 'usage', hint: 'Your plan usage: the 5-hour and weekly limits', run: () => showUsage() },
  { name: 'schedule', hint: 'Run a prompt on a schedule', run: a => document.dispatchEvent(new CustomEvent('claudeos:schedule', { detail: { prompt: a } })) },
  { name: 'plugins', hint: 'Browse and install Claude Code plugins', run: () => document.dispatchEvent(new CustomEvent('claudeos:plugins')) },
];
async function builtin(text) {
  const m = text.match(/^\/([\w:-]+)(?:\s+([\s\S]*))?$/);
  const b = m && BUILTIN.find(x => x.name === m[1].toLowerCase());
  if (!b) return false;
  await b.run((m[2] || '').trim());
  return true;
}
let sug = { items: [], i: 0, t: null }, fileReq = 0, fileTimer = 0;
function token() {
  const pos = input.selectionStart;
  if (pos !== input.selectionEnd) return null;
  const before = input.value.slice(0, pos);
  let m = before.match(/^\/([\w:-]*)$/);
  if (m) return { kind: 'cmd', q: m[1], start: 0, end: pos };
  m = before.match(/(?:^|\s)@([^\s@"]*)$/);
  if (m) return { kind: 'file', q: m[1], start: pos - m[1].length - 1, end: pos };
  return null;
}
function hideSuggest() { suggestEl.hidden = true; sug = { items: [], i: 0, t: null }; }
function drawSuggest() {
  if (!sug.items.length) {
    if (sug.t?.kind === 'file') { suggestEl.hidden = false; suggestEl.innerHTML = `<div class="sg-none">${sug.loading ? 'Looking…' : 'No file matches.'}</div>`; return; }
    return hideSuggest();
  }
  suggestEl.hidden = false;
  suggestEl.innerHTML = sug.items.map((x, n) => x.file
    ? `<div class="sg${n === sug.i ? ' on' : ''}" data-n="${n}"><b>${esc(x.name.split('/').pop())}</b><span>${esc(x.name)}</span></div>`
    : `<div class="sg${n === sug.i ? ' on' : ''}" data-n="${n}"><b>/${esc(x.name)}</b>${x.arg ? `<em>${esc(x.arg)}</em>` : ''}<span>${esc(x.hint || '')}</span><i>${esc(x.tag)}</i></div>`).join('');
  suggestEl.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
}
function updateSuggest() {
  const t = token();
  if (!t) return hideSuggest();
  sug.t = t;
  if (t.kind === 'cmd') {
    const q = t.q.toLowerCase(), seen = new Set();
    const all = [...BUILTIN.map(b => ({ name: b.name, hint: b.hint, arg: b.arg, tag: 'ClaudeOS' })),
      ...commands.map(c => ({ name: c.name, hint: c.kind === 'skill' ? 'Use this skill' : 'Claude Code command', tag: c.kind }))]
      .filter(x => !seen.has(x.name) && seen.add(x.name) && x.name.toLowerCase().includes(q));
    sug.items = all.sort((a, b) => (b.name.toLowerCase().startsWith(q) - a.name.toLowerCase().startsWith(q))).slice(0, 14);
    sug.i = Math.min(sug.i, Math.max(0, sug.items.length - 1));
    return drawSuggest();
  }
  sug.loading = true;
  if (!sug.items.length) drawSuggest();
  clearTimeout(fileTimer);
  fileTimer = setTimeout(async () => {
    const no = ++fileReq;
    const r = await api('/api/chat/files?q=' + encodeURIComponent(t.q));
    if (no !== fileReq || sug.t !== t && token()?.q !== t.q) return;
    sug.loading = false;
    sug.items = (r.files || []).map(f => ({ name: f, file: true }));
    sug.i = 0;
    drawSuggest();
  }, 100);
}
function takeSuggest(n = sug.i) {
  const x = sug.items[n], t = sug.t;
  if (!x || !t) return;
  const after = input.value.slice(t.end);
  const ins = x.file ? `@${/\s/.test(x.name) ? `"${x.name}"` : x.name} ` : `/${x.name} `;
  input.value = input.value.slice(0, t.start) + ins + after.replace(/^\s+/, '');
  const at = t.start + ins.length;
  input.setSelectionRange(at, at);
  hideSuggest();
  autosize();
  input.focus();
}
function suggestKeys(e) {
  if (suggestEl.hidden || !sug.items.length) { if (e.key === 'Escape' && !suggestEl.hidden) { hideSuggest(); return true; } return false; }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); sug.i = (sug.i + (e.key === 'ArrowDown' ? 1 : -1) + sug.items.length) % sug.items.length; drawSuggest(); return true; }
  // Enter on a full command with nothing to add sends it as it is
  if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
    const x = sug.items[sug.i];
    if (e.key === 'Enter' && !x.file && sug.t?.q === x.name) { hideSuggest(); return false; }
    e.preventDefault(); takeSuggest(); return true;
  }
  if (e.key === 'Escape') { e.preventDefault(); hideSuggest(); return true; }
  return false;
}
input.addEventListener('input', updateSuggest);
input.addEventListener('click', updateSuggest);
input.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== input) hideSuggest(); }, 150));
suggestEl.addEventListener('mousedown', e => { const n = e.target.closest('[data-n]')?.dataset.n; if (n != null) { e.preventDefault(); takeSuggest(Number(n)); } });

// ---------- plan usage: the 5-hour and weekly limits ----------
// The meters follow the chat's engine. Claude Code reports Claude's with every reply (rate_limit_event);
// Codex's come from its own session logs (the server reads the newest). No numbers = "unavailable".
const limitsEl = document.getElementById('limits');
let limits = null, codexLim = null;
const WINDOW_NAME = { five_hour: '5-hour', seven_day: 'Week', seven_day_opus: 'Week · Opus', seven_day_sonnet: 'Week · Sonnet' };
const isCodex = () => opts.engine === 'codex';
function resetText(sec) {
  const d = new Date(sec * 1000), now = new Date();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return time;
  return `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`;
}
function codexWindowName(min) {
  if (!min) return 'Limit';
  if (min === 300) return '5-hour';
  if (min === 10080) return 'Week';
  return min % 1440 === 0 ? `${min / 1440}-day` : min % 60 === 0 ? `${min / 60}-hour` : `${min}-min`;
}
function windows() {
  if (isCodex()) {
    if (!codexLim) return [];
    return [['primary', codexLim.primary], ['secondary', codexLim.secondary]].filter(([, v]) => v && v.used_percent != null).map(([k, v]) => {
      const over = v.resets_at && Date.now() > v.resets_at * 1000;
      return { name: codexWindowName(v.window_minutes), pct: over ? 0 : Math.round(v.used_percent), resets: v.resets_at, over,
        status: codexLim.reached && (codexLim.reached === k || codexLim.reached === 'both') && !over ? 'rejected' : '' };
    });
  }
  if (!limits) return [];
  const w = limits.unifiedWindows || (limits.rateLimitType ? { [limits.rateLimitType]: { utilization: limits.utilization, resetsAt: limits.resetsAt, status: limits.status } } : {});
  return Object.entries(w).filter(([, v]) => v && v.utilization != null).map(([k, v]) => {
    const over = v.resetsAt && Date.now() > v.resetsAt * 1000; // that window has started over since
    return { name: WINDOW_NAME[k] || k.replace(/_/g, ' '), pct: over ? 0 : Math.round(v.utilization * 100), resets: v.resetsAt, over, status: v.status };
  });
}
function showLimits() {
  const ws = windows(), who = isCodex() ? 'Codex' : 'Claude', src = isCodex() ? codexLim : limits;
  limitsEl.hidden = false;
  limitsEl.title = `Your ${who} plan usage (click for details)`;
  if (!ws.length) { limitsEl.innerHTML = `<span class="lim na">${who} usage unavailable</span>`; return; }
  const old = Date.now() - src.at > 3 * 3600e3;
  limitsEl.innerHTML = `<span class="lim who">${who}</span>` + ws.map(w => `<span class="lim${w.pct >= 90 || w.status === 'rejected' ? ' hot' : w.pct >= 75 ? ' warm' : ''}" title="${who} ${esc(w.name)} limit: ${w.over ? 'has reset since the last reply' : `${w.pct}% used, resets ${resetText(w.resets)}`}${old ? ` (as of ${new Date(src.at).toLocaleString()})` : ''}">
    <b>${esc(w.name)}</b><span class="bar"><i style="width:${w.pct}%"></i></span>${w.over ? 'reset' : `${w.pct}%`}</span>`).join('') +
    (!isCodex() && limits.status === 'rejected' ? `<span class="lim hot">Limit reached${limits.resetsAt ? ` · back ${resetText(limits.resetsAt)}` : ''}</span>` : '') +
    (isCodex() && ws.some(w => w.status === 'rejected') ? '<span class="lim hot">Limit reached</span>' : '');
}
function showUsage() {
  const ws = windows(), who = isCodex() ? 'Codex' : 'Claude', src = isCodex() ? codexLim : limits;
  if (!ws.length) return alert(isCodex()
    ? "Codex usage is unavailable: no Codex session has logged its limits yet (they're read from ~/.codex/sessions). Send Codex a message first."
    : 'Claude usage is unavailable: Claude Code reports it with each reply, so send a message first.');
  alert(`Your ${who} plan usage${isCodex() && codexLim.plan ? ` (${codexLim.plan})` : ''}${Date.now() - src.at > 600e3 ? ` as of ${new Date(src.at).toLocaleString()}` : ''}:\n\n` +
    ws.map(w => `${w.name}: ${w.over ? 'reset since then' : `${w.pct}% used · resets ${resetText(w.resets)}`}`).join('\n') +
    (!isCodex() && limits.isUsingOverage ? '\n\nYou are using extra usage now.' : ''));
}
limitsEl.addEventListener('click', showUsage);
const loadLimits = () => api('/api/limits').then(r => { limits = r.limits || null; codexLim = r.codex || null; showLimits(); }).catch(() => showLimits());
loadLimits();
events.addEventListener('limits', e => { limits = JSON.parse(e.data); showLimits(); });
events.addEventListener('codexLimits', e => { codexLim = JSON.parse(e.data); showLimits(); });
setInterval(() => (isCodex() ? loadLimits() : showLimits()), 60000);

// ---------- voice: dictate into the message box ----------
const micBtn = document.getElementById('micBtn');
const Speech = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null;
if (!Speech) micBtn.hidden = true;
micBtn.addEventListener('click', () => {
  if (rec) { rec.stop(); return; }
  rec = new Speech();
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = navigator.language || 'en-US';
  const base = input.value.trim() ? input.value.replace(/\s*$/, ' ') : '';
  let said = '';
  rec.onresult = e => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) said += r[0].transcript; else interim += r[0].transcript;
    }
    input.value = base + said + interim;
    autosize();
  };
  rec.onerror = e => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') alert('ClaudeOS can\'t use the microphone. Allow it for this page (the icon at the right of the address bar, or Windows Settings → Privacy → Microphone).');
    else if (e.error === 'network') alert('Dictation needs the internet: the browser sends the audio to its speech service.');
  };
  rec.onend = () => { rec = null; micBtn.classList.remove('on'); micBtn.title = 'Dictate (click again to stop)'; input.focus(); };
  rec.start();
  micBtn.classList.add('on');
  micBtn.title = 'Listening… click to stop';
  input.focus();
});

// ---------- review comments on diffs ----------
enableReview(log);

events.addEventListener('chat', e => onEvent(JSON.parse(e.data)));
events.addEventListener('open', () => load()); // also re-syncs after a reconnect
events.addEventListener('brain', () => load()); // each brain has its own conversation
