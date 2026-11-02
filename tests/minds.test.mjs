import test from 'node:test';
import assert from 'node:assert/strict';
import { modelTier, effortLevel, rating, craftOf, modelFamily } from '../public/minds.js';

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
