// A private stdio App Server per turn. Approval decisions come only from the
// authenticated ClaudeOS UI; the model never gets an approval-granting tool.
import { spawn } from 'node:child_process';

export function codexPermissions(mode, cwd, addDirs = []) {
  if (mode === 'plan') return { approvalPolicy: 'never', sandbox: 'read-only', sandboxPolicy: { type: 'readOnly' } };
  if (mode === 'bypassPermissions') return { approvalPolicy: 'never', sandbox: 'danger-full-access', sandboxPolicy: { type: 'dangerFullAccess' } };
  return { approvalPolicy: mode === 'acceptEdits' || mode === 'auto' ? 'on-request' : 'untrusted', sandbox: 'workspace-write',
    sandboxPolicy: { type: 'workspaceWrite', writableRoots: [...new Set([cwd, ...addDirs])], networkAccess: false } };
}

export function normalizeCodexItem(item) {
  if (!item) return null;
  const types = { agentMessage: 'agent_message', commandExecution: 'command_execution', mcpToolCall: 'mcp_tool_call',
    webSearch: 'web_search', fileChange: 'file_change' };
  return { ...item, type: types[item.type] || item.type,
    ...(item.type === 'webSearch' ? { query: item.query || item.action?.query || '' } : {}),
    ...(item.type === 'fileChange' ? { changes: (item.changes || []).map(c => ({ ...c, kind: c.kind?.type || c.kind })) } : {}) };
}

export function runAppServerTurn({ command, args = [], env = {}, cwd, thread, prompt, images = [], model, effort, mode,
  addDirs = [], onThread = () => {}, onEvent = () => {}, onApproval = async () => 'decline', spawnProcess = spawn }) {
  let proc;
  try { proc = spawnProcess(command, [...args, 'app-server', '--listen', 'stdio://'], { cwd, env: { ...process.env, ...env }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); }
  catch (error) { return { proc: null, done: Promise.resolve({ error: `Could not start Codex App Server: ${error.message}` }), stop() {} }; }
  let nextId = 0, settled = false, buffer = '', stderr = '', threadId, turnId, usage, stopTimer, exitTimer;
  const requests = new Map(), approvals = new Map(), items = new Map();
  let resolveDone;
  const done = new Promise(resolve => { resolveDone = resolve; });
  const emit = event => { try { onEvent(event); } catch {} };
  function write(message) {
    if (!settled && !proc.stdin.destroyed) proc.stdin.write(JSON.stringify(message) + '\n');
  }
  function finish(error = null) {
    if (settled) return;
    settled = true; clearTimeout(stopTimer);
    for (const { timer, reject } of requests.values()) { clearTimeout(timer); reject(new Error(error || 'Codex turn ended.')); }
    requests.clear();
    for (const controller of approvals.values()) controller.abort();
    approvals.clear();
    proc.stdin.end();
    exitTimer = setTimeout(() => { if (proc.exitCode == null) proc.kill(); }, 5000); exitTimer.unref?.();
    resolveDone({ error });
  }
  function request(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => { requests.delete(id); reject(new Error(`Codex ${method} timed out.`)); }, 45000);
      requests.set(id, { resolve, reject, timer }); write({ id, method, params });
    });
  }
  async function serverRequest(message) {
    const p = message.params || {};
    if (p.threadId && threadId && p.threadId !== threadId) return write({ id: message.id, error: { code: -32602, message: 'Approval belongs to another thread.' } });
    if (p.turnId && turnId && p.turnId !== turnId) return write({ id: message.id, error: { code: -32602, message: 'Approval belongs to another turn.' } });
    const methods = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval'];
    if (!methods.includes(message.method)) {
      // Unsupported questions/elicitation fail closed and explain the missing UI.
      emit({ type: 'item.completed', item: { id: `unsupported-${message.id}`, type: 'error', message: `Codex requested ${message.method}, which ClaudeOS cannot display yet. No permission was granted.` } });
      return write({ id: message.id, error: { code: -32601, message: 'This request is not supported by ClaudeOS.' } });
    }
    const controller = new AbortController(); approvals.set(message.id, controller);
    try {
      const choices = ['accept', 'acceptForSession', 'decline', 'cancel'].filter(choice =>
        !Array.isArray(p.availableDecisions) || p.availableDecisions.includes(choice));
      if (!choices.some(choice => choice === 'decline' || choice === 'cancel')) choices.push('cancel');
      const permissions = message.method === 'item/permissions/requestApproval';
      // Permission grants are limited to the exact requested scope and current turn.
      const decision = await onApproval({ method: message.method, ...p, ...(items.has(p.itemId) ? { changes: items.get(p.itemId).changes } : {}),
        choices: permissions ? ['accept', 'decline'] : choices, signal: controller.signal });
      if (controller.signal.aborted || settled) return;
      const selected = choices.includes(decision) ? decision : 'decline';
      write({ id: message.id, result: permissions
        ? { permissions: decision === 'accept' ? (p.permissions || {}) : {}, scope: 'turn' }
        : { decision: selected } });
    } catch { if (!controller.signal.aborted) write({ id: message.id, result: message.method === 'item/permissions/requestApproval' ? { permissions: {}, scope: 'turn' } : { decision: 'decline' } }); }
    finally { approvals.delete(message.id); }
  }
  function notification(method, p) {
    if (p.threadId && threadId && p.threadId !== threadId) return;
    if (method === 'serverRequest/resolved') { approvals.get(p.requestId)?.abort(); approvals.delete(p.requestId); }
    else if (method === 'item/started' || method === 'item/completed') { if (p.item?.id) items.set(p.item.id, p.item); emit({ type: method.replace('/', '.'), item: normalizeCodexItem(p.item) }); }
    else if (method === 'item/agentMessage/delta') emit({ type: 'agent.delta', itemId: p.itemId, text: p.delta });
    else if (method === 'turn/plan/updated') emit({ type: 'item.updated', item: { id: 'codex-plan', type: 'todo_list', items: (p.plan || []).map(step => ({ text: step.step, completed: step.status === 'completed', active: /progress/i.test(step.status || '') })) } });
    else if (method === 'thread/tokenUsage/updated') {
      const last = p.tokenUsage?.last;
      if (last) usage = { input_tokens: last.inputTokens, cached_input_tokens: last.cachedInputTokens,
        output_tokens: Math.max(0, (last.outputTokens || 0) - (last.reasoningOutputTokens || 0)), reasoning_output_tokens: last.reasoningOutputTokens };
    } else if (method === 'error' && !p.willRetry) {
      emit({ type: 'item.completed', item: { id: 'codex-error', type: 'error', message: p.error?.message || 'Codex failed.' } });
    } else if (method === 'turn/completed') {
      if (turnId && p.turn?.id !== turnId) return;
      emit({ type: 'turn.completed', usage });
      finish(p.turn?.status === 'failed' ? p.turn.error?.message || 'Codex failed. A command policy or managed requirement may prevent approval; changing the chat mode does not override it.' : null);
    }
  }
  proc.stdout.setEncoding('utf8'); proc.stderr.setEncoding('utf8');
  proc.stdout.on('data', chunk => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      let message; try { message = JSON.parse(line); } catch { continue; }
      if (message.method && message.id != null) { void serverRequest(message); continue; }
      if (message.id != null) {
        const waiting = requests.get(message.id); if (!waiting) continue;
        requests.delete(message.id); clearTimeout(waiting.timer);
        if (message.error) waiting.reject(new Error(message.error.message || JSON.stringify(message.error)));
        else waiting.resolve(message.result);
      } else if (message.method) notification(message.method, message.params || {});
    }
  });
  proc.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8000); });
  proc.stdin.on('error', error => finish(`Codex connection closed: ${error.message}`));
  proc.on('error', error => finish(`Could not start Codex App Server: ${error.message}`));
  proc.on('close', code => { clearTimeout(exitTimer); finish(stderr.trim().split('\n').at(-1) || `Codex App Server exited before completing the turn (${code}).`); });
  const permissions = codexPermissions(mode, cwd, addDirs);
  void (async () => {
    await request('initialize', { clientInfo: { name: 'claudeos', title: 'ClaudeOS', version: '0.3.1' } });
    write({ method: 'initialized' });
    const config = { cwd, approvalPolicy: permissions.approvalPolicy, sandbox: permissions.sandbox, approvalsReviewer: 'user', ...(model ? { model } : {}) };
    const result = await request(thread ? 'thread/resume' : 'thread/start', { ...config, ...(thread ? { threadId: thread } : {}) });
    threadId = result.thread.id; onThread(threadId);
    const turn = await request('turn/start', { threadId, cwd, approvalPolicy: permissions.approvalPolicy,
      approvalsReviewer: 'user', sandboxPolicy: permissions.sandboxPolicy,
      input: [{ type: 'text', text: prompt }, ...images.map(image => ({ type: 'localImage', path: image }))],
      ...(model ? { model } : {}), ...(effort ? { effort } : {}) });
    turnId = turn.turn.id;
  })().catch(error => finish(`Codex App Server: ${error.message}`));
  return { proc, done, stop() {
    if (settled) return;
    if (threadId && turnId) request('turn/interrupt', { threadId, turnId }).catch(() => finish());
    else return finish();
    stopTimer = setTimeout(() => finish(), 3000);
  } };
}
