// Employees get better on their own: when one's graded work keeps coming back weak, the coach (grades.mjs)
// rewrites their SKILL.md instructions and saves them right away. The SKILL.md as it was is kept in
// <data>/coaching/ so one click undoes it. Only work after the last coaching counts toward the next one,
// so the coach never rewrites twice from the same runs.
import fs from 'node:fs';
import path from 'node:path';
import { reviewBody, REVIEW_HEADING } from './performance-reviews.mjs';
import crypto from 'node:crypto';
import { coach as coachRun, ranAs } from './grades.mjs';
import { rating, needsWork } from './public/minds.js';

const KEEP_PER_SKILL = 10; // coachings remembered (and backups kept) per employee

// Should this employee be coached now? Their runs since the last coaching, judged the same way as the
// "needs work" flag: quality under 50 over at least 3 graded runs.
export function isDue(runs, grades, name, since = 0) {
  const mine = runs.filter(r => r.end > since && ranAs(r, name)).map(r => ({ status: r.outcome, grade: grades[r.key] }));
  return needsWork(rating(mine));
}

export function createCoaching({ file, backupDir, coach = coachRun, onChange = () => {} }) {
  let history = {};
  try { history = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* none yet */ }
  const busy = new Set();
  function save() {
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(history, null, 1)); } catch { /* kept in memory */ }
    onChange();
  }
  const latest = id => history[id]?.[history[id].length - 1] || null;
  const since = id => latest(id)?.at || 0;

  // employee: { id, name, file (its SKILL.md), read() -> { name, description, body }, write(fields) }
  async function run(employee, runs, grades, why = 'auto') {
    const { id } = employee;
    if (busy.has(id)) return { error: 'The coach is already working on this employee.' };
    busy.add(id);
    try {
      const cur = employee.read();
      const r = await coach({ name: employee.name, description: cur.description, body: cur.body }, runs, grades, undefined, since(id));
      if (r.error) return r;
      // keep the SKILL.md as it was, then save the new instructions
      const at = Date.now();
      fs.mkdirSync(backupDir, { recursive: true });
      const backup = path.join(backupDir, `${crypto.createHash('sha1').update(id).digest('hex').slice(0, 12)}-${at}.md`);
      fs.writeFileSync(backup, fs.readFileSync(employee.file, 'utf8'));
      // Re-read after the model call: grading may have added corrections while it ran.
      const current = employee.read().body;
      const prior = current.indexOf(REVIEW_HEADING);
      let body = r.body;
      if (prior >= 0) {
        const section = current.slice(prior).split(/\r?\n(?=## )/)[0];
        body = body.replace(/## Performance Review Corrections[\s\S]*?(?=\r?\n## |$)/, '').trimEnd() + '\n\n' + section;
      }
      for (const c of r.corrections || []) {
        if (c.employee !== employee.name || !runs.some(run => run.key === c.task && ranAs(run, employee.name))) continue;
        body = reviewBody(body, c.task, [c]);
      }
      const w = employee.write({ name: cur.name, description: cur.description, body });
      if (w?.error) { fs.rmSync(backup, { force: true }); return w; }
      const list = history[id] ||= [];
      list.push({ at, why, summary: r.summary, weak: r.weak, backup, file: employee.file });
      for (const old of list.splice(0, Math.max(0, list.length - KEEP_PER_SKILL))) fs.rmSync(old.backup, { force: true });
      save();
      return { ok: true, at, summary: r.summary, weak: r.weak };
    } catch (err) { return { error: err.message }; }
    finally { busy.delete(id); }
  }

  return {
    busy: id => busy.has(id),
    // what the page shows: each employee's latest coaching
    view(ids) {
      const out = {};
      for (const id of ids) { const l = latest(id); if (l) out[id] = { at: l.at, summary: l.summary, weak: l.weak, why: l.why, undone: !!l.undone, n: history[id].length }; }
      return out;
    },
    run,
    // coach the first employee that is due (one at a time); employees: as for run()
    async tick(employees, runs, grades) {
      if (busy.size) return null;
      const e = employees.find(x => isDue(runs, grades, x.name, since(x.id)));
      return e ? { employee: e, result: await run(e, runs, grades, 'auto') } : null;
    },
    // put their SKILL.md back the way it was before the latest coaching
    undo(id) {
      const l = latest(id);
      if (!l || l.undone) return { error: 'Nothing to undo.' };
      let text;
      try { text = fs.readFileSync(l.backup, 'utf8'); } catch { return { error: 'The old instructions are gone.' }; }
      fs.writeFileSync(l.file, text);
      l.undone = true; // stays in the history so the same runs don't trigger it again
      save();
      return { ok: true };
    },
  };
}
