// Chat with Claude from the ClaudeOS page. Each message runs Claude Code headless in the
// active brain's folder (so CLAUDE.md, the shared brain, the skills and the activity hooks all apply),
// resumes that chat's conversation, and streams the reply back to the page. Tool calls that the
// folder's settings don't already allow are sent to the page as Allow/Deny cards through a small
// MCP server (approval-mcp.mjs) that Claude calls as its --permission-prompt-tool.
// The chat is the brain's Manager: it can hand work to the team (post_brief, run by manager.mjs), and
// when a brief is done the team's reports come back to the chat that sent it, as a message of their own.
// A brain keeps any number of chats (~/.claudeos/chats/<brain>/<chat>.json plus index.json). Each has
// its own Claude session and runs on its own, so a chat you left keeps working; the page shows one.
import { spawn, execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const MAX_MESSAGES = 300;
const READ_TOOLS = ['search_nodes', 'open_nodes', 'read_graph'];
const WRITE_TOOLS = ['create_entities', 'create_relations', 'add_observations', 'delete_entities', 'delete_observations', 'delete_relations'];
// Every message resends the whole conversation, so a long chat gets expensive. "Wrap up" saves what
// matters to the brain's memory and starts a fresh chat that gets this handover instead.
const WRAP_PROMPT = `The user is ending this chat to start a fresh one, to save tokens. Before it closes:
1. Save anything from this chat worth keeping that isn't in the brain's memory yet (decisions, facts learned, preferences) with the mcp__memory tools, on the entities they are about.
2. Save work that is still unfinished as observations on an entity named "Open tasks" (entityType "tasks"), and delete observations there that this chat finished.
3. Then reply with only a short handover for your next session, under 150 words: what this chat was about, what was decided, what is still open. No preamble.`;
const sum = (...n) => n.reduce((a, b) => a + (Number(b) || 0), 0);
// what the model/effort pickers offer (aliases follow the latest model of each family)
const MODELS = ['fable', 'opus', 'sonnet', 'haiku'];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const managerPrompt = crew => `You are the Manager of this brain's team, and this chat is how the user talks to you.
The team (employee name, skill: what it does):
${crew.map(c => `- ${c.name}, ${c.skill}: ${String(c.description || '').slice(0, 200)}`).join('\n')}
When the user wants work done that fits the team, don't do it yourself: brief them with mcp__claudeos__post_brief. Each employee works in their own run at their desk, at the same time as the others, and can't see this chat, so each task must stand on its own: the goal, the exact input files, where to save the output, and anything from memory they need (search it first when the work depends on the user's preferences or past decisions). Put a task id in "after" only when that task needs the other's output; never chain tasks that don't depend on each other. Fewer, bigger tasks beat many tiny ones. Parts nobody on the team can do, or too unclear to act on, go in "skipped" with the reason. After the brief is accepted, tell the user in a few lines who does what and stop: the team's reports come back in this chat by themselves. Questions and quick things you answer yourself.`;
const newId = () => crypto.randomBytes(6).toString('hex');
const clip = (s, n) => (s = String(s || '').replace(/\s+/g, ' ').trim()).length > n ? s.slice(0, n - 1) + '…' : s;

function toolSummary(name, input = {}) {
  if (name === 'Skill') return `Handing off to ${input.skill || input.command || 'a skill'}`;
  if (name === 'mcp__claudeos__post_brief') return `Briefing the team: ${input.title || 'new brief'} (${(input.tasks || []).map(t => t.employee).join(', ')})`;
  if (name === 'mcp__claudeos__ask_brain') return `Asking ${input.brain || 'a linked brain'}: ${String(input.task || '').slice(0, 100)}`;
  const linked = name.match(/^mcp__brain_\d+__(.*)$/);
  if (linked) return `Linked brain: ${linked[1].replace(/_/g, ' ')}${input.query ? ` "${input.query}"` : ''}`;
  if (name.startsWith('mcp__memory__')) return `Brain: ${name.slice('mcp__memory__'.length).replace(/_/g, ' ')}${input.query ? ` "${input.query}"` : ''}`;
  const target = input.file_path || input.path || input.pattern || input.command || input.url || input.description || '';
  return `${name}${target ? ': ' + String(target).slice(0, 120) : ''}`;
}

export function createChat({ cwd, memoryFile, dir, legacyFile, activityFile, helper, memoryServer, port, token, broadcast, links = () => [], othersWorking = () => false, team = () => [], onIdle = () => {} }) {
  // the brain's chats: which one the page shows, the model/effort picked, and a row per saved chat
  const indexFile = path.join(dir, 'index.json');
  let index = { current: null, options: {}, chats: {} };
  try { index = { ...index, ...JSON.parse(fs.readFileSync(indexFile, 'utf8')) }; } catch { migrate(); }
  const convs = new Map();     // chat id -> its conversation, once used since the start
  const approvals = new Map(); // id -> { resolve, card, input }; card.chat says which chat asked

  // the one chat a brain had before there were several becomes its first chat
  function migrate() {
    let old;
    try { old = JSON.parse(fs.readFileSync(legacyFile, 'utf8')); } catch { return; }
    const { options = {}, ...st } = old;
    index.options = options;
    if (!st.messages?.length) return;
    const id = newId();
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(st));
      index.chats[id] = { title: titleOf(st.messages), created: st.messages[0]?.ts || Date.now(), updated: st.messages.at(-1)?.ts || Date.now(), count: st.messages.length };
      index.current = id;
      saveIndex();
      fs.renameSync(legacyFile, legacyFile + '.migrated');
    } catch { /* stays where it was; tried again next start */ }
  }
  function saveIndex() {
    try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(indexFile, JSON.stringify(index)); } catch { /* keep going */ }
  }
  function titleOf(messages) {
    const first = messages.find(m => m.role === 'user' && !m.wrap);
    return first ? clip(first.text, 60) : 'New chat';
  }
  function emit(ev) { broadcast('chat', ev); }
  const anyBusy = () => [...convs.values()].some(c => c.busy());
  function rows() {
    return Object.entries(index.chats).map(([id, m]) => ({ id, ...m, busy: !!convs.get(id)?.busy() }))
      .sort((a, b) => b.updated - a.updated);
  }
  function listChanged() { emit({ kind: 'list', current: index.current, chats: rows(), any: anyBusy() }); }

  function conv(id) {
    if (!convs.has(id)) convs.set(id, makeConv(id));
    return convs.get(id);
  }
  // the chat the page shows; a fresh one when there's none yet
  function current() {
    if (!index.current) { index.current = newId(); saveIndex(); }
    return conv(index.current);
  }

  // ---------- one conversation ----------
  function makeConv(id) {
    const file = path.join(dir, `${id}.json`);
    // context: how big the conversation is (what each message resends) and how long the cache lasts
    let state = { sessionId: null, messages: [], context: null, carryOver: null };
    try { state = { ...state, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { /* new chat */ }
    let run = null;      // the Claude process answering right now
    const reports = [];  // finished briefs waiting for this chat to be free
    const send1 = ev => emit({ ...ev, chat: id });

    function save() {
      if (!state.messages.length) return; // an empty new chat isn't kept
      state.messages = state.messages.slice(-MAX_MESSAGES);
      try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, JSON.stringify(state)); } catch { /* keep going */ }
      const m = index.chats[id] || { created: state.messages[0]?.ts || Date.now() };
      index.chats[id] = { ...m, title: m.renamed ? m.title : titleOf(state.messages), updated: state.messages.at(-1)?.ts || Date.now(), count: state.messages.length };
      saveIndex();
    }
    function push(msg) {
      msg.id ||= crypto.randomUUID();
      msg.ts ||= Date.now();
      state.messages.push(msg);
      send1({ kind: 'message', message: msg });
      return msg;
    }

    // label: what the chat shows instead of the full text (the Inbox's hand-over); from: 'inbox' | 'team'
    function send(text, { wrap = false, label = '', from = '' } = {}) {
      if (run) return { error: 'Claude is still answering. Wait for it, or press Stop.' };
      text = String(text || '').trim();
      if (!text) return { error: 'Empty message.' };
      push(wrap ? { role: 'user', text: 'Wrap up & start fresh', wrap: true } : { role: 'user', text: label || text, ...(from ? { from } : {}) });

      const reply = push({ role: 'assistant', text: '', tools: [], streaming: true });
      // the memory server is passed here too, so a brain's memory works before its folder is trusted
      const linked = links(), crew = team();
      const mcpServers = {
        memory: memoryServer(memoryFile),
        claudeos: {
          ...helper('approval-mcp'),
          env: { CLAUDEOS_PORT: String(port), CLAUDEOS_TOKEN: token, CLAUDEOS_CHAT: id, CLAUDEOS_LINKS: linked.map(b => b.name).join('\n'),
            ...(crew.length ? { CLAUDEOS_TEAM: JSON.stringify(crew.map(c => c.skill)) } : {}) },
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
      if (crew.length) allowed.push('mcp__claudeos__post_brief');
      const args = ['-p', text, '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
        '--mcp-config', JSON.stringify({ mcpServers }), '--permission-prompt-tool', 'mcp__claudeos__approve',
        // the brain's own memory never needs a prompt, even in a folder Claude Code hasn't trusted yet
        '--allowedTools', allowed.join(','), ...(denied.length ? ['--disallowedTools', denied.join(',')] : [])];
      const extra = [];
      if (crew.length) extra.push(managerPrompt(crew));
      if (linked.length) {
        extra.push(`Linked brains (other ClaudeOS brains the user connected to this one):\n${linked.map((b, i) =>
          `- ${b.name}: read its shared brain with mcp__brain_${i + 1}__search_nodes / open_nodes / read_graph (read-only).`).join('\n')}\n` +
          'When a question is about what a linked brain knows, search it. When a task belongs to a linked brain\'s team, hand it over with mcp__claudeos__ask_brain (brain, task) and report its answer. Save new facts only in this brain\'s own memory.');
      }
      // sent with every message of the fresh chat (the system prompt isn't kept between runs)
      if (state.carryOver) extra.push(`Handover from the previous chat in this brain (its details are in the brain's memory; search it if you need more):\n${state.carryOver}`);
      if (extra.length) args.push('--append-system-prompt', extra.join('\n\n'));
      if (state.sessionId) args.push('--resume', state.sessionId);
      if (index.options?.model) args.push('--model', index.options.model);
      if (index.options?.effort) args.push('--effort', index.options.effort);

      const proc = spawn('claude', args, {
        cwd,
        // memories go to the brain, never Claude Code's own auto-memory (also off in each brain's settings)
        env: { ...process.env, MCP_TOOL_TIMEOUT: String(24 * 3600 * 1000), CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' },
        windowsHide: true,
      });
      run = { proc, reply, streamed: new Set(), current: null, stopped: false, wrap, first: null, last: null, result: null };
      send1({ kind: 'busy', busy: true, any: true });
      save();
      listChanged();

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
      send1({ kind: 'update', id: run.reply.id, fields });
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
          send1({ kind: 'delta', id: run.reply.id, text: e.delta.text });
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
            send1({ kind: 'delta', id: run.reply.id, text: block.text });
          }
          if (block.type === 'tool_use' && block.name !== 'mcp__claudeos__approve') {
            update({ tools: [...run.reply.tools, toolSummary(block.name, block.input)] });
          }
        }
        // separate text from consecutive assistant turns
        if (run.reply.text && !run.reply.text.endsWith('\n\n')) {
          run.reply.text += '\n\n';
          send1({ kind: 'delta', id: run.reply.id, text: '\n\n' });
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
      for (const [aid, a] of approvals) {
        if (a.card.who || a.card.chat !== id) continue;
        a.resolve({ behavior: 'deny', message: 'The request ended before you answered.' });
        approvals.delete(aid);
        emit({ kind: 'approval-done', id: aid, allowed: false });
      }
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
      send1({ kind: 'busy', busy: false, any: anyBusy() });
      // wrapped up: a fresh chat with the handover takes over (this one stays in the list)
      if (handover) {
        const next = conv(newId());
        next.startWith(handover);
        if (index.current === id) open(next.id);
      }
      listChanged();
      onIdle(id);
      // the next answer starts after this one has fully ended
      if (reports.length) setTimeout(nextReport, 0);
    }

    // What this reply cost and how big the conversation is now, from the usage Claude Code reports.
    function measure() {
      const { first, last, result } = run;
      // an error that never reached the model (usage limit, no login) has an all-zero usage
      if (!last || !sum(last.input_tokens, last.cache_creation_input_tokens, last.cache_read_input_tokens)) return null;
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
      send1({ kind: 'context', context: state.context });
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

    function startWith(handover) {
      state.carryOver = handover;
      push({ role: 'assistant', carry: true, text: handover });
      save();
    }
    function wrapUp() {
      if (run) return { error: 'Claude is still answering. Wait for it, or press Stop.' };
      if (!state.sessionId) return { ok: true }; // nothing said yet, so nothing to keep
      return send(WRAP_PROMPT, { wrap: true });
    }
    function stop() {
      if (!run) return;
      run.stopped = true;
      // end Claude and anything it started (MCP servers, scripts)
      execFile('taskkill', ['/pid', String(run.proc.pid), '/T', '/F'], () => {});
    }

    // A brief is done: its reports go to the Manager as a message of their own, once the chat is free.
    function report(title, text) {
      reports.push({ title, text });
      if (!run) nextReport();
    }
    function nextReport() {
      if (run || !reports.length) return;
      const r = reports.shift();
      if (send(r.text, { label: `Team report: ${r.title}`, from: 'team' }).error) reports.unshift(r);
    }

    function snapshot() {
      return { id, title: index.chats[id]?.title || 'New chat', messages: state.messages, busy: !!run, context: state.context };
    }
    // the text a search looks through
    const text = () => state.messages.map(m => m.text).join('\n');
    return { id, send, stop, wrapUp, report, startWith, snapshot, text, busy: () => !!run, empty: () => !state.messages.length, file };
  }

  // ---------- the brain's chats ----------
  function open(id) {
    if (!index.chats[id] && !convs.has(id)) return { error: 'That chat is gone.' };
    index.current = id;
    saveIndex();
    emit({ kind: 'open', id });
    listChanged();
    return { ok: true };
  }
  function newChat() {
    if (current().empty()) return { ok: true }; // already on a fresh one
    const c = conv(newId());
    return open(c.id);
  }
  function rename(id, title) {
    const m = index.chats[id];
    if (!m) return { error: 'That chat is gone.' };
    title = clip(title, 80);
    if (!title) return { error: 'Give it a name.' };
    index.chats[id] = { ...m, title, renamed: true };
    saveIndex();
    listChanged();
    return { ok: true };
  }
  // deleted chats go to the brain's chats/trash folder, not away for good
  function remove(id) {
    if (!index.chats[id]) return { error: 'That chat is gone.' };
    if (convs.get(id)?.busy()) return { error: 'That chat is still working. Stop it first.' };
    try {
      fs.mkdirSync(path.join(dir, 'trash'), { recursive: true });
      fs.renameSync(path.join(dir, `${id}.json`), path.join(dir, 'trash', `${id}.json`));
    } catch { /* never saved, or already gone */ }
    delete index.chats[id];
    convs.delete(id);
    if (index.current === id) { index.current = rows()[0]?.id || null; saveIndex(); emit({ kind: 'open', id: current().id }); }
    saveIndex();
    listChanged();
    return { ok: true };
  }
  // every chat, newest first; with a query, only chats whose title or messages match, with a snippet
  function list(q = '') {
    q = String(q || '').trim().toLowerCase();
    let out = rows();
    if (q) {
      out = out.flatMap(r => {
        let body = '';
        if (convs.has(r.id)) body = convs.get(r.id).text();
        else try { body = JSON.parse(fs.readFileSync(path.join(dir, `${r.id}.json`), 'utf8')).messages.map(m => m.text).join('\n'); } catch { /* unreadable */ }
        const at = body.toLowerCase().indexOf(q);
        if (at < 0 && !r.title.toLowerCase().includes(q)) return [];
        return [{ ...r, snippet: at < 0 ? '' : clip(body.slice(Math.max(0, at - 40), at + q.length + 80), 130) }];
      });
    }
    return { current: index.current, chats: out.slice(0, 200), any: anyBusy() };
  }

  // A finished brief reports to the chat that sent it (or the open one, if that chat was deleted).
  function report(chatId, title, text) {
    const c = chatId && (index.chats[chatId] || convs.has(chatId)) ? conv(chatId) : current();
    c.report(title, text);
  }

  // takes effect from the next message (one already being answered keeps what it started with)
  function setOptions({ model = '', effort = '' } = {}) {
    if (model && !MODELS.includes(model)) return { error: `Unknown model "${model}".`, options: index.options };
    if (effort && !EFFORTS.includes(effort)) return { error: `Unknown effort "${effort}".`, options: index.options };
    index.options = { ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
    saveIndex();
    emit({ kind: 'options', options: index.options });
    return { ok: true, options: index.options };
  }

  // Called (long-poll) by approval-mcp.mjs; resolves when the user clicks Allow or Deny.
  // Each card says which chat asked; employees working a brief ask here too (`who` says which one),
  // and their cards stay until answered, even after the chat's own answer ends.
  function requestApproval({ tool_name, input, who, chat }) {
    return new Promise(resolve => {
      const asker = chat ? convs.get(chat) : current();
      if (who ? !othersWorking() : !asker?.busy()) return resolve({ behavior: 'deny', message: 'No chat request is running.' });
      const id = crypto.randomUUID();
      const card = { id, tool: tool_name, summary: toolSummary(tool_name, input), input, ...(who ? { who: String(who).slice(0, 60) } : { chat: asker.id }) };
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
  // the Inbox's runs ended (finished or stopped): their unanswered cards have nobody waiting anymore
  function dropOthersApprovals() {
    for (const [id, a] of approvals) {
      if (!a.card.who) continue;
      a.resolve({ behavior: 'deny', message: 'The run ended before you answered.' });
      approvals.delete(id);
      emit({ kind: 'approval-done', id, allowed: false });
    }
  }

  // the open chat, with every approval waiting anywhere (the page marks the other chats' ones)
  function snapshot() {
    return { ...current().snapshot(), approvals: [...approvals.values()].map(a => a.card), options: index.options || {}, any: anyBusy() };
  }

  return {
    // the open chat
    send: (text, opts) => current().send(text, opts), stop: () => current().stop(), wrapUp: () => current().wrapUp(),
    busy: () => current().busy(), currentId: () => current().id,
    // all of them
    open, newChat, rename, remove, list, report, anyBusy, stopAll: () => { for (const c of convs.values()) c.stop(); },
    setOptions, requestApproval, answerApproval, dropOthersApprovals, snapshot,
  };
}
