import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCoaching, isDue } from '../coaching.mjs';

// three finished runs by "writer", graded by thumbs
const runsOf = (start, n) => Array.from({ length: n }, (_, i) => ({ key: `s:${start + i}`, outcome: 'done', end: start + i, skillNames: ['writer'], prompt: 'p', result: 'r' }));
const down = runs => Object.fromEntries(runs.map(r => [r.key, { user: 'down' }]));

test('an employee is due for coaching when their work since the last coaching needs work', () => {
  const runs = runsOf(100, 3);
  assert.equal(isDue(runs, down(runs), 'writer'), true);
  assert.equal(isDue(runs, down(runs), 'writer', 101), false); // only one run after the last coaching
  assert.equal(isDue(runs, down(runs), 'someone-else'), false);
  assert.equal(isDue(runs, Object.fromEntries(runs.map(r => [r.key, { ai: 5 }])), 'writer'), false);
});

test('the coach saves new instructions right away, once per batch of runs, and Undo puts the old ones back', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coaching-test-'));
  try {
    const skill = path.join(dir, 'SKILL.md');
    const original = '---\nname: writer\ndescription: Writes.\n---\n\nOld steps.\n';
    fs.writeFileSync(skill, original);
    const employee = { id: 'project:b:writer', name: 'writer', file: skill,
      read: () => ({ name: 'writer', description: 'Writes.', body: 'Old steps.' }),
      write: f => fs.writeFileSync(skill, `---\nname: ${f.name}\ndescription: ${f.description}\n---\n\n${f.body}\n`) };
    let calls = 0, sinceSeen;
    const coach = async (s, runs, grades, ask, since) => { calls++; sinceSeen = since; return { summary: 'Added steps.', body: 'New steps.', weak: 3 }; };
    let changed = 0;
    const c = createCoaching({ file: path.join(dir, 'coaching.json'), backupDir: path.join(dir, 'backups'), coach, onChange: () => changed++ });

    const runs = runsOf(Date.now() - 10000, 3);
    const t = await c.tick([employee], runs, down(runs));
    assert.equal(t.result.ok, true);
    assert.match(fs.readFileSync(skill, 'utf8'), /New steps\./);
    assert.equal(c.view([employee.id])[employee.id].summary, 'Added steps.');
    assert.equal(changed, 1);
    assert.equal(sinceSeen, 0);

    // the same runs don't trigger it again
    assert.equal(await c.tick([employee], runs, down(runs)), null);
    assert.equal(calls, 1);

    assert.deepEqual(c.undo(employee.id), { ok: true });
    assert.equal(fs.readFileSync(skill, 'utf8'), original);
    assert.equal(c.view([employee.id])[employee.id].undone, true);
    assert.ok(c.undo(employee.id).error); // only once
    // undone still counts as coached: the same runs don't trigger it again
    assert.equal(await c.tick([employee], runs, down(runs)), null);

    // three new weak runs: coached again, learning only from those
    const later = runsOf(Date.now() + 1000, 3);
    const all = [...runs, ...later];
    const t2 = await c.tick([employee], all, down(all));
    assert.equal(t2.result.ok, true);
    assert.ok(sinceSeen > 0);

    // a coach that can't help changes nothing
    const failing = createCoaching({ file: path.join(dir, 'c2.json'), backupDir: path.join(dir, 'b2'), coach: async () => ({ error: 'no' }) });
    fs.writeFileSync(skill, original);
    assert.equal((await failing.run(employee, runs, down(runs))).error, 'no');
    assert.equal(fs.readFileSync(skill, 'utf8'), original);
    // history survives a restart
    const again = createCoaching({ file: path.join(dir, 'coaching.json'), backupDir: path.join(dir, 'backups'), coach });
    assert.equal(again.view([employee.id])[employee.id].n, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
