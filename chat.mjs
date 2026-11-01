// Chat with Claude from the ClaudeOS page. Each message runs Claude Code headless in the
// active brain's folder (so CLAUDE.md, the shared brain, the skills and the activity hooks all apply),
// resumes the same conversation, and streams the reply back to the page. Tool calls that the
// folder's settings don't already allow are sent to the page as Allow/Deny cards through a small
// MCP server (approval-mcp.mjs) that Claude calls as its --permission-prompt-tool.
import { spawn, execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const MAX_MESSAGES = 300;

export function createChat({ cwd, memoryFile, stateFile, appDir, port, token, broadcast }) {
  let state = { sessionId: null, messages: [] };
  try { state = { ...state, ...JSON.parse(fs.readFileSync(stateFile, 'utf8')) }; } catch { /* first run */ }

  let run = null;              // the Claude process answering right now
  const approvals = new Map(); // id -> { resolve, card }

  function save() {
    state.messages = state.messages.slice(-MAX_MESSAGES);
    try { fs.mkdirSync(path.dirname(stateFile), { recursive: true }); fs.writeFileSync(stateFile, JSON.stringify(state)); } catch { /* keep going */ }
  }
  function emit(ev) { broadcast('chat', ev); }
  function push(msg) {
    msg.id ||= crypto.randomUUID();
    msg.ts ||= Date.now();
    state.messages.push(msg);
    emit({ kind: 'message', message: msg });
    return msg;
  }

  function toolSummary(name, input = {}) {
    if (name === 'Skill') return `Handing off to ${input.skill || input.command || 'a skill'}`;
    if (name.startsWith('mcp__memory__')) return `Brain: ${name.slice('mcp__memory__'.length).replace(/_/g, ' ')}${input.query ? ` "${input.query}"` : ''}`;
    const target = input.file_path || input.path || input.pattern || input.command || input.url || input.description || '';
    return `${name}${target ? ': ' + String(target).slice(0, 120) : ''}`;
  }

  function send(text) {
    if (run) return { error: 'Claude is still answering. Wait for it, or press Stop.' };
    text = String(text || '').trim();
    if (!text) return { error: 'Empty message.' };
    push({ role: 'user', text });

    const reply = push({ role: 'assistant', text: '', tools: [], streaming: true });
    // the memory server is passed here too, so a brain's memory works before its folder is trusted
    const mcpConfig = JSON.stringify({ mcpServers: {
      memory: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'], env: { MEMORY_FILE_PATH: memoryFile } },
      claudeos: {
      command: process.execPath,
      args: [path.join(appDir, 'approval-mcp.mjs')],
      env: { CLAUDEOS_PORT: String(port), CLAUDEOS_TOKEN: token },
    } } });
    const args = ['-p', text, '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--mcp-config', mcpConfig, '--permission-prompt-tool', 'mcp__claudeos__approve',
      // the brain's own memory never needs a prompt, even in a folder Claude Code hasn't trusted yet
      '--allowedTools', 'mcp__memory'];
    if (state.sessionId) args.push('--resume', state.sessionId);

    const proc = spawn('claude', args, {
      cwd,
      env: { ...process.env, MCP_TOOL_TIMEOUT: String(24 * 3600 * 1000) },
      windowsHide: true,
    });
    run = { proc, reply, streamed: new Set(), current: null, stopped: false };
    emit({ kind: 'busy', busy: true });

    let buf = '';
    let stderr = '';
    proc.stdout.on('data', d => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) { try { handle(JSON.parse(line)); } catch { /* not JSON */ } }
      }
    });
    proc.stderr.on('data', d => { stderr += d; });
    proc.on('error', err => finish(`Could not start Claude Code: ${err.message}. Is "claude" installed and on PATH?`));
    proc.on('close', code => finish(code && !run?.stopped ? (stderr.trim().split('\n').pop() || `Claude exited with code ${code}`) : null));
    return { ok: true };
  }

  function update(fields) {
    Object.assign(run.reply, fields);
    emit({ kind: 'update', id: run.reply.id, fields });
  }

  function handle(ev) {
    if (!run) return;
    if (ev.session_id && ev.session_id !== state.sessionId) { state.sessionId = ev.session_id; }
    if (ev.type === 'stream_event') {
      const e = ev.event || {};
      if (e.type === 'message_start') run.current = e.message?.id;
      if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta') {
        if (run.current) run.streamed.add(run.current);
        run.reply.text += e.delta.text;
        emit({ kind: 'delta', id: run.reply.id, text: e.delta.text });
      }
      return;
    }
    if (ev.type === 'assistant') {
      const msg = ev.message || {};
      for (const block of msg.content || []) {
        if (block.type === 'text' && !run.streamed.has(msg.id)) {
          run.reply.text += block.text;
          emit({ kind: 'delta', id: run.reply.id, text: block.text });
        }
        if (block.type === 'tool_use' && block.name !== 'mcp__claudeos__approve') {
          update({ tools: [...run.reply.tools, toolSummary(block.name, block.input)] });
        }
      }
      // separate text from consecutive assistant turns
      if (run.reply.text && !run.reply.text.endsWith('\n\n')) {
        run.reply.text += '\n\n';
        emit({ kind: 'delta', id: run.reply.id, text: '\n\n' });
      }
      return;
    }
    if (ev.type === 'result') {
      if (ev.is_error && ev.result) update({ error: String(ev.result) });
      if (!run.reply.text.trim() && ev.result && !ev.is_error) update({ text: String(ev.result) });
    }
  }

  function finish(error) {
    if (!run) return;
    for (const [id, a] of approvals) { a.resolve({ behavior: 'deny', message: 'The request ended before you answered.' }); approvals.delete(id); emit({ kind: 'approval-done', id, allowed: false }); }
    const fields = { streaming: false, text: run.reply.text.trim() };
    if (run.stopped) fields.note = 'Stopped.';
    if (error && !run.reply.error) fields.error = error;
    update(fields);
    run = null;
    save();
    emit({ kind: 'busy', busy: false });
  }

  function stop() {
    if (!run) return;
    run.stopped = true;
    // end Claude and anything it started (MCP servers, scripts)
    execFile('taskkill', ['/pid', String(run.proc.pid), '/T', '/F'], () => {});
  }

  function reset() {
    if (run) return { error: 'Stop the current answer first.' };
    state = { sessionId: null, messages: [] };
    save();
    emit({ kind: 'reset' });
    return { ok: true };
  }

  // Called (long-poll) by approval-mcp.mjs; resolves when the user clicks Allow or Deny.
  function requestApproval({ tool_name, input }) {
    return new Promise(resolve => {
      if (!run) return resolve({ behavior: 'deny', message: 'No chat request is running.' });
      const id = crypto.randomUUID();
      const card = { id, tool: tool_name, summary: toolSummary(tool_name, input), input };
      approvals.set(id, { resolve: allow => resolve(allow), card, input });
      emit({ kind: 'approval', card });
    });
  }
  function answerApproval(id, allow) {
    const a = approvals.get(id);
    if (!a) return { error: 'That request is no longer waiting.' };
    approvals.delete(id);
    a.resolve(allow ? { behavior: 'allow', updatedInput: a.input } : { behavior: 'deny', message: 'The user denied this in ClaudeOS.' });
    emit({ kind: 'approval-done', id, allowed: !!allow });
    return { ok: true };
  }

  function snapshot() {
    return { messages: state.messages, busy: !!run, approvals: [...approvals.values()].map(a => a.card) };
  }

  return { send, stop, reset, requestApproval, answerApproval, snapshot };
}
