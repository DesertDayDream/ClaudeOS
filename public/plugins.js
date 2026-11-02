// The Plugins panel: browse the plugins of your marketplaces (Anthropic's official one and any you
// add), install, uninstall, turn on and off. Opens from the Apps panel's Plugins button or /plugins.
import { events } from '/events.js';

const TOKEN = window.CLAUDEOS_TOKEN;
const panel = document.getElementById('plugins');
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
async function api(p, body) {
  const res = await fetch(p, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', 'x-claudeos-token': TOKEN }, body: body === undefined ? undefined : JSON.stringify(body) });
  return res.json().catch(() => ({ error: `HTTP ${res.status}` }));
}
let data = null, q = '', market = '', only = 'all', busy = new Set(), shown = 150;
const kNum = n => n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n);

function matches() {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  return (data?.plugins || []).filter(p => (!market || p.marketplace === market) && (only === 'all' || (only === 'installed' ? p.installed : !p.installed))
      && words.every(w => `${p.name} ${p.description} ${p.marketplace}`.toLowerCase().includes(w)))
    .sort((a, b) => (b.installed - a.installed) || (b.installs - a.installs) || a.name.localeCompare(b.name));
}
function drawList() {
  const list = panel.querySelector('.pl-list');
  if (!list) return;
  if (!data) { list.innerHTML = '<div class="empty">Asking Claude Code for its plugins…</div>'; return; }
  if (data.error) { list.innerHTML = `<div class="empty">${esc(data.error)}</div>`; return; }
  const all = matches();
  panel.querySelector('.pl-count').textContent = `${all.length.toLocaleString()} plugin${all.length === 1 ? '' : 's'}${all.length > shown ? ` · showing ${shown}` : ''}`;
  list.innerHTML = all.length ? all.slice(0, shown).map(p => {
    const b = busy.has(p.id);
    const acts = p.installed
      ? `<label class="pl-on" title="${p.enabled ? 'On: Claude can use it' : 'Off: installed but not loaded'}"><input type="checkbox" data-pl="toggle" ${p.enabled ? 'checked' : ''} ${b ? 'disabled' : ''}> ${p.enabled ? 'On' : 'Off'}</label><button type="button" class="btn mini danger" data-pl="uninstall" ${b ? 'disabled' : ''}>${b ? '…' : 'Uninstall'}</button>`
      : `<button type="button" class="btn mini primary" data-pl="install" ${b ? 'disabled' : ''}>${b ? 'Installing…' : 'Install'}</button>`;
    return `<div class="pl-row${p.installed ? ' have' : ''}" data-id="${esc(p.id)}"><div class="pl-t"><b>${esc(p.name)}</b><span>${esc(p.marketplace)}${p.installs ? ` · ${kNum(p.installs)} installs` : ''}${p.version ? ` · v${esc(p.version)}` : ''}${p.mcp?.length ? ` · MCP: ${esc(p.mcp.join(', '))}` : ''}</span>
      ${p.description ? `<p title="${esc(p.description)}">${esc(p.description)}</p>` : ''}</div><div class="pl-acts">${acts}</div></div>`;
  }).join('') + (all.length > shown ? '<button type="button" class="btn mini pl-more" data-pl="more">Show more</button>' : '')
    : `<div class="empty">No plugin matches${q ? ` “${esc(q)}”` : ''}.</div>`;
}
function draw() {
  const mk = data?.marketplaces || [];
  panel.innerHTML = `<div class="pv-head"><b>Plugins</b><span class="pl-count"></span>
      <button type="button" class="btn mini" data-pl="refresh" title="Ask the marketplaces again">↻</button><button type="button" class="btn mini" data-pl="close" title="Close (Esc)">✕</button></div>
    <div class="pl-bar"><input type="search" class="pl-q" placeholder="Search plugins: skills, MCP servers, commands, agents…" value="${esc(q)}" spellcheck="false">
      <select class="pl-m" title="Marketplace"><option value="">All marketplaces</option>${mk.map(m => `<option value="${esc(m.name)}"${m.name === market ? ' selected' : ''}>${esc(m.name)}</option>`).join('')}</select>
      <select class="pl-f"><option value="all"${only === 'all' ? ' selected' : ''}>All</option><option value="installed"${only === 'installed' ? ' selected' : ''}>Installed</option><option value="new"${only === 'new' ? ' selected' : ''}>Not installed</option></select></div>
    <div class="pl-note">Plugins add skills, commands, agents and MCP servers to Claude Code everywhere (your user settings). A chat picks them up at its next message. Only install plugins from sources you trust: they run on your PC.</div>
    <div class="pl-list"></div>
    <details class="pl-mk"><summary>Marketplaces · ${mk.length}</summary>
      ${mk.map(m => `<div class="pl-mrow" data-name="${esc(m.name)}"><b>${esc(m.name)}</b><span>${esc(m.source || '')}</span><button type="button" class="btn mini" data-pl="mk-update">Update</button><button type="button" class="btn mini danger" data-pl="mk-remove">Remove</button></div>`).join('')}
      <form class="pl-add"><input name="source" placeholder="Add a marketplace: owner/repo, a git URL, or a folder" spellcheck="false"><button class="btn mini" type="submit">Add</button></form></details>`;
  drawList();
}
async function load(fresh = false) {
  if (fresh) { data = null; draw(); }
  const r = await api(`/api/plugins${fresh ? '?fresh=1' : ''}`);
  data = r;
  if (!panel.hidden) { const typing = document.activeElement?.classList.contains('pl-q'); draw(); if (typing) { const i = panel.querySelector('.pl-q'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }
}
export function openPlugins() {
  panel.hidden = false;
  document.body.classList.add('plugins-open');
  draw();
  load();
  panel.querySelector('.pl-q')?.focus();
}
function close() { panel.hidden = true; document.body.classList.remove('plugins-open'); }
document.addEventListener('claudeos:plugins', openPlugins);

let qTimer = 0;
panel.addEventListener('input', e => {
  if (!e.target.classList.contains('pl-q')) return;
  clearTimeout(qTimer);
  qTimer = setTimeout(() => { q = e.target.value; shown = 150; drawList(); }, 120);
});
panel.addEventListener('change', async e => {
  if (e.target.classList.contains('pl-m')) { market = e.target.value; shown = 150; return drawList(); }
  if (e.target.classList.contains('pl-f')) { only = e.target.value; shown = 150; return drawList(); }
  if (e.target.dataset.pl === 'toggle') {
    const id = e.target.closest('[data-id]').dataset.id;
    busy.add(id); drawList();
    const r = await api(`/api/plugins/${e.target.checked ? 'enable' : 'disable'}`, { id });
    busy.delete(id);
    if (r.error) alert(r.error);
    load();
  }
});
async function install(id, accept = '') {
  busy.add(id); drawList();
  const r = await api('/api/plugins/install', { id, accept });
  busy.delete(id);
  if (r.confirm) {
    drawList();
    if (confirm(`To install ${id}, its marketplace runs this command on your PC:\n\n${r.confirm.command}\n\n${r.confirm.message || ''}\nOnly allow it if you trust where it comes from. Run it?`)) return install(id, r.confirm.sha256);
    return;
  }
  if (r.error) { drawList(); return alert(r.error); }
  load();
}
panel.addEventListener('click', async e => {
  const b = e.target.closest('[data-pl]');
  if (!b) return;
  const act = b.dataset.pl, id = b.closest('[data-id]')?.dataset.id, name = b.closest('[data-name]')?.dataset.name;
  if (act === 'close') return close();
  if (act === 'refresh') return load(true);
  if (act === 'more') { shown += 300; return drawList(); }
  if (act === 'install') return install(id);
  if (act === 'uninstall') {
    if (!confirm(`Uninstall ${id}? Its skills, commands and MCP servers go away from Claude Code.`)) return;
    busy.add(id); drawList();
    const r = await api('/api/plugins/uninstall', { id });
    busy.delete(id);
    if (r.error) alert(r.error);
    return load();
  }
  if (act === 'mk-update' || act === 'mk-remove') {
    if (act === 'mk-remove' && !confirm(`Remove the marketplace ${name}? Plugins installed from it stay until you uninstall them.`)) return;
    b.disabled = true; b.textContent = '…';
    const r = await api('/api/plugins/marketplace', { act: act.slice(3), name });
    if (r.error) alert(r.error);
    return load(true);
  }
});
panel.addEventListener('submit', async e => {
  e.preventDefault();
  const source = e.target.source.value.trim();
  if (!source) return;
  const btn = e.target.querySelector('button');
  btn.disabled = true; btn.textContent = 'Adding…';
  const r = await api('/api/plugins/marketplace', { act: 'add', source });
  if (r.error) { btn.disabled = false; btn.textContent = 'Add'; return alert(r.error); }
  load(true);
});
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !panel.hidden && !e.target.closest('textarea')) close(); });
events.addEventListener('plugins', () => { if (!panel.hidden) load(); });
