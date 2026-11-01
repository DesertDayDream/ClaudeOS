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
const READ_TOOLS = ['search_nodes', 'open_nodes', 'read_graph'];
const WRITE_TOOLS = ['create_entities', 'create_relations', 'add_observations', 'delete_entities', 'delete_observations', 'delete_relations'];
// Every message resends the whole conversation, so a long chat gets expensive. "Wrap up" saves what
// matters to the brain's memory and starts a fresh conversation that gets this handover instead.
const WRAP_PROMPT = `The user is ending this chat to start a fresh one, to save tokens. Before it closes:
1. Save anything from this chat worth keeping that isn't in the brain's memory yet (decisions, facts learned, preferences) with the mcp__memory tools, on the entities they are about.
2. Save work that is still unfinished as observations on an entity named "Open tasks" (entityType "tasks"), and delete observations there that this chat finished.
3. Then reply with only a short handover for your next session, under 150 words: what this chat was about, what was decided, what is still open. No preamble.`;
const sum = (...n) => n.reduce((a, b) => a + (Number(b) || 0), 0);

export function createChat({ cwd, memoryFile, stateFile, activityFile, helper, memoryServer, port, token, broadcast, links = () => [] }) {
  // context: how big the conversation is (what each message resends) and how long the cache lasts
  let state = { sessionId: null, messages: [], context: null, carryOver: null };
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
    if (name === 'mcp__claudeos__ask_brain') return `Asking ${input.brain || 'a linked brain'}: ${String(input.task || '').slice(0, 100)}`;
    const linked = name.match(/^mcp__brain_\d+__(.*)$/);
    if (linked) return `Linked brain: ${linked[1].replace(/_/g, ' ')}${input.query ? ` "${input.query}"` : ''}`;
    if (name.startsWith('mcp__memory__')) return `Brain: ${name.slice('mcp__memory__'.length).replace(/_/g, ' ')}${input.query ? ` "${input.query}"` : ''}`;
    const target = input.file_path || input.path || input.pattern || input.command || input.url || input.description || '';
    return `${name}${target ? ': ' + String(target).slice(0, 120) : ''}`;
  }

  function send(text, { wrap = false } = {}) {
    if (run) return { error: 'Claude is still answering. Wait for it, or press Stop.' };
    text = String(text || '').trim();
    if (!text) return { error: 'Empty message.' };
    push(wrap ? { role: 'user', text: 'Wrap up & start fresh', wrap: true } : { role: 'user', text });

    const reply = push({ role: 'assistant', text: '', tools: [], streaming: true });
    // the memory server is passed here too, so a brain's memory works before its folder is trusted
    const linked = links();
    const mcpServers = {
      memory: memoryServer(memoryFile),
      claudeos: {
        ...helper('approval-mcp'),
        env: { CLAUDEOS_PORT: String(port), CLAUDEOS_TOKEN: token, CLAUDEOS_LINKS: linked.map(b => b.name).join('\n') },
      },
    };
    // each linked brain's shared brain, readable but never writable from here
    const allowed = ['mcp__memory'], denied = [];
    linked.forEach((b, i) => {
      mcpServers[`brain_${i + 1}`] = memoryServer(b.memoryFile);
      for (const t of READ_TOOLS) allowed.push(`mcp__brain_${i + 1}__${t}`);
      for (const t of WRITE_TOOLS) denied.push(`mcp__brain_${i + 1}__${t}`);
    });
    if (linked.length) allowed.push('mcp__claudeos__ask_brain');
    const args = ['-p', text, '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--mcp-config', JSON.stringify({ mcpServers }), '--permission-prompt-tool', 'mcp__claudeos__approve',
      // the brain's own memory never needs a prompt, even in a folder Claude Code hasn't trusted yet
      '--allowedTools', allowed.join(','), ...(denied.length ? ['--disallowedTools', denied.join(',')] : [])];
    const extra = [];
    if (linked.length) {
      extra.push(`Linked brains (other ClaudeOS brains the user connected to this one):\n${linked.map((b, i) =>
        `- ${b.name}: read its shared brain with mcp__brain_${i + 1}__search_nodes / open_nodes / read_graph (read-only).`).join('\n')}\n` +
        'When a question is about what a linked brain knows, search it. When a task belongs to a linked brain\'s team, hand it over with mcp__claudeos__ask_brain (brain, task) and report its answer. Save new facts only in this brain\'s own memory.');
    }
    // sent with every message of the fresh chat (the system prompt isn't kept between runs)
    if (state.carryOver) extra.push(`Handover from the previous chat in this brain (its details are in the brain's memory; search it if you need more):\n${state.carryOver}`);
    if (extra.length) args.push('--append-system-prompt', extra.join('\n\n'));
    if (state.sessionId) args.push('--resume', state.sessionId);

    const proc = spawn('claude', args, {
      cwd,
      env: { ...process.env, MCP_TOOL_TIMEOUT: String(24 * 3600 * 1000) },
      windowsHide: true,
    });
    run = { proc, reply, streamed: new Set(), current: null, stopped: false, wrap, first: null, last: null, result: null };
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
      // the first API call shows whether the cache was still warm, the last one how big the context is now
      if (msg.usage) { run.first ||= msg.usage; run.last = msg.usage; }
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
      run.result = ev;
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
    const usage = measure();
    if (usage) fields.usage = usage;
    update(fields);
    // a killed or failed run never reaches Claude's Stop hook, so close the task in the log here
    if ((run.stopped || run.reply.error) && state.sessionId) {
      const ev = { ts: Date.now(), session: state.sessionId, cwd, type: 'stop', outcome: run.stopped ? 'stopped' : 'error',
        result: run.stopped ? 'Stopped from the chat.' : String(run.reply.error).slice(0, 600) };
      try { fs.appendFileSync(activityFile, JSON.stringify(ev) + '\n'); } catch { /* the board just shows it as unfinished */ }
    }
    const handover = run.wrap && !run.stopped && !run.reply.error ? run.reply.text.trim() : '';
    run = null;
    save();
    emit({ kind: 'busy', busy: false });
    if (handover) {
      state = { sessionId: null, messages: [], context: null, carryOver: handover };
      emit({ kind: 'reset' });
      push({ role: 'assistant', carry: true, text: handover });
      save();
      emit({ kind: 'context', context: null });
    }
  }

  // What this reply cost and how big the conversation is now, from the usage Claude Code reports.
  function measure() {
    const { first, last, result } = run;
    if (!last) return null;
    const ttlOf = u => u?.cache_creation?.ephemeral_1h_input_tokens > 0 ? 3600e3 : u?.cache_creation?.ephemeral_5m_input_tokens > 0 ? 300e3 : 0;
    const models = Object.values(result?.modelUsage || {});
    const main = models.sort((a, b) => sum(b.cacheReadInputTokens, b.cacheCreationInputTokens, b.inputTokens) - sum(a.cacheReadInputTokens, a.cacheCreationInputTokens, a.inputTokens))[0];
    const prev = state.context || {};
    const tokens = sum(last.input_tokens, last.cache_creation_input_tokens, last.cache_read_input_tokens, last.output_tokens);
    state.context = {
      tokens,
      base: prev.base || tokens, // what a fresh conversation in this brain costs, from its first reply
      window: main?.contextWindow || prev.window || 200000,
      ttl: ttlOf(last) || ttlOf(first) || prev.ttl || 300e3,
      at: Date.now(),
    };
    emit({ kind: 'context', context: state.context });
    const u = result?.usage || last;
    const firstIn = sum(first.input_tokens, first.cache_creation_input_tokens, first.cache_read_input_tokens);
    return {
      sent: sum(u.input_tokens, u.cache_creation_input_tokens, u.cache_read_input_tokens),
      cached: Number(u.cache_read_input_tokens) || 0,
      output: Number(u.output_tokens) || 0,
      calls: result?.num_turns || 1,
      warm: firstIn ? (Number(first.cache_read_input_tokens) || 0) / firstIn : 0, // share of the first call read from cache
      cost: result?.total_cost_usd ?? null, // at API list prices
    };
  }

  function wrapUp() {
    if (run) return { error: 'Claude is still answering. Wait for it, or press Stop.' };
    if (!state.sessionId) return reset(); // nothing said yet, so nothing to keep
    return send(WRAP_PROMPT, { wrap: true });
  }

  function stop() {
    if (!run) return;
    run.stopped = true;
    // end Claude and anything it started (MCP servers, scripts)
    execFile('taskkill', ['/pid', String(run.proc.pid), '/T', '/F'], () => {});
  }

  function reset() {
    if (run) return { error: 'Stop the current answer first.' };
    state = { sessionId: null, messages: [], context: null, carryOver: null };
    save();
    emit({ kind: 'reset' });
    emit({ kind: 'context', context: null });
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
    return { messages: state.messages, busy: !!run, approvals: [...approvals.values()].map(a => a.card), context: state.context };
  }

  return { send, stop, reset, wrapUp, requestApproval, answerApproval, snapshot };
}
