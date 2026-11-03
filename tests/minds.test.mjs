import test from 'node:test';
import assert from 'node:assert/strict';
import { modelTier, effortLevel, rating, craftOf, modelFamily, runQuality, needsWork, weakRun } from '../public/minds.js';
import { finishedRuns, parseGrade, lessonsFor, parseCoach, coach, coachPrompt } from '../grades.mjs';

test('model families from aliases and ids', () => {
  assert.equal(modelFamily('claude-opus-5-5'), 'opus');
  assert.equal(modelFamily('sonnet[1m]'), 'sonnet');
  assert.equal(modelFamily(''), '');
});

test('a stronger model is a bigger brain, more effort a brighter one', () => {
  assert.ok(modelTier({ model: 'fable' }) > modelTier({ model: 'opus' }));
  assert.ok(modelTier({ model: 'opus' }) > modelTier({ model: 'sonnet' }));
  assert.ok(modelTier({ model: 'sonnet' }) > modelTier({ model: 'haiku' }));
  assert.equal(modelTier({ model: 'fable' }), 1);
  assert.ok(effortLevel('max') > effortLevel('high') && effortLevel('high') > effortLevel('low'));
  assert.equal(effortLevel(''), 0.6); // not picked: Claude Code's default
});

test('a track record is earned: more good runs, higher score', () => {
  const done = n => Array.from({ length: n }, () => ({ status: 'done' }));
  assert.ok(rating([]).score < rating(done(3)).score);
  assert.ok(rating(done(3)).score < rating(done(15)).score);
  assert.ok(rating([...done(5), { status: 'error' }, { status: 'error' }]).score < rating(done(7)).score);
  assert.equal(rating([{ status: 'working' }]).runs, 0); // a run still going doesn't count yet
});

test('a fuller SKILL.md scores higher than a stub', () => {
  const stub = craftOf('---\nname: x\n---\nDo things.', 'x', []);
  const full = craftOf('---\nname: x\n---\n# Steps\n' + '1. Do a careful thing with the files here.\n'.repeat(40) + '## Example\n```\nrun it\n```\n'.repeat(3) + '## Notes\n## More\n## Done\n',
    'Edits videos into reels. Use when the user wants a highlight reel.', ['scripts/cut.py', 'references/a.md', 'assets/b.png', 'c.md']);
  assert.ok(stub.score < 0.2, `stub ${stub.score}`);
  assert.ok(full.score > 0.8, `full ${full.score}`);
  assert.equal(full.scripts, 1);
});

test('quality counts: finished but poor work rates lower than finished good work', () => {
  const runs = (n, grade) => Array.from({ length: n }, () => ({ status: 'done', grade }));
  assert.ok(rating(runs(8, { ai: 5 })).score > rating(runs(8)).score);
  assert.ok(rating(runs(8, { ai: 1 })).score < rating(runs(8)).score);
  assert.ok(rating(runs(8, { ai: 2 })).score < rating(runs(8, { ai: 4 })).score);
  assert.equal(rating(runs(3)).quality, null); // nothing graded: finishing alone, as before
  assert.equal(rating(runs(3, { ai: 4 })).graded, 3);
});

test("the user's thumbs replace Haiku's grade", () => {
  assert.equal(runQuality({ ai: 5, user: 'down' }), 0);
  assert.equal(runQuality({ ai: 1, user: 'up' }), 1);
  assert.equal(runQuality({ ai: 3 }), 0.5);
  assert.equal(runQuality(null), null);
});

test('grades parse from Haiku and runs come from the activity log', () => {
  assert.deepEqual(parseGrade('Sure: {"grade": 4, "why": "Solid."}'), { grade: 4, why: 'Solid.' });
  assert.equal(parseGrade('{"grade": 9}'), null);
  assert.equal(parseGrade('no json'), null);
  const act = [
    { ts: 1, session: 'a', type: 'task', prompt: 'p' }, { ts: 2, session: 'a', type: 'skill', skill: 'x' }, { ts: 3, session: 'a', type: 'stop', outcome: 'done', result: 'r' },
    { ts: 4, session: 'b', type: 'task', prompt: 'no employee' }, { ts: 5, session: 'b', type: 'stop', outcome: 'done' },
    { ts: 6, session: 'a', type: 'task', prompt: 'q' }, { ts: 7, session: 'a', type: 'skill', skill: 'x' }, { ts: 8, session: 'a', type: 'stop', outcome: 'done' },
    { ts: 9, session: 'a', type: 'stop', outcome: 'error' },
  ];
  const runs = finishedRuns(act);
  assert.deepEqual(runs.map(r => [r.key, r.outcome]), [['a:1', 'done'], ['a:6', 'error']]); // the chat's error note wins
});

test('an employee whose graded work keeps coming back weak needs work', () => {
  const runs = (n, grade) => Array.from({ length: n }, () => ({ status: 'done', grade }));
  assert.equal(needsWork(rating(runs(5, { ai: 2 }))), true);
  assert.equal(needsWork(rating(runs(2, { ai: 1 }))), false); // too few graded to tell
  assert.equal(needsWork(rating(runs(5, { ai: 4 }))), false);
  assert.equal(needsWork(rating(runs(5))), false); // nothing graded
  assert.equal(weakRun({ ai: 3 }), true);
  assert.equal(weakRun({ ai: 4 }), false);
  assert.equal(weakRun({ ai: 5, user: 'down' }), true);
});

test("the coach learns from this employee's weak runs and returns new instructions", async () => {
  const act = [
    { ts: 1, session: 'a', type: 'task', prompt: 'bad one' }, { ts: 2, session: 'a', type: 'skill', skill: 'plug:writer' }, { ts: 3, session: 'a', type: 'stop', outcome: 'done', result: 'meh' },
    { ts: 4, session: 'a', type: 'task', prompt: 'great one' }, { ts: 5, session: 'a', type: 'skill', skill: 'writer' }, { ts: 6, session: 'a', type: 'stop', outcome: 'done', result: 'wow' },
    { ts: 7, session: 'a', type: 'task', prompt: 'someone else' }, { ts: 8, session: 'a', type: 'skill', skill: 'other' }, { ts: 9, session: 'a', type: 'stop', outcome: 'done' },
  ];
  const runs = finishedRuns(act);
  assert.deepEqual(runs[0].skillNames, ['plug:writer']);
  const grades = { 'a:1': { ai: 2, why: 'Vague.' }, 'a:4': { ai: 3, user: 'up' }, 'a:7': { ai: 1 } };
  const l = lessonsFor(runs, grades, 'writer');
  assert.deepEqual(l.weak.map(r => r.key), ['a:1']);
  assert.deepEqual(l.strong.map(r => r.key), ['a:4']);
  const prompt = coachPrompt({ name: 'writer', description: 'd', body: 'Old steps.' }, l);
  assert.ok(prompt.includes('bad one') && prompt.includes('Vague.') && prompt.includes('Old steps.') && !prompt.includes('someone else'));

  assert.deepEqual(parseCoach('SUMMARY: Added a check.\n<<<SKILL\n# Steps\n1. Check.\nSKILL>>>'), { summary: 'Added a check.', body: '# Steps\n1. Check.' });
  assert.equal(parseCoach('no block'), null);

  let asked;
  const r = await coach({ name: 'writer', description: 'd', body: 'Old.' }, runs, grades, async (p, o) => { asked = o; return 'SUMMARY: s\n<<<SKILL\nNew.\nSKILL>>>'; });
  assert.equal(r.body, 'New.');
  assert.equal(r.weak, 1);
  assert.equal(asked.model, 'sonnet');
  assert.ok((await coach({ name: 'nobody', description: '', body: 'x' }, runs, grades, async () => '')).error);
});
