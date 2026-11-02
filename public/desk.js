import { events } from '/events.js';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
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

// ---------- Panel width ----------
// the panel's left edge drags wider (handy for the terminal and diffs); remembered on this PC
const grip = document.getElementById('asideGrip');
const setWidth = w => { if (w) document.documentElement.style.setProperty('--aside-w', `${w}px`); else document.documentElement.style.removeProperty('--aside-w'); };
setWidth(Number(localStorage.getItem('claudeos.asideWidth')) || 0);
grip.addEventListener('pointerdown', e => {
  e.preventDefault();
  grip.setPointerCapture(e.pointerId);
  grip.classList.add('drag');
  const move = ev => setWidth(Math.round(Math.max(320, Math.min(innerWidth - 120, innerWidth - 16 - ev.clientX))));
  const up = () => {
    grip.classList.remove('drag');
    grip.removeEventListener('pointermove', move);
    localStorage.setItem('claudeos.asideWidth', parseInt(getComputedStyle(document.documentElement).getPropertyValue('--aside-w')) || '');
  };
  grip.addEventListener('pointermove', move);
  grip.addEventListener('pointerup', up, { once: true });
});
grip.addEventListener('dblclick', () => { setWidth(0); localStorage.removeItem('claudeos.asideWidth'); });

// ---------- Terminal ----------
// Each tab is a real console on the server (ConPTY); here xterm.js draws it and sends your keys, so
// vim, less, htop, colours, Tab completion and Ctrl+C work as in any terminal.
const tabsEl = document.getElementById('termTabs');
const screensEl = document.getElementById('termScreens');
const stopEl = document.getElementById('termStop');
let tabs = [];           // { id, title, cwd, running, by, command, code, alive }
const terms = new Map(); // id -> { term, fit, el, seq, sending, queue }
let shown = null;
const loads = new Set(); // events that arrive while a snapshot loads wait here
let loadNo = 0;
const THEME = { background: '#0a0c16', foreground: '#e8eaf6', cursor: '#d97757', cursorAccent: '#0a0c16', selectionBackground: 'rgba(217,119,87,0.35)',
  black: '#1b1e2e', brightBlack: '#5a6080', red: '#ff6b81', brightRed: '#ff8fa0', green: '#5fd47a', brightGreen: '#8af0a0', yellow: '#ffc861', brightYellow: '#ffdb8f',
  blue: '#6ea8ff', brightBlue: '#9cc4ff', magenta: '#c9a7ff', brightMagenta: '#dcc6ff', cyan: '#5fd4ff', brightCyan: '#92e4ff', white: '#c8cbe0', brightWhite: '#ffffff' };

function termFor(id, size = {}) {
  let x = terms.get(id);
  if (x) return x;
  const el = document.createElement('div');
  el.className = 'termscreen';
  el.hidden = id !== shown;
  screensEl.append(el);
  const term = new Terminal({ cols: size.cols || 100, rows: size.rows || 30, scrollback: 5000, cursorBlink: true, allowProposedApi: true,
    fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, ui-monospace, monospace', fontSize: 12.5, lineHeight: 1.15, theme: THEME });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon((e, uri) => window.open(uri, '_blank', 'noopener')));
  term.open(el);
  x = { term, fit, el, seq: 0, sending: Promise.resolve(), queue: '' };
  terms.set(id, x);
  // Ctrl+C copies when something is selected (else it's Ctrl+C for the program); Ctrl+V pastes
  term.attachCustomKeyEventHandler(e => {
    if (e.type !== 'keydown' || !e.ctrlKey || e.altKey) return true;
    const k = e.key.toLowerCase();
    if (k === 'c' && term.hasSelection()) { navigator.clipboard.writeText(term.getSelection()); term.clearSelection(); return false; }
    if (k === 'v' && !e.shiftKey) return false; // the browser's paste event reaches the terminal
    return true;
  });
  // keys go to the server in order; what's typed while one send is on its way goes in the next
  term.onData(d => {
    x.queue += d;
    x.sending = x.sending.then(() => {
      if (!x.queue) return;
      const data = x.queue; x.queue = '';
      return api('/api/terminal/input', { tab: id, data });
    });
  });
  let resizing;
  term.onResize(({ cols, rows }) => { clearTimeout(resizing); resizing = setTimeout(() => api('/api/terminal/resize', { tab: id, cols, rows }), 80); });
  return x;
}
function dropTerm(id) {
  const x = terms.get(id);
  if (!x) return;
  x.term.dispose(); x.el.remove(); terms.delete(id);
}
function fitShown() {
  const x = shown && terms.get(shown);
  if (x && !x.el.hidden && screensEl.clientWidth > 0) { try { x.fit.fit(); } catch { /* not laid out yet */ } }
}
new ResizeObserver(() => fitShown()).observe(screensEl);

function drawTabs() {
  if (shown && !tabs.some(t => t.id === shown)) shown = null;
  shown ||= tabs.at(-1)?.id || null;
  for (const id of [...terms.keys()]) if (!tabs.some(t => t.id === id)) dropTerm(id);
  tabsEl.innerHTML = tabs.map(t => `<button type="button" data-id="${t.id}" class="${t.id === shown ? 'on' : ''}" title="${esc(`${t.cwd}${t.command ? `\n${t.running ? 'Running' : 'Last'}: ${t.command}` : ''}${t.code ? `\nExited with code ${t.code}` : ''}${t.by === 'Claude' ? '\nStarted by Claude' : ''}`)}">
    <i class="${t.running ? 'busy' : t.code ? 'fail' : ''}"></i>${esc(t.title)}<em data-close="${t.id}" title="Close">×</em></button>`).join('');
  screensEl.classList.toggle('none', !tabs.length);
  for (const [id, x] of terms) x.el.hidden = id !== shown;
  stopEl.disabled = !tabs.find(x => x.id === shown)?.running;
  const x = shown && terms.get(shown);
  if (x) { fitShown(); if (showing('term')) x.term.focus(); }
}
async function loadTerminals() {
  const no = ++loadNo, waiting = [];
  loads.add(waiting);
  const s = await api('/api/terminals');
  loads.delete(waiting);
  if (s.error || no !== loadNo) return; // a newer load (after a reconnect) has it
  for (const id of [...terms.keys()]) dropTerm(id);
  tabs = s.tabs.map(({ screen, seq, cols, rows, ...t }) => t);
  for (const t of s.tabs) { const x = termFor(t.id, t); x.term.write(t.screen); x.seq = t.seq; }
  for (const ev of waiting) onOut(ev);
  drawTabs();
}
function onOut(ev) {
  const x = termFor(ev.id);
  if (ev.seq <= x.seq) return; // already in the snapshot
  x.seq = ev.seq;
  x.term.write(ev.data);
}
async function newTab() {
  const x = shown && terms.get(shown);
  const r = await api('/api/terminal/open', x ? { cols: x.term.cols, rows: x.term.rows } : {});
  if (r.error) return alert(r.error);
  shown = r.tab.id;
  drawTabs();
}
tabsEl.addEventListener('click', async e => {
  const close = e.target.closest('[data-close]')?.dataset.close;
  if (close) { e.stopPropagation(); return api('/api/terminal/close', { tab: close }); }
  const id = e.target.closest('button')?.dataset.id;
  if (id) { shown = id; drawTabs(); }
});
document.getElementById('termNew').addEventListener('click', newTab);
screensEl.addEventListener('click', () => { if (!tabs.length) newTab(); });
stopEl.addEventListener('click', () => shown && api('/api/terminal/stop', { tab: shown }));
// the Terminal tab opened: its screen has a size now, and takes the keys
tabBtn('term').addEventListener('click', () => requestAnimationFrame(() => { fitShown(); terms.get(shown)?.term.focus(); }));
events.addEventListener('terminal', e => {
  const ev = JSON.parse(e.data);
  if (ev.kind === 'out') { if (loads.size) for (const w of loads) w.push(ev); else onOut(ev); return; }
  if (ev.kind === 'tabs') {
    const fresh = ev.tabs.find(t => !tabs.some(x => x.id === t.id));
    tabs = ev.tabs;
    // a new tab: show it, and mark the Terminal tab if Claude opened it while you're elsewhere
    if (fresh) { shown = fresh.id; termFor(fresh.id); if (fresh.by === 'Claude' && !showing('term')) tabBtn('term').classList.add('ping'); }
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
