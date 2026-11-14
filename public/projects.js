import { events } from '/events.js';

// The brain's projects (Projects/<Name>/PROJECT.md), as buttons beside the team in the 3D view. A click opens
// a chat that works on that project only: its sheet in the instructions, its folder added. ▾ shows its chats.
const TOKEN = window.CLAUDEOS_TOKEN;
const bar = document.getElementById('projectBar');
let list = [], openMenu = null, timer = null;

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
async function api(path, body) {
  const res = await fetch(path, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', 'x-claudeos-token': TOKEN }, body: body === undefined ? undefined : JSON.stringify(body) });
  return res.json().catch(() => ({ error: `HTTP ${res.status}` }));
}
// one colour per project, the same every time
function hue(name) { let h = 0; for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }
function ago(t) {
  const m = Math.round((Date.now() - t) / 60000);
  return m < 1 ? 'now' : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
}

function render() {
  bar.hidden = !list.length;
  if (!list.length) return;
  bar.innerHTML = `<div class="pj-h">Projects</div>` + list.map(p => `
    <div class="pj ${p.busy ? 'busy' : ''}" data-id="${esc(p.id)}" style="--h:${hue(p.id)}">
      <button type="button" class="pj-go" title="Work on ${esc(p.name)}: a chat with its project sheet${p.folder ? ` and its folder (${esc(p.folder)})` : ''}">
        <i></i><b>${esc(p.name)}</b><small>${esc(p.status || 'Project')}${p.count ? ` · ${p.count} chat${p.count > 1 ? 's' : ''}` : ''}</small>
      </button>
      ${p.count ? `<button type="button" class="pj-more" title="${esc(p.name)} chats" aria-expanded="${openMenu === p.id}">▾</button>` : ''}
      ${openMenu === p.id ? `<div class="pj-menu">${p.chats.map(c => `<button type="button" data-chat="${esc(c.id)}">${c.busy ? '● ' : ''}${esc(c.title)}<small>${ago(c.updated)}</small></button>`).join('')}
        <button type="button" data-new="1">+ New ${esc(p.name)} chat</button></div>` : ''}
    </div>`).join('');
}

async function refresh() {
  const r = await api('/api/chat/projects');
  if (r.error) return;
  list = r.projects || [];
  if (openMenu && !list.some(p => p.id === openMenu)) openMenu = null;
  render();
}
const soon = () => { clearTimeout(timer); timer = setTimeout(refresh, 400); };

function showChat() {
  document.body.classList.add('ops-chat');
  const t = document.getElementById('opsChatToggle');
  if (t) { t.setAttribute('aria-expanded', 'true'); t.textContent = 'Return to workspace'; }
  document.getElementById('input')?.focus();
}

bar.addEventListener('click', async e => {
  const card = e.target.closest('.pj');
  if (!card) return;
  const id = card.dataset.id;
  if (e.target.closest('.pj-more')) { openMenu = openMenu === id ? null : id; render(); return; }
  const chatBtn = e.target.closest('[data-chat]');
  const r = chatBtn ? await api('/api/chats/open', { id: chatBtn.dataset.chat }) : await api('/api/chat/project', { id });
  if (r.error) return alert(r.error);
  openMenu = null;
  render();
  showChat();
});
document.addEventListener('click', e => { if (openMenu && !e.target.closest('#projectBar')) { openMenu = null; render(); } });

events.addEventListener('chat', e => { const ev = JSON.parse(e.data); if (ev.kind === 'list' || ev.kind === 'busy') soon(); });
events.addEventListener('brain', soon);
refresh();
