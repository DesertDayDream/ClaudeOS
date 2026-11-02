import test from 'node:test';
import assert from 'node:assert/strict';
import { mindScore, recordScore, craftOf, intelligence, modelFamily } from '../public/minds.js';

test('model families from aliases and ids', () => {
  assert.equal(modelFamily('claude-opus-5-5'), 'opus');
  assert.equal(modelFamily('sonnet[1m]'), 'sonnet');
  assert.equal(modelFamily(''), '');
});

test('a stronger model and more effort think better', () => {
  assert.ok(mindScore({ model: 'opus', effort: 'max' }) > mindScore({ model: 'opus', effort: 'low' }));
  assert.ok(mindScore({ model: 'opus', effort: 'high' }) > mindScore({ model: 'haiku', effort: 'high' }));
  assert.ok(mindScore({ model: 'fable', effort: 'max' }) <= 1);
});

test('a track record is earned: more good runs, higher score', () => {
  const done = n => Array.from({ length: n }, () => ({ status: 'done' }));
  assert.ok(recordScore([]).score < recordScore(done(3)).score);
  assert.ok(recordScore(done(3)).score < recordScore(done(15)).score);
  assert.ok(recordScore([...done(5), { status: 'error' }, { status: 'error' }]).score < recordScore(done(7)).score);
  assert.equal(recordScore([{ status: 'working' }]).runs, 0); // a run still going doesn't count yet
});

test('a fuller SKILL.md scores higher than a stub', () => {
  const stub = craftOf('---\nname: x\n---\nDo things.', 'x', []);
  const full = craftOf('---\nname: x\n---\n# Steps\n' + '1. Do a careful thing with the files here.\n'.repeat(40) + '## Example\n```\nrun it\n```\n'.repeat(3) + '## Notes\n## More\n## Done\n',
    'Edits videos into reels. Use when the user wants a highlight reel.', ['scripts/cut.py', 'references/a.md', 'assets/b.png', 'c.md']);
  assert.ok(stub.score < 0.2, `stub ${stub.score}`);
  assert.ok(full.score > 0.8, `full ${full.score}`);
  assert.equal(full.scripts, 1);
});

test('intelligence mixes what is known into 0-100', () => {
  assert.equal(intelligence({ mind: 1, record: 1, craft: 1 }), 100);
  assert.equal(intelligence({ mind: 0.5, record: 0.5 }), 50); // a contractor has no SKILL.md here
});
