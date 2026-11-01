// The building: one business per brain, split into departments. Each department has employees (skill ids)
// and projects. An employee sits in at most one department; the rest work in the Lobby. A project keeps
// a short log of the team's reports on it, so whoever picks it up next sees what their colleagues did.
// Data: <data>/org/<brainId>.json
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const COLORS = ['#5fd4ff', '#ff7aa8', '#7dff9e', '#ffc861', '#c9a7ff', '#ff9a5c', '#4fd1a5', '#7b8cff'];
const MAX_DEPTS = 16;
const MAX_PROJECTS = 24;
const MAX_LOG = 20;
const clip = (s, n) => (s = String(s ?? '').trim()).length > n ? s.slice(0, n - 1) + '…' : s;
const newId = () => crypto.randomBytes(4).toString('hex');

export function createOrg({ dir }) {
  const cache = new Map(); // brain id -> state

  const fileOf = brainId => path.join(dir, `${brainId}.json`);
  function load(brainId) {
    if (cache.has(brainId)) return cache.get(brainId);
    let s = { departments: [] };
    try { s = { ...s, ...JSON.parse(fs.readFileSync(fileOf(brainId), 'utf8')) }; } catch { /* first run */ }
    cache.set(brainId, s);
    return s;
  }
  function save(brainId) {
    try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(fileOf(brainId), JSON.stringify(load(brainId), null, 2)); } catch { /* still works this session */ }
  }

  const dept = (s, id) => s.departments.find(d => d.id === id);
  function project(s, id) {
    for (const d of s.departments) { const p = d.projects.find(x => x.id === id); if (p) return { d, p }; }
    return null;
  }
  const deptOf = (brainId, skillId) => load(brainId).departments.find(d => d.employees.includes(skillId)) || null;

  // every change from the page goes through here: { op, ...fields }
  function apply(brainId, body = {}) {
    const s = load(brainId);
    const name = clip(body.name, 60);
    switch (body.op) {
      case 'addDept': {
        if (!name) return { error: 'Give the department a name.' };
        if (s.departments.length >= MAX_DEPTS) return { error: `A building holds at most ${MAX_DEPTS} departments.` };
        if (s.departments.some(d => d.name.toLowerCase() === name.toLowerCase())) return { error: `There is already a ${name} department.` };
        const used = new Set(s.departments.map(d => d.color));
        const d = { id: newId(), name, color: COLORS.find(c => !used.has(c)) || COLORS[s.departments.length % COLORS.length],
          about: clip(body.about, 300), employees: [], projects: [], created: Date.now() };
        s.departments.push(d);
        save(brainId);
        return { ok: true, id: d.id };
      }
      case 'editDept': {
        const d = dept(s, body.id);
        if (!d) return { error: 'That department is gone.' };
        if (body.name !== undefined) {
          if (!name) return { error: 'Give the department a name.' };
          if (s.departments.some(x => x !== d && x.name.toLowerCase() === name.toLowerCase())) return { error: `There is already a ${name} department.` };
          d.name = name;
        }
        if (body.about !== undefined) d.about = clip(body.about, 300);
        if (/^#[0-9a-f]{6}$/i.test(body.color || '')) d.color = body.color.toLowerCase();
        save(brainId);
        return { ok: true };
      }
      case 'removeDept': {
        const i = s.departments.findIndex(d => d.id === body.id);
        if (i < 0) return { error: 'That department is gone.' };
        const [d] = s.departments.splice(i, 1);
        save(brainId);
        return { ok: true, removed: d }; // its people go back to the Lobby
      }
      case 'assign': {
        // dept: a department id, or empty for the Lobby
        const skill = String(body.skill || '');
        if (!skill) return { error: 'Pick an employee.' };
        const to = body.dept ? dept(s, body.dept) : null;
        if (body.dept && !to) return { error: 'That department is gone.' };
        for (const d of s.departments) d.employees = d.employees.filter(x => x !== skill);
        if (to) to.employees.push(skill);
        save(brainId);
        return { ok: true };
      }
      case 'addProject': {
        const d = dept(s, body.dept);
        if (!d) return { error: 'That department is gone.' };
        if (!name) return { error: 'Give the project a name.' };
        if (s.departments.reduce((n, x) => n + x.projects.length, 0) >= MAX_PROJECTS) return { error: `Keep it to ${MAX_PROJECTS} projects; finish or remove one first.` };
        const folder = String(body.folder || '').trim();
        if (folder && !(path.isAbsolute(folder) && fs.existsSync(folder))) return { error: 'The project folder must be a full path to a folder that exists.' };
        const p = { id: newId(), name, goal: clip(body.goal, 1000), folder, status: 'active', created: Date.now(), log: [] };
        d.projects.push(p);
        save(brainId);
        return { ok: true, id: p.id };
      }
      case 'editProject': {
        const f = project(s, body.id);
        if (!f) return { error: 'That project is gone.' };
        const { p } = f;
        if (body.name !== undefined) { if (!name) return { error: 'Give the project a name.' }; p.name = name; }
        if (body.goal !== undefined) p.goal = clip(body.goal, 1000);
        if (body.folder !== undefined) {
          const folder = String(body.folder || '').trim();
          if (folder && !(path.isAbsolute(folder) && fs.existsSync(folder))) return { error: 'The project folder must be a full path to a folder that exists.' };
          p.folder = folder;
        }
        if (body.status === 'active' || body.status === 'done') p.status = body.status;
        if (body.dept && body.dept !== f.d.id) {
          const to = dept(s, body.dept);
          if (!to) return { error: 'That department is gone.' };
          f.d.projects = f.d.projects.filter(x => x !== p);
          to.projects.push(p);
        }
        save(brainId);
        return { ok: true };
      }
      case 'removeProject': {
        const f = project(s, body.id);
        if (!f) return { error: 'That project is gone.' };
        f.d.projects = f.d.projects.filter(x => x !== f.p);
        save(brainId);
        return { ok: true };
      }
    }
    return { error: 'Unknown change.' };
  }

  // a renamed employee keeps their desk
  function rename(brainId, from, to) {
    const s = load(brainId);
    let moved = false;
    for (const d of s.departments) d.employees = d.employees.map(x => x === from ? (moved = true, to) : x);
    if (moved) save(brainId);
  }

  // a finished brief task on a project: its report goes in the project's log
  function logWork(brainId, projectId, entry) {
    const s = load(brainId), f = project(s, projectId);
    if (!f) return;
    f.p.log.push({ ts: Date.now(), employee: entry.employee, name: entry.name, task: clip(entry.task, 160), status: entry.status, result: clip(entry.result, 700) });
    f.p.log = f.p.log.slice(-MAX_LOG);
    save(brainId);
  }

  function findProject(brainId, id) { return project(load(brainId), id); }
  // what the page draws
  function snapshot(brainId) { return load(brainId); }

  return { apply, rename, logWork, deptOf, findProject, snapshot };
}
