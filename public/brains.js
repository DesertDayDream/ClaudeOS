// Brain switcher: switch between brains, create a new one, or set up an existing folder as one.
// On first run (no brains yet) it opens the welcome screen instead.
import { events } from '/events.js';

const TOKEN = window.CLAUDEOS_TOKEN;
const btn = document.getElementById('brainBtn');
const menu = document.getElementById('brainMenu');
const nameEl = document.getElementById('brainName');
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let current = null;
let list = [];

async function api(path, body) {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', 'x-claudeos-token': TOKEN },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res.json().catch(() => ({ error: `HTTP ${res.status}` }));
}

function toast(title, detail) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.innerHTML = `${esc(title)}${detail ? `<span>${esc(detail)}</span>` : ''}`;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 6000);
}

events.addEventListener('message', ev => {
  const s = JSON.parse(ev.data);
  current = s.brain && { ...s.brain, links: (s.brains || []).find(b => b.id === s.brain.id)?.links || [] };
  list = s.brains || [];
  btn.parentElement.hidden = !current;
  if (current) {
    nameEl.textContent = current.name;
    btn.title = current.path;
    document.title = `${current.name} · ClaudeOS`;
    if (modal?.dataset.kind === 'welcome') closeModal();
  } else {
    document.title = 'ClaudeOS';
    if (!modal) welcome();
  }
  if (!menu.hidden) renderMenu();
});

function renderMenu() {
  menu.innerHTML = list.map(b => `
    <div class="item" data-id="${esc(b.id)}" title="${esc(b.path)}">
      <span class="check">${b.id === current?.id ? '●' : ''}</span>
      <span class="nm">${esc(b.name)}${current?.links?.includes(b.id) ? ' <em class="lk">linked</em>' : ''}</span>
      <button class="rm" data-rm="${esc(b.id)}" title="Remove from this list (the folder stays)">×</button>
      <span class="pt">${esc(b.path)}</span>
    </div>`).join('') + `
    <hr>
    <button class="act" data-act="new">+ New brain<span>Create a new folder with an empty cloud</span></button>
    <button class="act" data-act="add">Add existing folder<span>Turn a folder you already have into a brain</span></button>
    ${list.length > 1 ? `<button class="act" data-act="link">Link brains…<span>Let ${esc(current?.name || 'this brain')} read another brain's memory, hand it work and copy its skills</span></button>` : ''}`;
}

function openMenu(open) {
  menu.hidden = !open;
  btn.setAttribute('aria-expanded', String(open));
  if (open) renderMenu();
}
btn.addEventListener('click', e => { e.stopPropagation(); openMenu(menu.hidden); });
document.addEventListener('click', e => { if (!menu.hidden && !menu.contains(e.target)) openMenu(false); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') { openMenu(false); if (modal?.dataset.kind !== 'welcome') closeModal(); } });

menu.addEventListener('click', async e => {
  const rm = e.target.closest('[data-rm]');
  if (rm) {
    e.stopPropagation();
    const b = list.find(x => x.id === rm.dataset.rm);
    if (!b || !confirm(`Remove "${b.name}" from your brains?\n\nOnly the list changes. The folder and everything in it stay on your PC, and you can add it back any time.`)) return;
    const r = await api('/api/brains/remove', { id: b.id });
    if (r.error) alert(r.error);
    return;
  }
  const act = e.target.closest('[data-act]');
  if (act) { openMenu(false); return act.dataset.act === 'new' ? newDialog() : act.dataset.act === 'link' ? linkDialog() : addDialog(); }
  const item = e.target.closest('.item');
  if (item && item.dataset.id !== current?.id) {
    openMenu(false);
    const r = await api('/api/brains/switch', { id: item.dataset.id });
    if (r.error) alert(r.error);
  }
});

// ---------- dialogs ----------
let modal = null;
function closeModal() { modal?.remove(); modal = null; if (!current && list.length === 0) welcome(); }
function showModal(html, kind) {
  modal?.remove();
  modal = document.createElement('div');
  modal.className = 'modal';
  modal.dataset.kind = kind;
  modal.innerHTML = `<div class="dialog" role="dialog" aria-modal="true">${html}</div>`;
  if (kind !== 'welcome') modal.addEventListener('mousedown', e => { if (e.target === modal) closeModal(); });
  document.body.appendChild(modal);
  return modal.querySelector('.dialog');
}

// A folder browser inside a dialog; calls onChange(dir) whenever the shown folder changes.
function folderBrowser(host, start, onChange) {
  host.innerHTML = `<div class="browser"><div class="where"><button type="button" class="btn" data-up>Up</button><code></code></div><div class="list"></div></div>`;
  const where = host.querySelector('code');
  const listEl = host.querySelector('.list');
  const up = host.querySelector('[data-up]');
  let parent = null;
  async function go(dir) {
    const r = await api('/api/fs?dir=' + encodeURIComponent(dir || ''));
    if (r.error) { listEl.innerHTML = `<div class="none">${esc(r.error)}</div>`; return; }
    parent = r.parent;
    up.disabled = r.parent === null;
    where.textContent = r.dir || 'Places';
    where.title = r.dir;
    listEl.innerHTML = r.folders.length ? r.folders.map(f => `<div class="f" data-path="${esc(f.path)}">${esc(f.name)}</div>`).join('')
      : '<div class="none">No folders inside.</div>';
    onChange(r.dir, r);
  }
  listEl.addEventListener('click', e => { const f = e.target.closest('.f'); if (f) go(f.dataset.path); });
  up.addEventListener('click', () => go(parent));
  go(start);
}

async function desktopPath() {
  const r = await api('/api/fs?dir=');
  return r.folders?.find(f => f.name === 'Desktop')?.path || r.folders?.[0]?.path || '';
}

const SUGGESTED = 'Brain';

// "New brain" dialog; with first: true it is the welcome screen a new install opens with.
async function newDialog({ first = false } = {}) {
  const d = showModal(`
    ${first
      ? `<h2>Welcome to ClaudeOS</h2>
         <p class="sub">ClaudeOS gives Claude a brain you can see: a cloud that fills with what it remembers, and a team of skills you can watch work. Start by making your first brain, a folder that holds its memory, its team and your chats.</p>
         <div class="note warn" id="nbHealth" hidden></div>`
      : `<h2>New brain</h2><p class="sub">A new folder with its own empty cloud, team and chat.</p>`}
    <label for="nbName">Name your ${first ? 'first ' : ''}brain</label>
    <input type="text" id="nbName" placeholder="${SUGGESTED}" maxlength="80" autocomplete="off">
    <label>Start with</label>
    <label class="choice"><input type="radio" name="tpl" value="blank" checked><div><b>Empty</b><span>A blank cloud and no team of its own yet. Hire employees by asking Claude to write skills.</span></div></label>
    <label class="choice"><input type="radio" name="tpl" value="creative"><div><b>Creative team</b><span>Six video skills (reel, pixel, quill, radar, relay, pulse) and starter brand rules. Video editing needs ffmpeg and Python.</span></div></label>
    <label>Create it inside</label>
    <div id="nbWhere"></div>
    <div class="note" id="nbPreview"></div>
    <div class="actions">
      <span class="msg-err" id="nbErr"></span>
      ${first ? '<button class="btn" data-existing>Use a folder I already have</button>' : '<button class="btn" data-cancel>Cancel</button>'}
      <button class="btn primary" id="nbGo">${first ? 'Create my first brain' : 'Create brain'}</button>
    </div>`, first ? 'welcome' : 'new');
  const nameIn = d.querySelector('#nbName');
  const preview = d.querySelector('#nbPreview');
  let parent = '';
  const name = () => nameIn.value.trim() || SUGGESTED;
  const update = () => { preview.textContent = parent ? `New folder: ${parent.replace(/[\\/]$/, '')}${parent.includes('/') && !parent.includes('\\') ? '/' : '\\'}${name()}` : ''; };
  nameIn.addEventListener('input', update);
  folderBrowser(d.querySelector('#nbWhere'), await desktopPath(), dir => { parent = dir; update(); });
  nameIn.focus();
  d.querySelector('[data-cancel]')?.addEventListener('click', closeModal);
  d.querySelector('[data-existing]')?.addEventListener('click', () => addDialog({ back: true }));
  if (first) {
    api('/api/health').then(h => {
      if (h.claude) return;
      const w = d.querySelector('#nbHealth');
      w.hidden = false;
      w.innerHTML = 'Claude Code isn\'t installed or isn\'t on your PATH, so the chat won\'t work yet. Install it from <a href="https://claude.com/claude-code" target="_blank" rel="noopener">claude.com/claude-code</a>, run <code>claude</code> once to log in, then reload this page. You can still set up your brain now.';
    });
  }
  d.querySelector('#nbGo').onclick = async () => {
    const err = d.querySelector('#nbErr');
    if (!parent) { err.textContent = 'Open the folder to create it in first.'; return; }
    const r = await api('/api/brains/create', { name: name(), parent, template: d.querySelector('input[name=tpl]:checked').value });
    if (r.error) { err.textContent = r.error; return; }
    modal?.remove(); modal = null;
    toast(first ? `Your first brain is ready: ${r.brain.name}` : `Switched to ${r.brain.name}`, `Created ${r.brain.path}`);
  };
}
const welcome = () => newDialog({ first: true });

// Which other brains the current one is linked to. A link goes one way: this brain gets to use the other.
function linkDialog() {
  const others = list.filter(b => b.id !== current.id);
  const d = showModal(`
    <h2>Link brains to ${esc(current.name)}</h2>
    <p class="sub">A linked brain stays its own folder. ${esc(current.name)} can:</p>
    <ul class="sub">
      <li><b>read its memory</b>: Claude here can search it, but never changes it. Its dots float beside this cloud.</li>
      <li><b>hand its team work</b>: the task runs in that brain, with its memory and skills, and the answer comes back to this chat.</li>
      <li><b>copy its skills</b>: from the Team tab, to hire the same employee here.</li>
    </ul>
    ${others.map(b => `<label class="choice"><input type="checkbox" value="${esc(b.id)}" ${current.links.includes(b.id) ? 'checked' : ''}><div><b>${esc(b.name)}</b><span>${esc(b.path)}</span></div></label>`).join('')}
    <div class="actions"><span class="msg-err" id="lkErr"></span><button class="btn" data-cancel>Cancel</button><button class="btn primary" id="lkGo">Save links</button></div>`, 'link');
  d.querySelector('[data-cancel]').onclick = closeModal;
  d.querySelector('#lkGo').onclick = async () => {
    const links = [...d.querySelectorAll('input:checked')].map(i => i.value);
    const r = await api('/api/brains/links', { id: current.id, links });
    if (r.error) { d.querySelector('#lkErr').textContent = r.error; return; }
    closeModal();
    toast(links.length ? `${current.name} is linked to ${links.length} brain${links.length > 1 ? 's' : ''}` : `${current.name} has no links now`,
      links.length ? 'Claude can use them from your next message.' : '');
  };
}

async function addDialog({ back = false } = {}) {
  const d = showModal(`
    <h2>Add existing folder</h2>
    <p class="sub">Open the folder you want, then press "Use this folder". ClaudeOS adds only what's missing
      (<code>brain/memory.jsonl</code>, <code>.mcp.json</code>, <code>CLAUDE.md</code>, <code>AGENTS.md</code>, hooks in <code>.claude/settings.json</code>) and never overwrites or deletes your files.</p>
    <div id="afWhere"></div>
    <div class="note" id="afNote"></div>
    <div class="actions"><span class="msg-err" id="afErr"></span><button class="btn" data-cancel>${back ? 'Back' : 'Cancel'}</button><button class="btn primary" id="afGo" disabled>Use this folder</button></div>`, 'add');
  let dir = '';
  const go = d.querySelector('#afGo');
  folderBrowser(d.querySelector('#afWhere'), await desktopPath(), (p, r) => {
    dir = p;
    go.disabled = !p;
    d.querySelector('#afNote').textContent = !p ? '' : r.isBrain ? 'This folder already has a brain. Adding it keeps its memory as it is.' : 'This folder will become a brain with an empty cloud.';
  });
  d.querySelector('[data-cancel]').onclick = closeModal;
  go.onclick = async () => {
    const r = await api('/api/brains/add', { folder: dir });
    if (r.error) { d.querySelector('#afErr').textContent = r.error; return; }
    modal?.remove(); modal = null;
    toast(`Switched to ${r.brain.name}`, r.created?.length ? `Added: ${r.created.join(', ')}` : 'Nothing needed adding.');
  };
}
