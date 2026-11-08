import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createManager } from '../manager.mjs';
import { collectWork, checkPrompt, parseCheck } from '../task-check.mjs';

const turn = () => new Promise(r => setTimeout(r, 30));

test('the reviewer sees the files the task changed and answers pass or concrete problems', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-check-'));
  try {
    fs.writeFileSync(path.join(dir, 'old.md'), 'before the task');
    const since = Date.now() + 5;
    const later = new Date(since + 1000);
    fs.writeFileSync(path.join(dir, 'page.html'), '<h1>Made</h1>'); fs.utimesSync(path.join(dir, 'page.html'), later, later);
    fs.writeFileSync(path.join(dir, 'art.png'), Buffer.alloc(10)); fs.utimesSync(path.join(dir, 'art.png'), later, later);
    const work = collectWork({ folder: dir, since });
    assert.match(work, /--- page.html\n<h1>Made<\/h1>/);
    assert.match(work, /art.png \(10 bytes, not text/);
    assert.doesNotMatch(work, /before the task/);
    assert.match(checkPrompt({ task: 'Make a page', report: 'Done', work }), /TASK\nMake a page[\s\S]*WHAT CHANGED/);
    assert.deepEqual(parseCheck('ok: {"pass": true, "issues": []}'), { pass: true, issues: [] });
    assert.deepEqual(parseCheck('{"pass": false, "issues": ["no title"]}'), { pass: false, issues: ['no title'] });
    assert.equal(parseCheck('{"pass": "yes"}'), null);
    assert.equal(parseCheck('no json'), null);
    assert.equal(collectWork({ folder: dir, since, max: 20 }).endsWith('more work than the reviewer reads]'), true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a brief task is checked before it counts, and a failed check gets one fix turn in the same chat', async () => {
  const lab = fs.mkdtempSync(path.join(os.tmpdir(), 'task-check-mgr-'));
  const calls = [], checks = [];
  let verdicts = [{ pass: false, issues: ['The page has no FAQ section'] }, { pass: true, issues: [] }];
  const m = createManager({ cwd: lab, dataFile: path.join(lab, 'manager.json'), activityFile: path.join(lab, 'activity.jsonl'),
    broadcast() {}, team: () => [{ name: 'One', skill: 'one' }], cabinet: () => path.join(lab, 'Office'), onBriefDone() {},
    checker: async args => { checks.push(args); return verdicts.shift(); },
    inlineRunner: args => { let resolve; const done = new Promise(r => { resolve = r; }); calls.push({ args, resolve }); return { done, stop() { resolve({ stopped: true }); } }; } });
  try {
    assert.ok(m.postBrief({ chat: 'shared', tasks: [{ id: 'a', employee: 'one', task: 'Build a page with an FAQ' }, { id: 'b', employee: 'one', task: 'Next' }] }).ok);
    calls[0].resolve({ result: 'Built the page.' }); await turn();
    assert.equal(checks.length, 1); assert.equal(checks[0].task, 'Build a page with an FAQ'); assert.equal(checks[0].report, 'Built the page.');
    assert.equal(calls.length, 2, 'the fix turn runs before the next task');
    assert.equal(calls[1].args.chat, 'shared'); assert.equal(calls[1].args.headless, true);
    assert.match(calls[1].args.prompt, /The page has no FAQ section[\s\S]*\[TASK_COMPLETE\]/);
    calls[1].resolve({ result: 'Added the FAQ.' }); await turn();
    const t = m.snapshot().briefs[0].tasks[0];
    assert.equal(t.status, 'done'); assert.equal(t.result, 'Added the FAQ.');
    assert.deepEqual({ pass: t.check.pass, fixed: t.check.fixed, first: t.check.first }, { pass: true, fixed: true, first: ['The page has no FAQ section'] });
    assert.equal(calls.length, 3, 'then the next task starts'); assert.equal(calls[2].args.prompt.includes('active_brief'), true);
    // a passing check needs no fix turn; a reviewer that can't answer never blocks the work
    verdicts = [null];
    calls[2].resolve({ result: 'Next done' }); await turn();
    const t2 = m.snapshot().briefs[0].tasks[1];
    assert.equal(t2.status, 'done'); assert.equal(t2.check.skipped, true); assert.equal(calls.length, 3);
  } finally { m.stop(); fs.rmSync(lab, { recursive: true, force: true }); }
});
