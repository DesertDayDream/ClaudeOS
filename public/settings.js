// The ⚙ menu (own window, hotkey, notifications, start with Windows, installing a new build) and the notifications
// themselves: the server sends 'notify' when an answer lands or Claude needs a yes, and the page
// shows it only while you are looking elsewhere. With no page open, the tray shows it instead.
import { events } from '/events.js';

const TOKEN = window.CLAUDEOS_TOKEN;
const btn = document.getElementById('settingsBtn');
const menu = document.getElementById('settingsMenu');
let settings = null, update = null;

async function api(path, body) {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', 'x-claudeos-token': TOKEN },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res.json().catch(() => ({ error: `HTTP ${res.status}` }));
}
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const canNotify = 'Notification' in window;

function draw() {
  const s = settings;
  if (!s) return;
  const perm = canNotify ? Notification.permission : 'denied';
  const notifyNote = !s.notify ? 'Off'
    : perm === 'granted' ? 'When an answer lands or Claude needs your OK while you are elsewhere'
    : perm === 'default' ? '<button type="button" class="btn mini" data-act="allow">Allow in this window</button> (otherwise only the tray shows them)'
    : 'Blocked by the browser: only the tray shows them';
  const hk = !s.hotkey ? 'Off'
    : !s.tray ? 'Works in ClaudeOS.exe (the tray listens for it)'
    : s.hotkeyOk === false ? `<b class="bad">Another app already uses ${esc(s.hotkey)}.</b> Pick another.`
    : s.hotkeyOk ? `Press ${esc(s.hotkey)} anywhere to bring ClaudeOS back` : 'Setting up…';
  menu.innerHTML = `
    <label><input type="checkbox" data-set="appWindow" ${s.appWindow ? 'checked' : ''}> <b>Open in its own window</b><span>An app window (Edge or Chrome) instead of a browser tab</span></label>
    <label><input type="checkbox" data-set="notify" ${s.notify ? 'checked' : ''}> <b>Notifications</b><span>${notifyNote}</span></label>
    <div class="row"><b>Hotkey</b><input type="text" id="hotkeyInput" value="${esc(s.hotkey)}" placeholder="Off" spellcheck="false" title="Like Ctrl+Alt+O or Ctrl+Shift+K. Empty turns it off. Click it and press the keys."><span>${hk}</span></div>
    ${updateRow()}
    <label class="${s.canStartAtLogin ? '' : 'off'}"><input type="checkbox" data-set="startAtLogin" ${s.startAtLogin ? 'checked' : ''} ${s.canStartAtLogin ? '' : 'disabled'}> <b>Start with Windows</b><span>${s.canStartAtLogin ? 'In the tray when you sign in, no window until you ask' : 'Works in ClaudeOS.exe'}</span></label>`;
}

// a new build beside ClaudeOS.exe (Claude makes it with npm run build:exe -- dist/ClaudeOS.new.exe)
function updateRow() {
  const u = update;
  if (!u) return '';
  const when = t => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const note = !u.canUpdate ? 'ClaudeOS.exe installs new builds of itself; from the app folder, restart node server.mjs'
    : u.pending ? 'Restarting as soon as every chat is done… <button type="button" class="btn mini" data-act="update-cancel">Cancel</button>'
    : u.ready ? `A new build is ready (built ${when(u.ready.built)}). <button type="button" class="btn mini primary" data-act="update">Restart to update</button>`
    : `Up to date (build ${esc(u.build)})`;
  return `<div class="row"><b>Update</b><span>${note}</span></div>`;
}
async function load() {
  [settings, update] = await Promise.all([api('/api/settings'), api('/api/update')]);
  btn.classList.toggle('ping', !!update?.ready);
  draw();
}
async function change(patch) {
  const r = await api('/api/settings', patch);
  if (r.error) { alert(r.error); return load(); }
  settings = r; draw();
}

btn.addEventListener('click', e => { e.stopPropagation(); menu.hidden = !menu.hidden; if (!menu.hidden) load(); });
document.addEventListener('click', e => { if (!menu.hidden && !menu.contains(e.target) && e.target !== btn) menu.hidden = true; });
menu.addEventListener('change', e => {
  const k = e.target.dataset.set;
  if (!k) return;
  change({ [k]: e.target.checked });
  if (k === 'notify' && e.target.checked && canNotify && Notification.permission === 'default') Notification.requestPermission().then(draw);
});
menu.addEventListener('click', e => {
  if (e.target.dataset.act === 'allow') Notification.requestPermission().then(draw);
  if (e.target.dataset.act === 'update') api('/api/update', {}).then(r => { if (r.error) alert(r.error); load(); });
  if (e.target.dataset.act === 'update-cancel') api('/api/update', { cancel: true }).then(load);
});
// the hotkey box records the keys you press, so you don't have to spell them
menu.addEventListener('keydown', e => {
  if (e.target.id !== 'hotkeyInput') return;
  if (e.key === 'Tab') return;
  e.preventDefault();
  if (e.key === 'Escape') { menu.hidden = true; return; }
  if (e.key === 'Backspace' || e.key === 'Delete') { e.target.value = ''; return change({ hotkey: '' }); }
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return;
  const key = e.code === 'Space' ? 'Space' : /^Key[A-Z]$/.test(e.code) ? e.code.slice(3) : /^Digit\d$/.test(e.code) ? e.code.slice(5) : /^F\d+$/.test(e.code) ? e.code : '';
  const mods = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Win'].filter(Boolean);
  if (!key || !mods.length) return;
  e.target.value = [...mods, key].join('+');
  change({ hotkey: e.target.value });
});
events.addEventListener('settings', () => { if (!menu.hidden) load(); });

// ---------- notifications ----------
// the browser asks once, on your first click, so they work without visiting the menu
document.addEventListener('pointerdown', function ask() {
  document.removeEventListener('pointerdown', ask);
  if (canNotify && Notification.permission === 'default') Notification.requestPermission();
});
events.addEventListener('notify', e => {
  const n = JSON.parse(e.data);
  if (!document.hidden && document.hasFocus()) return; // you are looking at it already
  if (!canNotify || Notification.permission !== 'granted') return;
  const note = new Notification(n.title, { body: n.body, icon: '/favicon.png', tag: n.chat || 'claudeos' });
  note.onclick = () => {
    window.focus();
    note.close();
    if (n.chat && !n.chat.startsWith('emp-')) api('/api/chats/open', { id: n.chat });
  };
});

// ---------- restarts and updates ----------
// The server says which start it is. A page from an earlier start reloads (its token no longer
// works), which is also how the page follows ClaudeOS into a new build.
let boot = null;
events.addEventListener('hello', e => {
  const h = JSON.parse(e.data);
  if (boot && h.boot !== boot) { location.reload(); return; }
  boot = h.boot;
  const u = h.updated;
  if (!u) return;
  const key = 'claudeos-updated-' + u.at;
  try { if (sessionStorage.getItem(key)) return; sessionStorage.setItem(key, '1'); } catch { /* show it anyway */ }
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = u.ok ? `ClaudeOS updated to build ${u.to}` : `The new build didn't start, so ClaudeOS went back to build ${u.to}${u.status === 'failed' ? ' (see update.log in your ClaudeOS data folder)' : ''}`;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 8000);
});
// a build Claude just made shows as a dot on ⚙
setInterval(async () => {
  if (document.hidden) return;
  const u = await api('/api/update').catch(() => null);
  if (u && !u.error) { update = u; btn.classList.toggle('ping', !!u.ready); if (!menu.hidden) draw(); }
}, 20000);
api('/api/update').then(u => { if (u && !u.error) { update = u; btn.classList.toggle('ping', !!u.ready); } });
