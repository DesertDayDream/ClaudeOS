import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { graderAgreement, graderTrusted, trustedGrades, updateExam, runExam, parseVerdict, afterCoaching, learningReport, EXAM_SIZE } from '../learning.mjs';
import { createCoaching } from '../coaching.mjs';
import { reviewBody, MAX_RULES, REVIEW_HEADING } from '../performance-reviews.mjs';

const run = (key, end, extra = {}) => ({ key, end, outcome: 'done', skillNames: ['writer'], prompt: 'task ' + key, result: 'reply ' + key, ...extra });

test('the AI grader is checked against the user, and ignored when it disagrees too often', () => {
  const agree = { a: { ai: 5, user: 'up' }, b: { ai: 2, user: 'down' }, c: { ai: 4, user: 'up' }, d: { ai: 1, user: 'down' }, e: { ai: 5, user: 'up' }, f: { ai: 3 } };
  assert.deepEqual(graderAgreement(agree), { n: 5, agree: 5, rate: 1 });
  assert.equal(trustedGrades(agree), agree);
  const off = { a: { ai: 5, user: 'down' }, b: { ai: 5, user: 'down' }, c: { ai: 1, user: 'up' }, d: { ai: 5, user: 'down' }, e: { ai: 5, user: 'up' }, f: { ai: 2 } };
  assert.equal(graderTrusted(graderAgreement(off)), false);
  const t = trustedGrades(off);
  assert.equal(t.f, undefined); // AI-only grades dropped
  assert.equal(t.a.ai, undefined);
  assert.equal(t.a.user, 'down');
  assert.equal(graderTrusted(graderAgreement({ a: { ai: 5, user: 'down' } })), true); // too few checks to judge
});

test('the practice exam is a fixed set of good and weak past tasks', () => {
  const runs = Array.from({ length: 8 }, (_, i) => run('s:' + i, i + 1));
  const grades = Object.fromEntries(runs.map((r, i) => [r.key, { ai: i % 2 ? 5 : 2 }]));
  const exam = updateExam([], runs, grades, 'writer');
  assert.equal(exam.length, EXAM_SIZE);
  assert.ok(exam.some(t => t.kind === 'good') && exam.some(t => t.kind === 'weak'));
  assert.deepEqual(updateExam(exam, [...runs, run('s:new', 99)], { ...grades, 's:new': { ai: 1 } }, 'writer'), exam); // full: stays fixed
});

test('new instructions pass the exam only when a blind judge rates them at least even', async () => {
  const exam = [{ prompt: 'p1', reply: 'r', graded: '2/5' }, { prompt: 'p2', reply: 'r', graded: '5/5' }];
  // the judge always prefers the answer written with the NEW instructions, wherever it is placed
  const ask = async p => p.startsWith('Two AI employees') ? JSON.stringify({ winner: p.split('<<<A')[1].startsWith('\nNEW') ? 'A' : 'B' })
    : p.includes('NEW STEPS') ? 'NEW answer' : 'OLD answer';
  let f = false;
  const flip = () => (f = !f);
  const better = await runExam('OLD STEPS', 'NEW STEPS', exam, ask, flip);
  assert.equal(better.pass, true);
  assert.equal(better.wins, 2);
  const worse = await runExam('NEW STEPS', 'OLD STEPS', exam, ask, flip);
  assert.equal(worse.pass, false);
  assert.equal(worse.losses, 2);
  assert.equal((await runExam('a', 'b', exam, async () => null)).pass, false); // couldn't run: not saved
  assert.equal((await runExam('a', 'b', [], ask)).untested, true);
  assert.equal(parseVerdict('x {"winner":"tie"}'), 'tie');
});

test('a coaching that fails the exam is not saved; one that makes real work worse is rolled back', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'learning-test-'));
  try {
    const skill = path.join(dir, 'SKILL.md');
    const original = '---\nname: writer\ndescription: Writes.\n---\n\nOld steps.\n';
    fs.writeFileSync(skill, original);
    const employee = { id: 'project:b:writer', name: 'writer', file: skill, read: () => ({ name: 'writer', description: 'Writes.', body: 'Old steps.' }),
      write: f => fs.writeFileSync(skill, `---\nname: ${f.name}\ndescription: ${f.description}\n---\n\n${f.body}\n`) };
    const coach = async () => ({ summary: 'Added steps.', body: 'New steps.', weak: 5 });
    const t0 = Date.now() - 100000;
    const runs = Array.from({ length: 5 }, (_, i) => run('s:' + i, t0 + i));
    const down = Object.fromEntries(runs.map(r => [r.key, { user: 'down', ai: 2 }]));

    const failing = createCoaching({ file: path.join(dir, 'a.json'), backupDir: path.join(dir, 'ba'), coach, examine: async () => ({ pass: false, score: 0.2, tasks: 5 }) });
    const t = await failing.tick([employee], runs, down);
    assert.equal(t.result.rejected, true);
    assert.equal(fs.readFileSync(skill, 'utf8'), original);
    assert.equal(failing.view([employee.id])[employee.id].rejected, true);
    assert.equal(await failing.tick([employee], runs, down), null); // the same runs don't trigger it again
    assert.ok(failing.undo(employee.id).error); // nothing was saved, so nothing to undo

    const passing = createCoaching({ file: path.join(dir, 'b.json'), backupDir: path.join(dir, 'bb'), coach,
      examine: async () => ({ pass: true, score: 0.8, tasks: 5, wins: 4, losses: 1, ties: 0 }) });
    const before = { ...down, 's:0': { user: 'up' }, 's:1': { user: 'up' } }; // 2 of 5 good: still a weak pattern (40/100)
    assert.equal((await passing.tick([employee], runs, before)).result.ok, true);
    assert.match(fs.readFileSync(skill, 'utf8'), /New steps/);
    assert.equal(fs.existsSync(path.join(dir, 'b-exams.json')), true);
    const at = passing.view([employee.id])[employee.id].at;
    // three runs after it, all 👎: worse than the runs it learned from
    const after = Array.from({ length: 3 }, (_, i) => run('n:' + i, at + 10 + i));
    const worse = { ...before, ...Object.fromEntries(after.map(r => [r.key, { user: 'down' }])) };
    const r = await passing.tick([employee], [...runs, ...after], worse);
    assert.equal(r.result.rolledBack, true);
    assert.equal(fs.readFileSync(skill, 'utf8'), original);
    assert.equal(passing.view([employee.id])[employee.id].rolledBack, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('afterCoaching waits for enough work, then keeps or rolls back', () => {
  const runs = [run('a', 1), run('b', 2), run('c', 11), run('d', 12), run('e', 13)];
  const g = v => Object.fromEntries(runs.map(r => [r.key, { ai: r.end > 10 ? v : 3 }]));
  assert.equal(afterCoaching(10, 0, runs.slice(0, 4), g(5), 'writer'), null);
  assert.equal(afterCoaching(10, 0, runs, g(5), 'writer'), 'kept');
  assert.equal(afterCoaching(10, 0, runs, g(1), 'writer'), 'worse');
});

test('learned rules are de-duplicated and capped', () => {
  let body = 'Steps.';
  for (let i = 0; i < 20; i++) body = reviewBody(body, 's:' + i, [{ employee: 'w', mistake: `Mistake number ${i} happened`, rule: `You must not do thing ${i % 15}; instead do it right` }]);
  const rules = body.slice(body.indexOf(REVIEW_HEADING)).split('\n').filter(l => l.startsWith('- From Task'));
  assert.equal(rules.length, MAX_RULES);
  assert.equal(new Set(rules.map(l => l.split('NEW RULE:')[1])).size, MAX_RULES);
  assert.ok(rules.at(-1).includes('s:19'));
});

test('the CEO report says in one line how each employee is doing', () => {
  const runs = Array.from({ length: 10 }, (_, i) => run('s:' + i, Date.now() - 1000 + i));
  const grades = Object.fromEntries(runs.map((r, i) => [r.key, { ai: i < 5 ? 2 : 5 }]));
  const rep = learningReport({ employees: [{ id: 'w', name: 'writer', label: 'Wren', body: 'x' }, { id: 'n', name: 'newbie', body: '' }], runs, grades,
    history: { w: [{ at: 1, summary: 's', settled: true }] } });
  assert.equal(rep.people[0].status, 'improving');
  assert.equal(rep.people[0].name, 'Wren');
  assert.equal(rep.people[0].lesson.outcome, 'kept: real work held up');
  assert.equal(rep.people[1].status, 'new');
  assert.equal(rep.toRate, 3); // only the unrated jobs the report lists
  assert.equal(rep.grader.enough, false);
});

test('the report lists each employee\'s latest jobs, newest first, to rate in place', () => {
  const runs = Array.from({ length: 5 }, (_, i) => ({ ...run('s:' + i, 1000 + i), prompt: `Task number ${i}\n<system-reminder>noise</system-reminder>` }));
  const grades = { 's:4': { ai: 4, why: 'fine', user: 'up' } };
  const rep = learningReport({ employees: [{ id: 'w', name: 'writer', body: '' }, { id: 'n', name: 'newbie', body: '' }], runs, grades });
  const jobs = rep.people[0].recentJobs;
  assert.equal(jobs.length, 3);
  assert.deepEqual(jobs.map(j => j.key), ['s:4', 's:3', 's:2']);
  assert.equal(jobs[0].task, 'Task number 4');
  assert.equal(jobs[0].user, 'up');
  assert.equal(jobs[0].ai, 4);
  assert.deepEqual(rep.people[1].recentJobs, []);
});
