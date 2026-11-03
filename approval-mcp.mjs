// Tiny stdio MCP server that Claude Code uses as its --permission-prompt-tool when ClaudeOS
// runs a chat. It forwards each permission question to the ClaudeOS server, which shows an
// Allow/Deny card in the page and answers once the user clicks.
import http from 'node:http';
import readline from 'node:readline';
import { MODEL_SELECTION_SCHEMA } from './model-routing.mjs';

const PORT = Number(process.env.CLAUDEOS_PORT || 4747);
const TOKEN = process.env.CLAUDEOS_TOKEN || '';

function reply(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n'); }
function fail(id, message) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message } }) + '\n'); }

// Brains this chat may hand work to (empty in a hand-off itself, so hand-offs never chain).
const LINKS = (process.env.CLAUDEOS_LINKS || '').split('\n').filter(Boolean);
// Who is asking for approvals (an employee working a brief); empty in the chat, which is the Manager.
const WHO = process.env.CLAUDEOS_WHO || '';
// Which of the brain's chats this run belongs to (its approvals and briefs go back to it).
const CHAT = process.env.CLAUDEOS_CHAT || '';
// Only the chat (the Manager) gets post_brief, with the team it may assign work to.
let TEAM = [];
try { TEAM = JSON.parse(process.env.CLAUDEOS_TEAM || '[]'); } catch { /* no team */ }
// A chat also gets the desk tools: terminal tabs, artifacts, and (unless it is a side session
// itself) side sessions of its own.
const DESK = process.env.CLAUDEOS_DESK === '1';
const MODEL_TASK = process.env.CLAUDEOS_MODEL_TASK === '1';
const MODEL_TOOLS = [
  { name: 'model_catalog', description: 'List installed model providers and locally offered Codex models/efforts. Does not guarantee quota or specialist tools.', inputSchema: { type: 'object', properties: {} } },
  { name: 'run_model_task', description: 'Run one bounded specialist task on a model selected for its complexity and tools. Returns the result here. Include context, exact file ownership and acceptance criteria. No recursive delegation. Keeps human approvals; usage-limit fallback is attempted once unless prohibited.',
    inputSchema: { type: 'object', required: ['task'], properties: { task: { type: 'string' }, selection: MODEL_SELECTION_SCHEMA } } },
];
const SESSIONS = DESK && process.env.CLAUDEOS_SESSIONS === '1';
const DESK_TOOLS = [
  { name: 'terminal_run', description: 'Run a shell command (PowerShell on Windows) in a tab of the ClaudeOS Terminal tab, which the user can watch, type into and stop. Use it for long-running things the user should see: dev servers, watchers, test runners, builds. Returns at once with the tab id; read the output with terminal_read. Use your Bash tool for short commands whose output you need right away. Pass tab to reuse a tab whose command has ended: each tab keeps one shell, so its folder (after cd), variables and functions carry over. Tabs are real terminals (the user can run vim or other full-screen programs in them); the tab shows a command as finished when its prompt comes back, with its exit code.',
    inputSchema: { type: 'object', required: ['command'], properties: { command: { type: 'string' }, title: { type: 'string', description: 'Short name for a new tab, e.g. "dev server".' }, tab: { type: 'string', description: 'An existing tab to run it in.' }, cwd: { type: 'string', description: 'Folder for a new tab (default: this chat\'s folder).' } } } },
  { name: 'terminal_read', description: 'Read the last lines of a terminal tab. wait_ms waits up to that long for new output first (max 60000).',
    inputSchema: { type: 'object', required: ['tab'], properties: { tab: { type: 'string' }, lines: { type: 'number' }, wait_ms: { type: 'number' } } } },
  { name: 'terminal_list', description: 'List the terminal tabs: id, title, folder, and whether a command is running.', inputSchema: { type: 'object', properties: {} } },
  { name: 'terminal_stop', description: 'Stop what runs in a terminal tab (Ctrl-C); close: true also removes the tab.',
    inputSchema: { type: 'object', required: ['tab'], properties: { tab: { type: 'string' }, close: { type: 'boolean' } } } },
  { name: 'publish_artifact', description: 'Publish an HTML page you wrote (one self-contained .html file: CSS and scripts inline or from a CDN) as an artifact. The user sees it in the ClaudeOS Artifacts tab and can open it in their browser. Use it when a page is clearer than chat text: a report, a dashboard, a comparison, a mock-up, a small tool. Publishing the same file again (or passing its id) updates it in place. Returns its URL: give the user that link.',
    inputSchema: { type: 'object', required: ['file_path', 'title'], properties: { file_path: { type: 'string', description: 'Absolute path of the .html file.' }, title: { type: 'string', description: 'Two to four words.' }, description: { type: 'string', description: 'One sentence.' }, id: { type: 'string', description: 'An artifact to update.' } } } },
  { name: 'update_app', description: 'Install a new build of ClaudeOS itself. In the desktop app: build and test it first with `npm run desktop:finish` in the ClaudeOS folder, then pass the installer it made (full path to dist/desktop/ClaudeOS-Setup-<version>.exe). Once every chat has finished its turn ClaudeOS closes, installs it silently, opens again on this chat and sends you a message to finish up. ClaudeOS keeps the installer of the version before: rollback: true goes back to it the same way (only when the user asks), and updating again brings the newer one back. Without an installer or rollback, the desktop app checks GitHub releases instead. In the legacy ClaudeOS.exe: build beside it with `npm run build:exe -- dist/ClaudeOS.new.exe`; rollback: true goes back to the previous build. The user approves it. End your turn right after calling it.',
    inputSchema: { type: 'object', properties: { installer: { type: 'string', description: 'Desktop app: full path of the ClaudeOS-Setup-<version>.exe to install.' }, rollback: { type: 'boolean', description: 'Go back to the version before (only when the user asks).' } } } },
  { name: 'show_preview', description: 'Show a running web app (usually a dev server you started with terminal_run, like http://localhost:5173) in the preview panel beside the chat, so the user sees it live while you work. Most dev servers reload it themselves when files change.',
    inputSchema: { type: 'object', required: ['url'], properties: { url: { type: 'string', description: 'Full address, e.g. http://localhost:3000/' } } } },
  { name: 'schedule_task', description: 'Schedule a prompt to run by itself later or on repeat (a reminder, a daily report, a weekly check). Each run starts a new chat in this brain with the prompt, in this chat\'s folder; the user is notified when it answers. ClaudeOS must be running at the time (a missed run happens when it starts again). Write the prompt so it stands on its own: the run can\'t see this chat.',
    inputSchema: { type: 'object', required: ['title', 'prompt', 'repeat'], properties: {
      title: { type: 'string', description: 'Two to six words.' },
      prompt: { type: 'string', description: 'What Claude should do each time, with all the context it needs.' },
      repeat: { type: 'string', enum: ['once', 'hourly', 'daily', 'weekdays', 'weekly'] },
      time: { type: 'string', description: 'Local time, 24-hour HH:MM (not for hourly). Default 09:00.' },
      date: { type: 'string', description: 'For once: YYYY-MM-DD.' },
      day: { type: 'string', description: 'For weekly: monday … sunday.' },
      every_hours: { type: 'number', description: 'For hourly: every this many hours (default 1).' } } } },
  { name: 'list_scheduled', description: 'List this brain\'s scheduled tasks: id, title, when, next run.', inputSchema: { type: 'object', properties: {} } },
  { name: 'delete_scheduled', description: 'Delete a scheduled task by its id.', inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
  ...(SESSIONS ? [
    { name: 'start_session', description: 'Start a side session: a new chat in this brain that works on its own task in parallel, which the user can open from the Chats list, watch and talk to. Use it for a task of its own that shouldn\'t hold up this chat (a separate fix, a long investigation, work in another project folder). The prompt must stand on its own: the session can\'t see this chat. When it finishes a turn you started, its answer comes back here as a message.',
      inputSchema: { type: 'object', required: ['title', 'prompt'], properties: { title: { type: 'string', description: 'Under 60 characters.' }, prompt: { type: 'string', description: 'The full brief: goal, files, what done looks like.' }, folder: { type: 'string', description: 'A project folder to work in (default: this chat\'s folder).' } } } },
    { name: 'message_session', description: 'Send a follow-up message to a side session you started (by the id start_session returned). Its answer comes back here.',
      inputSchema: { type: 'object', required: ['session', 'message'], properties: { session: { type: 'string' }, message: { type: 'string' } } } },
  ] : []),
];

function ask(args, where = '/api/approval') {
  return new Promise(resolve => {
    const body = JSON.stringify(args);
    const req = http.request({ host: '127.0.0.1', port: PORT, path: where, method: 'POST',
      headers: { 'content-type': 'application/json', 'x-claudeos-token': TOKEN, 'content-length': Buffer.byteLength(body) } }, res => {
      let data = '';
      res.on('data', d => { data += d; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve({ behavior: 'deny', message: 'ClaudeOS gave no answer.' }); }
      });
    });
    req.setTimeout(0);
    req.on('error', () => resolve({ behavior: 'deny', error: 'ClaudeOS is not running.', message: 'ClaudeOS is not running, so nobody could approve this.' }));
    req.end(body);
  });
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async line => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;
  if (id === undefined) return; // notifications
  if (method === 'initialize') {
    return reply(id, { protocolVersion: params?.protocolVersion || '2025-03-26', capabilities: { tools: {} },
      serverInfo: { name: 'claudeos-approvals', version: '1.0.0' } });
  }
  if (method === 'ping') return reply(id, {});
  if (method === 'tools/list') {
    return reply(id, { tools: [{
      name: 'approve',
      description: 'Ask the ClaudeOS user to allow or deny a tool call.',
      inputSchema: { type: 'object', properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } }, required: ['tool_name', 'input'] },
    }, ...(LINKS.length ? [{
      name: 'ask_brain',
      description: `Hand a task to a linked ClaudeOS brain. It runs there with that brain's memory and team, and its final answer comes back. Linked brains: ${LINKS.join(', ')}.`,
      inputSchema: { type: 'object', properties: { brain: { type: 'string', enum: LINKS }, task: { type: 'string', description: 'What to do, with all the context it needs: it can\'t see this conversation.' } }, required: ['brain', 'task'] },
    }] : []), ...(TEAM.length ? [{
      name: 'post_brief',
      description: 'Hand work to your team. ClaudeOS queues tasks one at a time in this warm chat, retaining the same model and conversation history, and reports back in this chat when the whole brief is done.',
      inputSchema: { type: 'object', required: ['title', 'summary', 'tasks'], properties: {
        title: { type: 'string', description: 'A few words naming the job.' },
        summary: { type: 'string', description: 'The brief: what the user wants and how the work is split, in 2 to 5 sentences.' },
        tasks: { type: 'array', items: { type: 'object', required: ['id', 'employee', 'task'], properties: {
          id: { type: 'string', description: 'Short id, like t1.' },
          employee: { type: 'string', enum: TEAM, description: 'The skill name of the employee who does it.' },
          task: { type: 'string', description: 'Everything the employee needs: goal, input files, where to save output, relevant facts from memory. They retain this chat history.' },
          after: { type: 'array', items: { type: 'string' }, description: 'Ids of earlier tasks whose output this one needs. Leave empty when there is no dependency; execution is still sequential.' },
          request: { type: 'array', items: { type: 'string' }, description: 'Ids of the inbox requests this task works on.' },
          project: { type: 'string', description: 'Id of the active project this task is work on, if any.' },
          selection: { ...MODEL_SELECTION_SCHEMA, description: 'Complexity and reason annotate this task. Briefs inherit the warm chat model; changing providers or models requires a separately authorized specialist task.' },
        } } },
        skipped: { type: 'array', items: { type: 'object', properties: { request: { type: 'string' }, reason: { type: 'string' } } }, description: 'Requests nobody on the team can do, or too unclear to act on.' },
        notes: { type: 'string', description: 'Anything the user should know.' },
      } },
    }] : []), ...(DESK ? DESK_TOOLS : []), ...(DESK || MODEL_TASK ? MODEL_TOOLS : [])] });
  }
  if (method === 'tools/call' && ((DESK && DESK_TOOLS.some(t => t.name === params?.name)) || ((DESK || MODEL_TASK) && MODEL_TOOLS.some(t => t.name === params?.name)))) {
    let modelCaller, parentSelection;
    if (MODEL_TASK) {
      try { modelCaller = JSON.parse(process.env.CLAUDEOS_MODEL_CALLER || '{}'); parentSelection = JSON.parse(process.env.CLAUDEOS_MODEL_SELECTION || '{}'); } catch { /* defaults */ }
    }
    const r = await ask({ ...(params.arguments || {}), chat: CHAT, modelCaller, parentSelection }, `/api/desk/${params.name}`);
    return reply(id, { content: [{ type: 'text', text: r.error || r.text || JSON.stringify(r) }], isError: !!r.error });
  }
  if (method === 'tools/call' && params?.name === 'ask_brain') {
    const r = await ask(params.arguments || {}, '/api/handoff');
    return reply(id, { content: [{ type: 'text', text: r.error || `${r.brain} answered:\n\n${r.result}` }], isError: !!r.error });
  }
  if (method === 'tools/call' && params?.name === 'post_brief' && TEAM.length) {
    const r = await ask({ ...(params.arguments || {}), chat: CHAT }, '/api/brief');
    return reply(id, { content: [{ type: 'text', text: r.error || r.text || 'Brief accepted.' }], isError: !!r.error });
  }
  if (method === 'tools/call' && params?.name === 'approve') {
    const decision = await ask({ ...(params.arguments || {}), ...(WHO ? { who: WHO } : { chat: CHAT }) });
    return reply(id, { content: [{ type: 'text', text: JSON.stringify(decision) }] });
  }
  fail(id, `Unknown method ${method}`);
});
