// File cabinets: every employee has a real folder in the brain, filed by department like the building:
//   <brain>/Office/<Department or Lobby>/<Name> (<skill>)/
//     <Project or General>/<date> <task>/   what they make for a brief
//     Chats/<date>/                          what they make when you talk to them at their desk
//     Logs/<date> <task>.md                  each run's log, written as it happens
// A hidden .cabinet file names the owner, so a cabinet is found again after its folder moves; when an
// employee changes department (or the department is renamed) their cabinet moves with them.
import fs from 'node:fs';
import path from 'node:path';

const MARK = '.cabinet';
const MAX_ENTRIES = 500;
// a folder name Windows accepts
export const safeName = (s, n = 60) => String(s || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').replace(/[. ]+$/, '').trim().slice(0, n).trim() || 'Untitled';
const day = () => new Date().toISOString().slice(0, 10);
// a task's first words, cut at a word break, for a folder or log name
function short(s, n = 42) {
  s = safeName(String(s || '').split(/[.!?\n]/)[0], 200);
  if (s.length <= n) return s;
  const cut = s.slice(0, n);
  return (cut.slice(0, cut.lastIndexOf(' ')) || cut).replace(/[,;:\- ]+$/, '');
}

export const officeOf = brainPath => path.join(brainPath, 'Office');

// emp: { id (skill id), skill (name), name (first name), dept (department name or null) }
function wanted(brainPath, emp) {
  return path.join(officeOf(brainPath), safeName(emp.dept || 'Lobby'), safeName(`${emp.name} (${emp.skill})`, 80));
}
function owner(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, MARK), 'utf8')).id; } catch { return null; }
}
// where this employee's cabinet is now, if they have one
export function findCabinet(brainPath, id) {
  const office = officeOf(brainPath);
  let depts = [];
  try { depts = fs.readdirSync(office, { withFileTypes: true }).filter(d => d.isDirectory()); } catch { return null; }
  for (const d of depts) {
    let names = [];
    try { names = fs.readdirSync(path.join(office, d.name), { withFileTypes: true }).filter(x => x.isDirectory()); } catch { continue; }
    for (const n of names) { const dir = path.join(office, d.name, n.name); if (owner(dir) === id) return dir; }
  }
  return null;
}
// The cabinet, made if missing and moved to the right department if it isn't there. A move that fails
// (a file open in another program) leaves it where it is; the next call tries again.
export function ensureCabinet(brainPath, emp) {
  const want = wanted(brainPath, emp), have = findCabinet(brainPath, emp.id);
  if (have && path.relative(have, want) === '') return have;
  if (have && !fs.existsSync(want)) {
    try {
      fs.mkdirSync(path.dirname(want), { recursive: true });
      fs.renameSync(have, want);
      try { fs.rmdirSync(path.dirname(have)); } catch { /* the old department folder isn't empty */ }
      return want;
    } catch { return have; }
  }
  if (have) return have;
  fs.mkdirSync(want, { recursive: true });
  fs.writeFileSync(path.join(want, MARK), JSON.stringify({ id: emp.id, skill: emp.skill }));
  return want;
}
// a fresh folder for one piece of work: <cabinet>/<group>/<date> <title>
export function workFolder(cabinet, group, title) {
  const base = path.join(cabinet, safeName(group), `${day()} ${short(title)}`);
  let dir = base;
  for (let n = 2; fs.existsSync(dir); n++) dir = `${base} (${n})`;
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
export function logFile(cabinet, title) {
  const dir = path.join(cabinet, 'Logs');
  fs.mkdirSync(dir, { recursive: true });
  const base = path.join(dir, `${day()} ${short(title)}`);
  let file = `${base}.md`;
  for (let n = 2; fs.existsSync(file); n++) file = `${base} (${n}).md`;
  return file;
}
// what's in a cabinet, newest first within each folder: { path (relative), dir, size, mtime, depth }
export function cabinetTree(dir) {
  const out = [];
  const walk = (d, rel, depth) => {
    let names = [];
    try { names = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    const items = names.filter(e => e.name !== MARK).map(e => {
      let st = null;
      try { st = fs.statSync(path.join(d, e.name)); } catch { /* gone */ }
      return { e, st };
    }).filter(x => x.st).sort((a, b) => (b.e.isDirectory() - a.e.isDirectory()) || b.st.mtimeMs - a.st.mtimeMs);
    for (const { e, st } of items) {
      if (out.length >= MAX_ENTRIES) return;
      const r = rel ? `${rel}/${e.name}` : e.name;
      out.push({ path: r, dir: e.isDirectory(), size: st.size, mtime: st.mtimeMs, depth });
      if (e.isDirectory() && depth < 4) walk(path.join(d, e.name), r, depth + 1);
    }
  };
  walk(dir, '', 0);
  return out;
}
