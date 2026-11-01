// The ⚙ menu (own window, hotkey, notifications, start with Windows) and the notifications
// themselves: the server sends 'notify' when an answer lands or Claude needs a yes, and the page
// shows it only while you are looking elsewhere. With no page open, the tray shows it instead.
import { events } from '/events.js';

const TOKEN = window.CLAUDEOS_TOKEN;
const btn = document.getElementById('settingsBtn');
const menu = document.getElementById('settingsMenu');
let settings = null;

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
    <label class="${s.canStartAtLogin ? '' : 'off'}"><input type="checkbox" data-set="startAtLogin" ${s.startAtLogin ? 'checked' : ''} ${s.canStartAtLogin ? '' : 'disabled'}> <b>Start with Windows</b><span>${s.canStartAtLogin ? 'In the tray when you sign in, no window until you ask' : 'Works in ClaudeOS.exe'}</span></label>`;
}

async function load() { settings = await api('/api/settings'); draw(); }
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
