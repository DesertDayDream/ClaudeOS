// Scheduled tasks: a prompt that runs by itself, once or on a schedule, as a new chat in its brain
// (like Claude Desktop's scheduled tasks). ClaudeOS has to be running; a run that was missed while it
// was closed happens once when it starts again. ~/.claudeos/schedules.json keeps them.
import crypto from 'node:crypto';
import fs from 'node:fs';

export const REPEATS = ['once', 'hourly', 'daily', 'weekdays', 'weekly'];
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const TICK = 20e3;

const clip = (s, n) => (s = String(s || '').trim()).length > n ? s.slice(0, n) : s;
function hm(time) {
  const m = String(time || '').trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] || 0);
  if (m[3]) { if (h === 12) h = 0; if (/pm/i.test(m[3])) h += 12; }
  return h < 24 && min < 60 ? [h, min] : null;
}
const at = (d, [h, m]) => { const x = new Date(d); x.setHours(h, m, 0, 0); return x; };

// the first time after `from` this task should run (null: never again)
export function nextRun(s, from = Date.now()) {
  const t = hm(s.time) || [9, 0];
  if (s.repeat === 'once') {
    const when = s.date ? at(new Date(`${s.date}T00:00:00`), t).getTime() : NaN;
    return Number.isFinite(when) && !s.lastRun ? when : null;
  }
  if (s.repeat === 'hourly') {
    const period = Math.max(1, Number(s.every) || 1) * 3600e3;
    const base = s.lastRun || s.created || from;
    return base + Math.max(1, Math.ceil((from - base + 1) / period)) * period;
  }
  for (let k = 0; k < 8; k++) {
    const d = at(new Date(from + k * 86400e3), t);
    if (d.getTime() <= from) continue;
    const wd = d.getDay();
    if (s.repeat === 'weekdays' && (wd === 0 || wd === 6)) continue;
    if (s.repeat === 'weekly' && wd !== (Number.isInteger(s.day) ? s.day : 1)) continue;
    return d.getTime();
  }
  return null;
}
// "Weekdays at 9:00" for the list and for Claude
export function describe(s) {
  const t = hm(s.time) || [9, 0];
  const time = new Date(2000, 0, 1, t[0], t[1]).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (s.repeat === 'once') return `Once, ${s.date || '?'} at ${time}`;
  if (s.repeat === 'hourly') return Number(s.every) > 1 ? `Every ${Number(s.every)} hours` : 'Every hour';
  if (s.repeat === 'daily') return `Every day at ${time}`;
  if (s.repeat === 'weekdays') return `Weekdays at ${time}`;
  const day = DAYS[Number.isInteger(s.day) ? s.day : 1];
  return `Every ${day[0].toUpperCase() + day.slice(1)} at ${time}`;
}

export function createSchedules({ file, run, broadcast = () => {} }) {
  let list = [];
  try { list = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* none yet */ }
  const save = () => { try { fs.writeFileSync(file, JSON.stringify(list, null, 1)); } catch { /* kept in memory */ } };
  const changed = () => { save(); broadcast('schedules', {}); };
  const view = s => ({ ...s, when: describe(s) });

  // check and clean what the page or Claude sends
  function clean(input, old = {}) {
    const s = { ...old };
    if (input.title != null) s.title = clip(input.title, 80);
    if (input.prompt != null) s.prompt = clip(input.prompt, 20000);
    if (input.repeat != null) s.repeat = String(input.repeat).toLowerCase();
    if (input.time != null) s.time = String(input.time).trim();
    if (input.date != null) s.date = String(input.date).trim();
    if (input.day != null) s.day = typeof input.day === 'number' ? input.day : DAYS.findIndex(d => d.startsWith(String(input.day).toLowerCase().slice(0, 3)));
    if (input.every != null) s.every = Math.max(1, Math.min(168, Math.round(Number(input.every) || 1)));
    if (input.folder !== undefined) s.folder = input.folder ? String(input.folder) : null;
    if (input.enabled != null) s.enabled = !!input.enabled;
    if (!s.title && s.prompt) s.title = clip(s.prompt.split('\n')[0], 60);
    if (!s.prompt) return { error: 'The task needs a prompt: what Claude should do each time.' };
    if (!REPEATS.includes(s.repeat)) return { error: `Repeat must be one of: ${REPEATS.join(', ')}.` };
    if (s.repeat !== 'hourly' && !hm(s.time || '9:00')) return { error: 'Time must look like 09:00 or 9:30 pm.' };
    if (s.repeat === 'once' && !/^\d{4}-\d{2}-\d{2}$/.test(s.date || '')) return { error: 'A one-time task needs a date like 2026-11-05.' };
    if (s.repeat === 'weekly' && !(s.day >= 0 && s.day <= 6)) return { error: 'A weekly task needs a day, like monday.' };
    s.time ||= '09:00';
    return s;
  }
  function saveTask(brain, input) {
    const old = input.id ? list.find(x => x.id === input.id && x.brain === brain) : null;
    if (input.id && !old) return { error: 'That scheduled task is gone.' };
    const s = clean(input, old || { id: crypto.randomBytes(5).toString('hex'), brain, created: Date.now(), enabled: true, runs: 0 });
    if (s.error) return s;
    if (old && (old.repeat !== s.repeat || old.date !== s.date)) s.lastRun = s.repeat === 'once' ? null : s.lastRun;
    s.nextRun = s.enabled ? nextRun(s) : null;
    if (s.repeat === 'once' && s.nextRun && s.nextRun < Date.now() - 60e3) return { error: 'That time has already passed.' };
    if (old) Object.assign(old, s); else list.push(s);
    changed();
    return { ok: true, task: view(s) };
  }
  function remove(brain, id) {
    const n = list.length;
    list = list.filter(x => !(x.id === id && x.brain === brain));
    if (list.length === n) return { error: 'That scheduled task is gone.' };
    changed();
    return { ok: true };
  }
  async function runNow(s, why = 'manual') {
    s.lastRun = Date.now();
    s.runs = (s.runs || 0) + 1;
    let r;
    try { r = await run(s); } catch (err) { r = { error: err.message }; }
    s.lastResult = r.error ? `Didn't start: ${r.error}` : why === 'missed' ? 'Ran late (ClaudeOS was closed at the time)' : 'Started';
    if (r.chat) s.lastChat = r.chat;
    if (s.repeat === 'once') s.enabled = false;
    s.nextRun = s.enabled ? nextRun(s) : null;
    changed();
    return r;
  }
  let ticking = false;
  async function tick() {
    if (ticking) return;
    ticking = true;
    const now = Date.now();
    try {
      for (const s of list) {
        if (!s.enabled) continue;
        if (!s.nextRun) { s.nextRun = nextRun(s); if (!s.nextRun) { s.enabled = false; changed(); } continue; }
        if (s.nextRun > now) continue;
        await runNow(s, now - s.nextRun > 10 * 60e3 ? 'missed' : 'scheduled');
      }
    } finally { ticking = false; }
  }
  const timer = setInterval(tick, TICK);
  setTimeout(tick, 5000); // missed runs, shortly after ClaudeOS starts

  return {
    list: brain => list.filter(s => !brain || s.brain === brain).map(view).sort((a, b) => (a.nextRun || Infinity) - (b.nextRun || Infinity)),
    save: saveTask, remove,
    run: (brain, id) => { const s = list.find(x => x.id === id && x.brain === brain); return s ? runNow(s) : { error: 'That scheduled task is gone.' }; },
    stop: () => clearInterval(timer),
  };
}
