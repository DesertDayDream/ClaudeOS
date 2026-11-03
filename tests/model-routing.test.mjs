import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { selectModel, cleanSelection, usageLimited, MODEL_GUIDANCE } from '../model-routing.mjs';
import { runModelTask } from '../model-runner.mjs';
import { createManager } from '../manager.mjs';
import { codexMcpConfig } from '../codex.mjs';

const catalog = { providers: { claude: { installed: true, models: ['haiku', 'sonnet', 'opus'] }, codex: { installed: true,
  models: [{ id: 'test-balanced', efforts: ['low', 'medium', 'high'] }, { id: 'test-specialist', efforts: ['high'] }] } } };
const base = { caller: { engine: 'codex', codexModel: 'test-balanced', mode: 'plan' }, catalog, cwd: os.tmpdir(), mcpServers: {}, scope: {}, selection: {} };
const success = () => ({ done: Promise.resolve({ result: 'Done.' }), stop() {} });

test('complexity selects a Claude tier and effort, while auto inherits Codex', () => {
  for (const [complexity, model] of [['simple', 'haiku'], ['standard', 'sonnet'], ['complex', 'opus']]) {
    assert.equal(selectModel({ complexity }, { engine: 'claude' }, catalog).model, model);
  }
  const p = selectModel({ complexity: 'complex' }, base.caller, catalog);
  assert.equal(p.engine, 'codex'); assert.equal(p.model, 'test-balanced'); assert.equal(p.effort, 'high');
  assert.equal(selectModel({ model: 'test-specialist', complexity: 'simple' }, base.caller, catalog).effort, 'high');
});

test('invalid choices and conflicting requirements are rejected before running', () => {
  assert.match(cleanSelection({ requiredEngine: 'claude', engine: 'codex' }).error, /conflicts/);
  assert.ok(cleanSelection({ fallback: 'yes' }).error);
  assert.ok(selectModel({ model: 'invented' }, base.caller, catalog).error);
  const missing = structuredClone(catalog); missing.providers.claude.installed = false;
  assert.equal(selectModel({}, { engine: 'claude' }, missing).engine, 'codex');
  assert.ok(selectModel({ requiredEngine: 'claude' }, base.caller, missing).error);
  const noCache = structuredClone(catalog); noCache.providers.codex.models = [];
  assert.equal(selectModel({}, base.caller, noCache).model, undefined);
  assert.ok(selectModel({ model: 'invented' }, base.caller, noCache).error);
});

test('quota classification excludes auth, denied commands and task failures', () => {
  for (const e of ["You've hit your limit · resets 4pm", "You've hit your 5-hour limit · resets 9:30pm", "You've hit your weekly limit", 'usage_limit_reached', 'rate_limit_exceeded', 'quota exhausted']) assert.ok(usageLimited(e), e);
  for (const e of ['Not logged in', 'Permission denied', 'Compile error', 'context window exceeded']) assert.equal(usageLimited(e), false, e);
});

test('Codex keeps HTTP specialist integrations and stdio tool filters', () => {
  assert.deepEqual(codexMcpConfig({ type: 'http', url: 'http://localhost:9999/mcp', headers: { 'x-lab': 'yes' } }),
    { url: 'http://localhost:9999/mcp', http_headers: { 'x-lab': 'yes' } });
  assert.deepEqual(codexMcpConfig({ command: 'node', args: ['helper'], disabled_tools: ['approve'] }),
    { command: 'node', args: ['helper'], disabled_tools: ['approve'] });
});

test('quota fallback happens once and carries action context with unchanged permissions', async () => {
  const calls = [], log = [];
  const opts = { ...base, caller: { engine: 'claude', mode: 'plan' }, prompt: 'Fix one file.', onLog: e => log.push(e.text),
    mcpServers: { claudeos: { env: { CLAUDEOS_MODEL_TASK: '1' } } },
    claudeRun: o => { calls.push(o); o.onLog({ kind: 'tool', text: 'Wrote fix.verse' }); return { done: Promise.resolve({ error: 'usage_limit_reached' }), stop() {} }; },
    codexRun: o => { calls.push(o); return success(); } };
  const r = await runModelTask(opts).done;
  assert.equal(r.attempts, 2); assert.equal(r.model.engine, 'codex');
  assert.match(calls[1].prompt, /Wrote fix.verse/); assert.match(calls[1].prompt, /Do not repeat/);
  assert.equal(calls[0].mode, 'plan'); assert.equal(calls[1].mode, 'plan');
  assert.equal(JSON.parse(calls[1].mcpServers.claudeos.env.CLAUDEOS_MODEL_CALLER).engine, 'codex');
  assert.ok(log.some(x => /switching to codex/.test(x)));
});

test('both exhausted providers produce a bounded error, never a retry loop', async () => {
  let calls = 0;
  const fail = () => { calls++; return { done: Promise.resolve({ error: 'usage_limit_reached' }), stop() {} }; };
  const r = await runModelTask({ ...base, prompt: 'Review', claudeRun: fail, codexRun: fail }).done;
  assert.equal(calls, 2); assert.equal(r.attempts, 2); assert.ok(r.error);
});

test('explicit provider/exact-model requirements and ordinary errors never fall back', async () => {
  for (const [selection, error] of [[{ requiredEngine: 'codex' }, 'usage_limit_reached'], [{ fallback: false }, 'usage_limit_reached'], [{}, 'Permission denied']]) {
    let other = 0;
    const r = await runModelTask({ ...base, selection, prompt: 'Task', codexRun: () => ({ done: Promise.resolve({ error }), stop() {} }), claudeRun: () => { other++; return success(); } }).done;
    assert.equal(other, 0); assert.equal(r.error, error);
  }
});

test('stopping an attempt prevents quota fallback', async () => {
  let complete, stop = 0, fallback = 0;
  const run = runModelTask({ ...base, prompt: 'Task', codexRun: () => ({ done: new Promise(r => { complete = r; }), stop: () => { stop++; complete({ error: 'usage_limit_reached' }); } }), claudeRun: () => { fallback++; return success(); } });
  run.stop(); assert.equal((await run.done).stopped, true); assert.equal(stop, 1); assert.equal(fallback, 0);
});

test('manager dispatch and nested specialist selections use the shared runner in a temporary brain', async () => {
  const lab = fs.mkdtempSync(path.join(os.tmpdir(), 'claudeos-routing-test-'));
  const calls = [], reports = [];
  let resolveReport;
  const finished = new Promise(r => { resolveReport = r; });
  const m = createManager({ cwd: lab, dataFile: path.join(lab, 'manager.json'), activityFile: path.join(lab, 'activity.jsonl'), memoryFile: path.join(lab, 'memory.jsonl'),
    helper: () => ({ command: 'node', args: [] }), memoryServer: () => ({ command: 'node', args: [] }), port: 4800, token: 'lab', broadcast() {},
    team: () => [{ name: 'Kai', skill: 'engineer' }], optionsFor: () => base.caller, taskCatalog: catalog,
    taskRunner: o => { calls.push(o); return runModelTask({ ...o, claudeRun: success, codexRun: success }); },
    onBriefDone: (b, text) => { reports.push({ b, text }); resolveReport(); } });
  try {
    fs.writeFileSync(path.join(lab, '.mcp.json'), JSON.stringify({ mcpServers: { specialist: { type: 'http', url: 'http://localhost:9999/mcp' } } }));
    assert.ok(m.postBrief({ tasks: [{ id: 'bad', employee: 'engineer', task: 'x', selection: { complexity: 'unknown' } }] }).error);
    assert.ok(m.postBrief({ chat: 'manager', tasks: [{ id: 't1', employee: 'engineer', task: 'Review code', selection: { complexity: 'complex', reason: 'Concurrency review' } }] }).ok);
    await finished;
    assert.equal(calls[0].caller.engine, 'codex'); assert.match(calls[0].prompt, /SKILL.md/); assert.match(calls[0].prompt, /Model selection applies/);
    assert.equal(calls[0].mcpServers.specialist.url, 'http://localhost:9999/mcp');
    assert.equal(reports[0].b.tasks[0].model.engine, 'codex'); assert.equal(m.workOf('engineer')[0].model.effort, 'high');
    const r = await m.specialist({ task: 'Check reasoning', chat: 'manager', selection: { engine: 'claude', complexity: 'complex' } });
    assert.match(r.text, /claude \/ opus/);
    assert.equal(calls[1].mcpServers.claudeos.env.CLAUDEOS_MODEL_TASK, undefined);
    assert.ok((await m.specialist({ task: 'x', selection: { requiredEngine: 'codex' }, requiredEngine: 'claude' })).error);
    fs.writeFileSync(path.join(lab, '.mcp.json'), 'broken json');
    assert.match((await m.specialist({ task: 'x' })).error, /could not be read/);
  } finally { m.stop(); fs.rmSync(lab, { recursive: true, force: true }); }
});

test('guidance teaches verification, measured choices and shared routing', () => {
  assert.match(MODEL_GUIDANCE, /acceptance criteria/); assert.match(MODEL_GUIDANCE, /do not invent universal rankings/);
  assert.match(MODEL_GUIDANCE, /Never launch claude\/codex directly/);
});
