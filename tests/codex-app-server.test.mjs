import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { runAppServerTurn, codexPermissions } from '../codex-app-server.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
function harness(overrides = {}) {
  const proc = new EventEmitter(), sent = [], events = [];
  proc.stdout = new PassThrough(); proc.stderr = new PassThrough(); proc.exitCode = null;
  const notify = (method, params) => proc.stdout.write(JSON.stringify({ method, params }) + '\n');
  const message = value => proc.stdout.write(JSON.stringify(value) + '\n');
  proc.stdin = new Writable({ write(chunk, _encoding, callback) {
    for (const line of chunk.toString().trim().split('\n')) {
      const data = JSON.parse(line); sent.push(data);
      if (data.method === 'initialize') queueMicrotask(() => message({ id: data.id, result: {} }));
      if (data.method === 'thread/start' || data.method === 'thread/resume') queueMicrotask(() => message({ id: data.id, result: { thread: { id: 'thread-1' } } }));
      if (data.method === 'turn/start') queueMicrotask(() => message({ id: data.id, result: { turn: { id: 'turn-1' } } }));
      if (data.method === 'turn/interrupt') queueMicrotask(() => { message({ id: data.id, result: {} }); notify('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'interrupted' } }); });
    }
    callback();
  } });
  proc.stdin.on('finish', () => { proc.exitCode = 0; proc.emit('close', 0); });
  proc.kill = () => { proc.exitCode = 1; proc.emit('close', 1); };
  const turn = runAppServerTurn({ command: 'codex', cwd: 'C:\\lab', prompt: 'test', spawnProcess: () => proc,
    onEvent: event => events.push(event), ...overrides });
  return { ...turn, sent, events, notify, message };
}
const approval = (method, id = 90, extra = {}) => ({ id, method, params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', command: 'echo safe-lab', cwd: 'C:\\lab', ...extra } });

test('initializes, resumes existing threads, maps modes and streams completion', async () => {
  const h = harness({ thread: 'thread-1', mode: '' }); await tick();
  assert.equal(h.sent.find(x => x.method === 'thread/resume').params.threadId, 'thread-1');
  assert.equal(h.sent.find(x => x.method === 'thread/resume').params.approvalPolicy, 'untrusted');
  assert.equal(h.sent.find(x => x.method === 'turn/start').params.approvalsReviewer, 'user');
  h.notify('item/agentMessage/delta', { threadId: 'thread-1', itemId: 'message', delta: 'Hello' });
  h.notify('item/completed', { threadId: 'thread-1', item: { id: 'message', type: 'agentMessage', text: 'Hello' } });
  h.notify('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } });
  assert.equal((await h.done).error, null); assert.equal(h.events[0].type, 'agent.delta');
  assert.equal(h.events[1].item.type, 'agent_message');
  assert.equal(codexPermissions('plan', 'lab').approvalPolicy, 'never');
  assert.equal(codexPermissions('plan', 'lab').sandbox, 'read-only');
  assert.equal(codexPermissions('bypassPermissions', 'lab').sandbox, 'danger-full-access');
});
test('command waits for an explicit UI decision, supports session approval', async () => {
  let decide;
  const h = harness({ onApproval: () => new Promise(resolve => { decide = resolve; }) }); await tick();
  h.message(approval('item/commandExecution/requestApproval')); await tick();
  assert.equal(h.sent.some(x => x.id === 90), false);
  decide('acceptForSession'); await tick();
  assert.equal(h.sent.find(x => x.id === 90).result.decision, 'acceptForSession');
  h.stop(); await h.done;
});
test('file approval is scoped and unknown decisions fail closed', async () => {
  const h = harness({ onApproval: async () => 'approve-everything' }); await tick();
  h.message(approval('item/fileChange/requestApproval')); await tick();
  assert.equal(h.sent.find(x => x.id === 90).result.decision, 'decline');
  h.stop(); await h.done;
});
test('stop aborts unanswered cards and prevents late execution', async () => {
  let decide, signal;
  const h = harness({ onApproval: request => { signal = request.signal; return new Promise(resolve => { decide = resolve; }); } }); await tick();
  h.message(approval('item/commandExecution/requestApproval')); await tick();
  h.stop(); await h.done;
  assert.equal(signal.aborted, true); decide('accept'); await tick();
  assert.equal(h.sent.some(x => x.id === 90), false);
});
test('a resolved request clears the UI and cannot be answered again', async () => {
  let decide, signal;
  const h = harness({ onApproval: request => { signal = request.signal; return new Promise(resolve => { decide = resolve; }); } }); await tick();
  h.message(approval('item/commandExecution/requestApproval')); await tick();
  h.notify('serverRequest/resolved', { threadId: 'thread-1', requestId: 90 });
  assert.equal(signal.aborted, true); decide('accept'); await tick();
  assert.equal(h.sent.some(x => x.id === 90), false);
  h.stop(); await h.done;
});
test('cross-thread requests fail closed and supported decisions are enforced', async () => {
  let calls = 0;
  const h = harness({ onApproval: async () => { calls++; return 'acceptForSession'; } }); await tick();
  h.message(approval('item/commandExecution/requestApproval', 90, { threadId: 'other-thread' })); await tick();
  assert.equal(calls, 0); assert.equal(h.sent.find(x => x.id === 90).error.code, -32602);
  h.message(approval('item/commandExecution/requestApproval', 92, { turnId: 'other-turn' })); await tick();
  assert.equal(calls, 0); assert.equal(h.sent.find(x => x.id === 92).error.code, -32602);
  h.message(approval('item/commandExecution/requestApproval', 91, { availableDecisions: ['accept', 'decline'] })); await tick();
  assert.equal(h.sent.find(x => x.id === 91).result.decision, 'decline');
  h.stop(); await h.done;
});
test('permission approval grants only the requested permissions for one turn', async () => {
  const permissions = { network: { enabled: true } };
  const h = harness({ onApproval: async () => 'accept' }); await tick();
  h.message(approval('item/permissions/requestApproval', 90, { permissions })); await tick();
  assert.deepEqual(h.sent.find(x => x.id === 90).result, { permissions, scope: 'turn' });
  h.stop(); await h.done;
});
test('unknown interactive requests are rejected, never silently accepted', async () => {
  const h = harness(); await tick();
  h.message({ id: 90, method: 'future/approveEverything', params: {} }); await tick();
  assert.equal(h.sent.find(x => x.id === 90).error.code, -32601);
  h.stop(); await h.done;
});
