import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildHarborTask } from '../benchmark/harbor/task.mjs';
import { createHarbor } from '../benchmark/harbor/runner.mjs';
import { createTasks } from '../benchmark/grader/tasks.mjs';

const kit = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'benchmark');
const task = createTasks(path.join(kit, 'tasks')).loadTask('bill-splitter');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-test-'));

test('a Harbor task is generated from the AI Bench task with LF scripts and the oracle answer', () => {
  const dir = tmp();
  try {
    const t = buildHarborTask(task, dir, kit);
    for (const f of ['task.toml', 'instruction.md', 'environment/Dockerfile', 'tests/test.sh', 'tests/check.mjs', 'tests/checks.json', 'solution/solve.sh', 'solution/site/index.html'])
      assert.ok(fs.existsSync(path.join(t, f)), f);
    assert.doesNotMatch(fs.readFileSync(path.join(t, 'tests/test.sh'), 'utf8'), /\r/);
    assert.match(fs.readFileSync(path.join(t, 'task.toml'), 'utf8'), /source = "\/app"/);
    assert.equal(fs.readFileSync(path.join(t, 'instruction.md'), 'utf8').trim(), task.prompt);
    // hidden tests never reach the agent's container
    assert.ok(!fs.existsSync(path.join(t, 'environment', 'hidden')));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the in-container check rewards the reference page and gives nothing for an empty folder', () => {
  const dir = tmp();
  try {
    const t = buildHarborTask(task, dir, kit), out = path.join(dir, 'out'), empty = path.join(dir, 'empty');
    fs.mkdirSync(empty);
    execFileSync(process.execPath, [path.join(t, 'tests/check.mjs'), path.join(t, 'solution/site'), out]);
    assert.equal(Number(fs.readFileSync(path.join(out, 'reward.txt'), 'utf8')), 1);
    execFileSync(process.execPath, [path.join(t, 'tests/check.mjs'), empty, out]);
    assert.equal(Number(fs.readFileSync(path.join(out, 'reward.txt'), 'utf8')), 0);
    fs.writeFileSync(path.join(empty, 'index.html'), '<script src="https://cdn.example/x.js"></script><h1 data-testid="title"></h1>');
    execFileSync(process.execPath, [path.join(t, 'tests/check.mjs'), empty, out]);
    assert.equal(JSON.parse(fs.readFileSync(path.join(out, 'structure.json'), 'utf8')).offline, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the ClaudeOS bundle carries foundations, runtime context with container paths, brain files and memory', () => {
  const dir = tmp(), brain = path.join(dir, 'brain-src');
  try {
    fs.mkdirSync(path.join(brain, '.claude', 'skills', 'researcher'), { recursive: true });
    fs.mkdirSync(path.join(brain, 'brain'), { recursive: true });
    fs.writeFileSync(path.join(brain, 'CLAUDE.md'), '# brain rules');
    fs.writeFileSync(path.join(brain, '.claude', 'skills', 'researcher', 'SKILL.md'), '---\nname: researcher\n---\nBody');
    fs.writeFileSync(path.join(brain, 'brain', 'memory.jsonl'), '{"type":"entity","name":"X","entityType":"t","observations":[]}\n');
    const h = createHarbor({ kit, home: path.join(dir, 'home'), loadTask: () => null,
      harness: () => ({ foundations: 'FOUNDATIONS', context: `The brain (${brain}) is added beside it.`, options: { model: 'opus', effort: 'high' },
        brainDir: brain, brainName: 'Lab', memoryFile: path.join(brain, 'brain', 'memory.jsonl') }) });
    const out = path.join(dir, 'bundle');
    const r = h._test.writeBundle(out);
    assert.deepEqual(r.options, { model: 'opus', effort: 'high' });
    assert.equal(fs.readFileSync(path.join(out, 'foundations.md'), 'utf8'), 'FOUNDATIONS');
    assert.equal(fs.readFileSync(path.join(out, 'runtime.md'), 'utf8'), 'The brain (/claudeos/brain) is added beside it.');
    assert.ok(fs.existsSync(path.join(out, 'brain', 'CLAUDE.md')));
    assert.ok(fs.existsSync(path.join(out, 'brain', '.claude', 'skills', 'researcher', 'SKILL.md')));
    assert.equal(JSON.parse(fs.readFileSync(path.join(out, 'mcp.json'), 'utf8')).mcpServers.memory.env.MEMORY_FILE_PATH, '/claudeos/memory.jsonl');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('results use medians, cost per solved task and a bootstrap chance of being cheaper', () => {
  const dir = tmp();
  try {
    const h = createHarbor({ kit, home: dir, loadTask: () => null, harness: () => ({}) });
    const t = (agent, cost, score, solved) => ({ agent, status: 'done', cost, score, solved, seconds: 100, input: 1000, cached: 800, output: 50 });
    const job = { contestants: ['claudeos', 'claude-code'], trials: [
      t('claudeos', 0.5, 100, true), t('claudeos', 0.6, 100, true), t('claudeos', 0.55, 90, false),
      t('claude-code', 1.5, 100, true), t('claude-code', 1.4, 80, false), t('claude-code', 1.6, 100, true),
      { agent: 'claude-code', status: 'limit' }] };
    h._test.summarize(job);
    assert.equal(job.summary.by.claudeos.cost, 0.55);
    assert.equal(job.summary.by['claude-code'].runs, 3);
    assert.equal(job.summary.by.claudeos.solved, 2);
    assert.ok(Math.abs(job.summary.by.claudeos.costPerSolved - 0.825) < 1e-9);
    assert.equal(job.summary.cheaper, 1);
    assert.ok(job.summary.better >= 0 && job.summary.better <= 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the setup checklist reports missing pieces without touching the machine', async () => {
  const dir = tmp();
  try {
    const h = createHarbor({ kit, home: dir, loadTask: () => null, harness: () => ({}) });
    const s = await h.status();
    assert.equal(s.rows.harbor.state, 'missing');
    assert.equal(s.rows.claude.state, 'missing');
    assert.equal(s.ready, false);
    assert.equal(h.runJob({ task: 'nope' }).error, 'Unknown task.');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the sign-in token is kept with Windows data protection and reads back', { skip: process.platform !== 'win32' }, async () => {
  const { protect, unprotect } = await import('../benchmark/harbor/runner.mjs');
  const secret = 'sk-ant-oat01-' + 'x'.repeat(40);
  const enc = await protect(secret);
  assert.ok(enc.ok && enc.out.trim() && !enc.out.includes(secret));
  assert.equal((await unprotect(enc.out.trim())).out.trim(), secret);
});
