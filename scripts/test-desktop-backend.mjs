// Integration test in a lab copy, with a temporary Home brain and no real sign-ins.
// The private parent IPC is simulated in-process, so this test also runs in sandboxes
// which permit Node but do not permit Node to fork another process.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Account/connector discovery is outside this test. Treat every external CLI as
// absent, without touching the user's authenticated Claude, Codex, or GitHub.
function absentCli(...args) {
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
  const callback = args.at(-1), error = Object.assign(new Error('CLI unavailable in isolated desktop backend test'), { code: 'ENOENT' });
  queueMicrotask(() => { if (typeof callback === 'function') callback(error, '', ''); });
  return child;
}
childProcess.execFile = childProcess.exec = absentCli;
childProcess.spawn = (command, args) => {
  if (!String(command).endsWith('codex.exe') || !args.includes('app-server')) throw new Error('Unexpected external process in isolated backend test');
  const proc = new EventEmitter(); proc.stdout = new PassThrough(); proc.stderr = new PassThrough(); proc.exitCode = null;
  const send = data => proc.stdout.write(JSON.stringify(data) + '\n');
  proc.stdin = new Writable({ write(chunk, _encoding, callback) {
    for (const line of chunk.toString().trim().split('\n')) {
      const data = JSON.parse(line);
      if (data.method === 'initialize') queueMicrotask(() => send({ id: data.id, result: {} }));
      if (['thread/start', 'thread/resume'].includes(data.method)) queueMicrotask(() => send({ id: data.id, result: { thread: { id: 'lab-thread' } } }));
      if (data.method === 'turn/start') queueMicrotask(() => {
        send({ id: data.id, result: { turn: { id: 'lab-turn' } } });
        send({ method: 'turn/plan/updated', params: { threadId: 'lab-thread', plan: [{ step: 'Check the marker', status: 'pending' }] } });
        send({ method: 'item/started', params: { threadId: 'lab-thread', item: { id: 'skill-read', type: 'commandExecution', command: 'cat .claude/skills/researcher/SKILL.md' } } });
        send({ id: 900, method: 'item/commandExecution/requestApproval', params: { threadId: 'lab-thread', turnId: 'lab-turn', itemId: 'lab-command', command: 'echo safe-lab', cwd: source, reason: 'Backend approval integration test' } });
      });
      if (data.id === 900 && data.result) queueMicrotask(() => {
        send({ method: 'turn/plan/updated', params: { threadId: 'lab-thread', plan: [{ step: 'Check the marker', status: 'completed' }] } });
        send({ method: 'item/completed', params: { threadId: 'lab-thread', item: { id: 'reply', type: 'agentMessage', text: 'Approval result: ' + data.result.decision } } });
        send({ method: 'turn/completed', params: { threadId: 'lab-thread', turn: { id: 'lab-turn', status: 'completed' } } });
      });
      if (data.method === 'turn/interrupt') queueMicrotask(() => {
        send({ id: data.id, result: {} }); send({ method: 'turn/completed', params: { threadId: 'lab-thread', turn: { id: 'lab-turn', status: 'interrupted' } } });
      });
    }
    callback();
  } });
  proc.stdin.on('finish', () => { proc.exitCode = 0; proc.emit('close', 0); });
  proc.kill = () => { proc.exitCode = 1; proc.emit('close', 1); };
  return proc;
};
syncBuiltinESMExports();
const lab = fs.mkdtempSync(path.join(os.tmpdir(), 'claudeos-desktop-lab-'));
const source = path.join(lab, 'source');
fs.mkdirSync(source);
for (const name of fs.readdirSync(root)) if (name.endsWith('.mjs') || name === 'package.json') fs.copyFileSync(path.join(root, name), path.join(source, name));
for (const name of ['public', 'hooks', 'templates', 'benchmark']) fs.cpSync(path.join(root, name), path.join(source, name), { recursive: true });
fs.symlinkSync(path.join(root, 'node_modules'), path.join(source, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
Object.assign(process.env, { PORT: '4800', ARTIFACT_PORT: '4810', CLAUDEOS_DESKTOP: '1', CLAUDEOS_NO_OPEN: '1',
  CLAUDEOS_HOME: path.join(lab, 'data'), BENCH_NO_WINDOWS: '1', CLAUDE_CONFIG_DIR: path.join(lab, 'claude'), CODEX_HOME: path.join(lab, 'codex') });
let resolveReady, rejectReady, updateChecks = 0;
const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
process.connected = true;
process.send = (message, callback) => {
  if (message.type === 'desktop-ready') resolveReady(message.value);
  if (message.type === 'desktop-error') rejectReady(new Error(message.value.message));
  if (message.type === 'desktop-update-check') updateChecks++;
  if (message.id != null) queueMicrotask(() => process.emit('message', { type: 'desktop-reply', id: message.id,
    value: message.type === 'desktop-settings' ? { desktop: true, tray: true, hotkeyOk: true, startAtLogin: false, canStartAtLogin: false } : { ok: true } }));
  callback?.();
};
const timeout = setTimeout(() => rejectReady(new Error('Lab backend startup timed out')), 30000);
let exitCode = 0;
try {
  await import(pathToFileURL(path.join(source, 'server.mjs')).href);
  const info = await ready;
  clearTimeout(timeout);
  assert.equal(info.url, 'http://localhost:4800');
  const page = await fetch(info.url);
  const html = await page.text();
  assert.match(html, /data-desktop="true"/);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self' 'sha256-/);
  const token = html.match(/window\.CLAUDEOS_TOKEN\s*=\s*["']([^"']+)/)?.[1];
  assert.ok(token, 'Page contains the API token');
  const api = async (route, body, auth = token) => {
    const response = await fetch(info.url + route, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'x-claudeos-token': auth, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, value: await response.json() };
  };
  assert.equal((await api('/api/settings', undefined, 'invalid')).status, 403);
  const original = (await api('/api/state')).value.brain;
  const peerFolder = path.join(lab, 'peer'); fs.mkdirSync(peerFolder);
  const peer = (await api('/api/brains/add', { folder: peerFolder })).value.brain;
  await api('/api/brains/links', { id: peer.id, links: [original.id] });
  await api('/api/brains/switch', { id: original.id });
  await api('/api/brains/links', { id: original.id, links: [peer.id] });
  assert.ok((await api('/api/state')).value.linked.some(b => b.id === peer.id));
  assert.deepEqual((await api('/api/brains/links', { id: original.id, links: [] })).value.links, []);
  const unlinked = (await api('/api/state')).value;
  assert.equal(unlinked.linked.length, 0);
  assert.ok(unlinked.brains.some(b => b.id === peer.id));
  assert.deepEqual(unlinked.brains.find(b => b.id === peer.id).links, [original.id]);
  assert.ok(fs.existsSync(path.join(peerFolder, 'brain', 'memory.jsonl')));
  assert.match((await api('/api/handoff', { brain: peer.id, task: 'must be rejected' })).value.error, /isn't linked/);
  console.log('PASS: unlink removes access, keeps both brains and files, and preserves the reverse link.');
  const settings = (await api('/api/settings')).value;
  assert.equal(settings.desktop, true); assert.equal(settings.tray, true); assert.equal(settings.hotkeyOk, true);
  assert.equal((await api('/api/settings', { hotkey: 'Ctrl+Shift+K' })).value.hotkey, 'Ctrl+Shift+K');
  assert.equal((await api('/api/update')).value.desktop, true);
  assert.equal((await api('/api/update', {})).value.ok, true); assert.equal(updateChecks, 1);
  const deniedRollback = (await api('/api/update', { rollback: true })).value;
  assert.match(deniedRollback.error, /no earlier version/);
  const waitFor = async predicate => {
    for (let i = 0; i < 60; i++) { const state = (await api('/api/chat')).value; if (predicate(state)) return state; await new Promise(resolve => setTimeout(resolve, 30)); }
    throw new Error('Timed out waiting for lab chat state');
  };
  assert.equal((await api('/api/chat/options', { engine: 'codex' })).value.error, undefined);
  assert.equal((await api('/api/chat', { text: 'Lab approval test' })).value.ok, true);
  const pending = await waitFor(state => state.approvals.length === 1);
  assert.equal(pending.todos[0].status, 'pending', 'A plan with no active step stays pending');
  assert.ok(pending.messages.some(m => m.tools?.some(t => t.skill?.name === 'researcher')));
  const card = pending.approvals[0];
  assert.equal(card.engine, 'codex'); assert.equal(card.input.command, 'echo safe-lab');
  assert.ok(card.choices.includes('acceptForSession'));
  assert.match((await api('/api/approval/answer', { id: card.id, decision: 'unknown' })).value.error, /not available/);
  assert.equal((await api('/api/approval/answer', { id: card.id, decision: 'accept' })).value.ok, true);
  const finished = await waitFor(state => !state.busy);
  assert.equal(finished.todos[0].status, 'completed', 'Completed plan survives turn completion');
  assert.equal(finished.approvals.length, 0);
  assert.ok(finished.messages.some(message => message.text.includes('Approval result: accept')));
  assert.ok((await api('/api/approval/answer', { id: card.id, decision: 'accept' })).value.error);
  await api('/api/chat', { text: 'Lab cancellation test' });
  await waitFor(state => state.approvals.length === 1);
  await api('/api/chat/stop', {});
  const stopped = await waitFor(state => !state.busy);
  assert.equal(stopped.approvals.length, 0);
  console.log('PASS: Codex approval card, available choices, invalid/stale answer rejection, allowed command, and cancellation cleanup through HTTP.');
  const chatId = stopped.id;
  const catalog = (await api('/api/desk/model_catalog', { chat: chatId })).value;
  assert.ok(Array.isArray(JSON.parse(catalog.text).providers.codex.models));
  assert.match((await api('/api/desk/run_model_task', { chat: chatId, task: 'Invalid choice', selection: { complexity: 'unknown' } })).value.error, /complexity/);
  const specialist = api('/api/desk/run_model_task', { chat: chatId, task: 'Bounded review', selection: { engine: 'codex', complexity: 'simple', reason: 'Small review' } });
  const specialistPending = await waitFor(state => state.approvals.some(a => a.who === 'Model specialist'));
  const specialistCard = specialistPending.approvals.find(a => a.who === 'Model specialist');
  assert.equal(specialistCard.engine, 'codex');
  await api('/api/approval/answer', { id: specialistCard.id, decision: 'accept' });
  const specialistResult = (await specialist).value;
  assert.match(specialistResult.text, /Model: codex/);
  assert.match(specialistResult.text, /Approval result: accept/);
  console.log('PASS: model catalog, invalid selection, specialist dispatch, approval and returned model/result through authenticated HTTP in the lab copy.');
  const beforeBench = (await api('/api/chat')).value;
  const offered = (await api('/benchmark/api/state')).value.contestants;
  const benchA = offered.find(c => c.id.startsWith('claudeos-codex:'))?.id;
  assert.ok(benchA && offered.some(c => c.id === 'desktop-codex'), 'Benchmark offers ClaudeOS on Codex and the Codex setup');
  assert.equal((await api('/benchmark/api/prepare', {a: benchA, b: 'desktop-codex'})).value.ok, true);
  const benchmarkRun = (await api('/benchmark/api/run', {prompt:'Fixture benchmark. Reply OK.'})).value;
  assert.equal(benchmarkRun.results[0].start, 'started');
  const benchPending = await waitFor(state => state.approvals.length === 1);
  assert.equal(benchPending.id, beforeBench.id, 'Benchmark keeps the open chat');
  assert.deepEqual(benchPending.options, beforeBench.options, 'Benchmark keeps user model options');
  const benchState = (await api('/benchmark/api/state')).value;
  assert.notEqual(benchState.round.sides[0].chatId, beforeBench.id);
  assert.equal(benchState.round.sides[1].start, 'DRY', 'The Codex window is prepared (windows are off in this check)');
  await api('/benchmark/api/stop', {});
  await waitFor(state => !state.any && !state.approvals.length);
  assert.equal((await api('/benchmark/api/history')).value.length, 1);
  console.log('PASS: benchmark starts a dedicated chat, preserves user settings, prepares the window for the other side and stops only its own run.');
  console.log(`PASS: lab backend startup, CSP, API authentication, native settings IPC, hotkey setting, update routing, rollback guidance. Lab: ${lab}`);
} catch (error) { exitCode = 1; console.error(error.stack); }
finally {
  clearTimeout(timeout);
  // server.quit() exits after its cleanup delay; preserve this test's actual result.
  const exit = process.exit.bind(process);
  process.exit = () => exit(exitCode);
  process.emit('message', { type: 'desktop-quit' });
  setTimeout(() => exit(exitCode), 2500);
}
