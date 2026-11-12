// Employees get better on their own: when one's graded work keeps coming back weak, the coach (grades.mjs)
// rewrites their SKILL.md instructions. The new instructions sit a practice exam against the old ones first
// (learning.mjs) and are only saved if they do at least as well; if real work then gets worse, they're rolled back. The SKILL.md as it was is kept in
// <data>/coaching/ so one click undoes it. Only work after the last coaching counts toward the next one,
// so the coach never rewrites twice from the same runs.
import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite, reviewBody, REVIEW_HEADING, LEGACY_REVIEW_HEADING } from './performance-reviews.mjs';
import crypto from 'node:crypto';
import { coach as coachRun, ranAs } from './grades.mjs';
import { rating, needsWork } from './public/minds.js';
import { trustedGrades, updateExam, afterCoaching } from './learning.mjs';

const KEEP_PER_SKILL = 10; // coachings remembered (and backups kept) per employee

// Should this employee be coached now? Their runs since the last coaching, judged the same way as the
// "needs work" flag: quality under 50 over at least 5 graded runs.
export function isDue(runs, grades, name, since = 0) {
  const mine = runs.filter(r => r.end > since && ranAs(r, name)).map(r => ({ status: r.outcome, grade: grades[r.key] }));
  return needsWork(rating(mine));
}

// examine(oldBody, newBody, exam) -> { pass, untested?, score?, error? }: the practice exam (learning.runExam); none = untested
export function createCoaching({ file, backupDir, coach = coachRun, examine = null, onChange = () => {} }) {
  let history = {}, exams = {};
  try { history = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* none yet */ }
  const examsFile = file.replace(/\.json$/, '') + '-exams.json';
  try { exams = JSON.parse(fs.readFileSync(examsFile, 'utf8')); } catch { /* none yet */ }
  const busy = new Set();
  function save() {
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(history, null, 1)); } catch { /* kept in memory */ }
    onChange();
  }
  const saveExams = () => { try { fs.mkdirSync(path.dirname(examsFile), { recursive: true }); fs.writeFileSync(examsFile, JSON.stringify(exams)); } catch { /* kept in memory */ } };
  const remember = (id, entry) => {
    const list = history[id] ||= [];
    list.push(entry);
    for (const old of list.splice(0, Math.max(0, list.length - KEEP_PER_SKILL))) if (old.backup) fs.rmSync(old.backup, { force: true });
    save();
  };
  const latest = id => history[id]?.[history[id].length - 1] || null;
  const since = id => latest(id)?.at || 0;

  // employee: { id, name, file (its SKILL.md), read() -> { name, description, body }, write(fields) }
  async function run(employee, runs, grades, why = 'auto') {
    const { id } = employee;
    if (busy.has(id)) return { error: 'The coach is already working on this employee.' };
    busy.add(id);
    try {
      grades = trustedGrades(grades);
      const cur = employee.read();
      const r = await coach({ name: employee.name, description: cur.description, body: cur.body }, runs, grades, undefined, since(id));
      if (r.error) return r;
      // the practice exam: the same past tasks with the old and the new instructions, judged blind
      exams[id] = updateExam(exams[id], runs, grades, employee.name); saveExams();
      const exam = examine ? await examine(cur.body, r.body, exams[id]) : { pass: true, untested: true };
      const at = Date.now();
      if (!exam.pass) {
        // not saved; remembered so the same runs don't trigger it again
        remember(id, { at, why, summary: r.summary, weak: r.weak, rejected: true, exam });
        return { rejected: true, at, summary: r.summary, exam, error: exam.error || `The new instructions did worse on the practice exam (${Math.round(exam.score * 100)}/100 against the current ones), so they weren't saved.` };
      }
      // keep the SKILL.md as it was, then save the new instructions
      fs.mkdirSync(backupDir, { recursive: true });
      const backup = path.join(backupDir, `${crypto.createHash('sha1').update(id).digest('hex').slice(0, 12)}-${at}.md`);
      fs.writeFileSync(backup, fs.readFileSync(employee.file, 'utf8'));
      // Re-read after the model call: grading may have added corrections while it ran.
      const current = employee.read().body.replace(LEGACY_REVIEW_HEADING, REVIEW_HEADING);
      const prior = current.indexOf(REVIEW_HEADING);
      let body = r.body;
      if (prior >= 0) {
        const section = current.slice(prior).split(/\r?\n(?=## )/)[0];
        body = body.replace(/## (?:Performance Corrections & Constraints|Dynamic Performance Review Corrections & Constraints|Performance Review Corrections)[\s\S]*?(?=\r?\n## |$)/, '').trimEnd() + '\n\n' + section;
      }
      for (const c of r.corrections || []) {
        if (c.employee !== employee.name || !runs.some(run => run.key === c.task && ranAs(run, employee.name))) continue;
        body = reviewBody(body, c.task, [c]);
      }
      const w = employee.write({ name: cur.name, description: cur.description, body });
      if (w?.error) { fs.rmSync(backup, { force: true }); return w; }
      remember(id, { at, why, summary: r.summary, weak: r.weak, backup, file: employee.file, ...(exam.untested ? { untested: true } : { exam }) });
      return { ok: true, at, summary: r.summary, weak: r.weak, exam };
    } catch (err) { return { error: err.message }; }
    finally { busy.delete(id); }
  }

  return {
    history: () => history,
    busy: id => busy.has(id),
    // what the page shows: each employee's latest coaching
    view(ids) {
      const out = {};
      for (const id of ids) {
        const l = latest(id);
        if (l) out[id] = { at: l.at, summary: l.summary, weak: l.weak, why: l.why, undone: !!l.undone, n: history[id].length,
          rejected: !!l.rejected, rolledBack: !!l.rolledBack, settled: !!l.settled, untested: !!l.untested, exam: l.exam || null };
      }
      return out;
    },
    run,
    // coach the first employee that is due (one at a time); employees: as for run()
    async tick(employees, runs, grades) {
      if (busy.size) return null;
      grades = trustedGrades(grades);
      // first: did the latest coaching hold up in real work? Worse than the runs it learned from: roll it back
      for (const x of employees) {
        const list = history[x.id], l = latest(x.id);
        if (!l || l.undone || l.rejected || l.settled) continue;
        const verdict = afterCoaching(l.at, list.length > 1 ? list[list.length - 2].at : 0, runs, grades, x.name);
        if (verdict === 'kept') { l.settled = true; save(); }
        if (verdict === 'worse' && undo(x.id).ok) { l.rolledBack = true; save(); return { employee: x, result: { rolledBack: true, at: l.at, summary: l.summary } }; }
      }
      const e = employees.find(x => isDue(runs, grades, x.name, since(x.id)));
      return e ? { employee: e, result: await run(e, runs, grades, 'auto') } : null;
    },
    undo,
  };
  // put their SKILL.md back the way it was before the latest coaching
  function undo(id) {
    const l = latest(id);
    if (!l || l.undone || l.rejected) return { error: 'Nothing to undo.' };
    let text;
    try { text = fs.readFileSync(l.backup, 'utf8'); } catch { return { error: 'The old instructions are gone.' }; }
    atomicWrite(l.file, text);
    l.undone = true; // stays in the history so the same runs don't trigger it again
    save();
    return { ok: true };
  }
}
