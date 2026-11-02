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

// a new build beside ClaudeOS.exe (Claude makes it with npm run build:exe -- dist/ClaudeOS.new.exe),
// and the build before this one (ClaudeOS.old.exe), to go back to
function updateRow() {
  const u = update;
  if (!u) return '';
  const when = t => { const d = new Date(t); return d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); };
  const name = f => f.build ? `build ${esc(f.build)}` : `the build from ${when(f.built)}`;
  if (!u.canUpdate) return `<div class="row"><b>Update</b><span>ClaudeOS.exe installs new builds of itself and can roll back; from the app folder, restart node server.mjs</span></div>`;
  const now = `Running build ${esc(u.build)}.`;
  const note = u.pending ? `${now} ${u.pending === 'rollback' ? 'Rolling back' : 'Restarting to update'} as soon as every chat is done… <button type="button" class="btn mini" data-act="update-cancel">Cancel</button>`
    : u.ready ? `${now} A new build is ready (${name(u.ready)}). <button type="button" class="btn mini primary" data-act="update">Restart to update</button>`
    : `${now} Up to date. <button type="button" class="btn mini" data-act="update" disabled title="No new build beside ClaudeOS.exe yet. Ask Claude to build one.">Restart to update</button>`;
  const back = !u.previous || u.pending ? ''
    : `<div class="row"><b>Roll back</b><span>Go back to ${name(u.previous)}. This build is kept, so Restart to update brings it back. <button type="button" class="btn mini" data-act="rollback" ${u.ready ? 'disabled title="Install or delete the waiting new build first"' : ''}>Roll back</button></span></div>`;
  return `<div class="row"><b>Update</b><span>${note}</span></div>${back}`;
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
  if (e.target.dataset.act === 'rollback' && confirm(`Restart ClaudeOS into the previous build? Chats that are working finish their turn first.`)) api('/api/update', { rollback: true }).then(r => { if (r.error) alert(r.error); load(); });
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
  const back = u.kind === 'rollback';
  t.textContent = u.ok ? (back ? `ClaudeOS rolled back to build ${u.to} (Restart to update in ⚙ brings ${u.from} back)` : `ClaudeOS updated to build ${u.to}`)
    : `The ${back ? 'previous' : 'new'} build didn't start, so ClaudeOS stayed on build ${u.to} (see update.log in your ClaudeOS data folder)`;
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
