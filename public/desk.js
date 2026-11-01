import { events } from '/events.js';
// The Terminal tab (shell tabs you and Claude share) and the Artifacts tab (pages Claude published).
const TOKEN = window.CLAUDEOS_TOKEN;
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
async function api(path, body) {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', 'x-claudeos-token': TOKEN },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res.json().catch(() => ({ error: `HTTP ${res.status}` }));
}
const tabBtn = name => document.querySelector(`aside header [data-tab="${name}"]`);
const showing = name => tabBtn(name).getAttribute('aria-selected') === 'true';
for (const name of ['term', 'arts']) tabBtn(name).addEventListener('click', () => tabBtn(name).classList.remove('ping'));

// ---------- Terminal ----------
const tabsEl = document.getElementById('termTabs');
const outEl = document.getElementById('termOut');
const inputEl = document.getElementById('termInput');
let tabs = [];          // { id, title, cwd, running, by, command, code }
const outs = new Map(); // id -> output text
let shown = null;

function drawTabs() {
  if (shown && !tabs.some(t => t.id === shown)) shown = null;
  shown ||= tabs.at(-1)?.id || null;
  tabsEl.innerHTML = tabs.map(t => `<button type="button" data-id="${t.id}" class="${t.id === shown ? 'on' : ''}" title="${esc(`${t.cwd}${t.command ? `\n${t.command}` : ''}${t.by === 'Claude' ? '\nStarted by Claude' : ''}`)}">
    <i class="${t.running ? 'run' : ''}"></i>${esc(t.title)}<em data-close="${t.id}" title="Close">×</em></button>`).join('') || '<span class="hint" style="color:var(--dim);font-size:12px">No terminals yet. Type a command below, or Claude opens one for a dev server or a build.</span>';
  const t = tabs.find(x => x.id === shown);
  inputEl.placeholder = t ? (t.running ? `Running: ${t.command} · type to answer it, Ctrl+C stops it` : `PS ${t.cwd}>  (the shell keeps cd and variables)`) : 'Run a command in this chat\'s folder…';
  document.getElementById('termStop').disabled = !t?.running;
  drawOut();
}
function drawOut() {
  const stick = outEl.scrollHeight - outEl.scrollTop - outEl.clientHeight < 40;
  outEl.textContent = shown ? outs.get(shown) || '' : '';
  if (stick) outEl.scrollTop = outEl.scrollHeight;
}
async function loadTerminals() {
  const s = await api('/api/terminals');
  if (s.error) return;
  tabs = s.tabs.map(({ out, ...t }) => t);
  for (const t of s.tabs) outs.set(t.id, t.out);
  drawTabs();
}
tabsEl.addEventListener('click', async e => {
  const close = e.target.closest('[data-close]')?.dataset.close;
  if (close) { e.stopPropagation(); return api('/api/terminal/close', { tab: close }); }
  const id = e.target.closest('button')?.dataset.id;
  if (id) { shown = id; drawTabs(); inputEl.focus(); }
});
document.getElementById('termNew').addEventListener('click', async () => {
  const r = await api('/api/terminal/open', {});
  if (r.error) return alert(r.error);
  shown = r.tab.id;
  inputEl.focus();
});
document.getElementById('termStop').addEventListener('click', () => shown && api('/api/terminal/stop', { tab: shown }));
document.getElementById('termForm').addEventListener('submit', async e => {
  e.preventDefault();
  const t = tabs.find(x => x.id === shown);
  // while a command runs, what you type is its input (Enter alone answers a prompt with nothing)
  if (t?.running) {
    const r = await api('/api/terminal/input', { tab: t.id, text: inputEl.value });
    if (r.error) return alert(r.error);
    inputEl.value = '';
    return;
  }
  const command = inputEl.value.trim();
  if (!command) return;
  const r = await api('/api/terminal/run', { command, tab: t?.id });
  if (r.error) return alert(r.error);
  if (history.at(-1) !== command) history.push(command);
  back = history.length;
  inputEl.value = '';
  shown = r.tab.id;
});
// Up and Down walk back through the commands you ran
const history = [];
let back = 0;
inputEl.addEventListener('keydown', e => {
  if (e.key === 'c' && e.ctrlKey && !inputEl.selectionEnd && shown) { e.preventDefault(); api('/api/terminal/stop', { tab: shown }); }
  if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && history.length && !tabs.find(x => x.id === shown)?.running) {
    e.preventDefault();
    back = Math.max(0, Math.min(history.length, back + (e.key === 'ArrowUp' ? -1 : 1)));
    inputEl.value = history[back] || '';
  }
});
events.addEventListener('terminal', e => {
  const ev = JSON.parse(e.data);
  if (ev.kind === 'out') {
    outs.set(ev.id, ((outs.get(ev.id) || '') + ev.text).slice(-200000));
    if (ev.id === shown) drawOut();
  } else if (ev.kind === 'tabs') {
    const fresh = ev.tabs.find(t => !tabs.some(x => x.id === t.id));
    tabs = ev.tabs;
    // Claude opened a terminal: show it, and mark the tab if you're elsewhere
    if (fresh) { shown = fresh.id; if (fresh.by === 'Claude' && !showing('term')) tabBtn('term').classList.add('ping'); }
    drawTabs();
  }
});

// ---------- Artifacts ----------
const artsEl = document.getElementById('arts');
let arts = [];
function ago(ts) {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(ts).toLocaleDateString();
}
function drawArts() {
  artsEl.innerHTML = arts.length ? arts.map(a => `<div class="art">
      <iframe src="${esc(a.url)}" title="${esc(a.title)}"></iframe>
      <div class="meta"><div><b>${esc(a.title)}</b><span>${esc(a.description || '')}${a.description ? ' · ' : ''}${ago(a.updated)}${a.version > 1 ? ` · v${a.version}` : ''}</span></div>
        <a class="btn mini" href="${esc(a.url)}" target="_blank" rel="noopener">Open</a><button type="button" class="btn mini" data-del="${a.id}" title="Delete (goes to ~/.claudeos/artifacts/trash)">×</button></div>
    </div>`).join('')
    : '<div class="empty">No artifacts yet. When a page is clearer than chat text (a report, a dashboard, a mock-up, a small tool), Claude publishes it here. You can also just ask: “make that an artifact”.</div>';
}
async function loadArts() {
  const r = await api('/api/artifacts');
  if (r.error) return;
  arts = r.list;
  drawArts();
}
artsEl.addEventListener('click', async e => {
  const id = e.target.closest('[data-del]')?.dataset.del;
  if (!id || !confirm(`Delete “${arts.find(a => a.id === id)?.title}”?`)) return;
  const r = await api('/api/artifacts/delete', { id });
  if (r.error) alert(r.error);
});
events.addEventListener('artifacts', e => {
  const ev = JSON.parse(e.data);
  arts = ev.list;
  drawArts();
  if (ev.id && !showing('arts')) tabBtn('arts').classList.add('ping');
});

events.addEventListener('open', () => { loadTerminals(); loadArts(); }); // also after a reconnect
loadTerminals();
loadArts();
