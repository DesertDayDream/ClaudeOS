// Tiny stdio MCP server that Claude Code uses as its --permission-prompt-tool when ClaudeOS
// runs a chat. It forwards each permission question to the ClaudeOS server, which shows an
// Allow/Deny card in the page and answers once the user clicks.
import http from 'node:http';
import readline from 'node:readline';

const PORT = Number(process.env.CLAUDEOS_PORT || 4747);
const TOKEN = process.env.CLAUDEOS_TOKEN || '';

function reply(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n'); }
function fail(id, message) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message } }) + '\n'); }

// Brains this chat may hand work to (empty in a hand-off itself, so hand-offs never chain).
const LINKS = (process.env.CLAUDEOS_LINKS || '').split('\n').filter(Boolean);
// Who is asking for approvals (an employee working a brief, or the Manager); empty in the chat.
const WHO = process.env.CLAUDEOS_WHO || '';
// Only the Manager's run gets post_brief, with the team it may assign work to.
let TEAM = [];
try { TEAM = JSON.parse(process.env.CLAUDEOS_TEAM || '[]'); } catch { /* no team */ }

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
      description: 'Hand your brief to ClaudeOS. It starts every task whose "after" tasks are done, up to 3 at a time, each as its own run of that employee. Call it once.',
      inputSchema: { type: 'object', required: ['title', 'summary', 'tasks'], properties: {
        title: { type: 'string', description: 'A few words naming the job.' },
        summary: { type: 'string', description: 'The brief: what the user wants and how the work is split, in 2 to 5 sentences.' },
        tasks: { type: 'array', items: { type: 'object', required: ['id', 'employee', 'task'], properties: {
          id: { type: 'string', description: 'Short id, like t1.' },
          employee: { type: 'string', enum: TEAM, description: 'The skill name of the employee who does it.' },
          task: { type: 'string', description: 'Everything the employee needs: goal, input files, where to save output, relevant facts from memory. They can\'t see the inbox.' },
          after: { type: 'array', items: { type: 'string' }, description: 'Ids of earlier tasks whose output this one needs. Leave empty to run at once.' },
          request: { type: 'array', items: { type: 'string' }, description: 'Ids of the inbox requests this task works on.' },
        } } },
        skipped: { type: 'array', items: { type: 'object', properties: { request: { type: 'string' }, reason: { type: 'string' } } }, description: 'Requests nobody on the team can do, or too unclear to act on.' },
        notes: { type: 'string', description: 'Anything the user should know.' },
      } },
    }] : [])] });
  }
  if (method === 'tools/call' && params?.name === 'ask_brain') {
    const r = await ask(params.arguments || {}, '/api/handoff');
    return reply(id, { content: [{ type: 'text', text: r.error || `${r.brain} answered:\n\n${r.result}` }], isError: !!r.error });
  }
  if (method === 'tools/call' && params?.name === 'post_brief' && TEAM.length) {
    const r = await ask(params.arguments || {}, '/api/brief');
    return reply(id, { content: [{ type: 'text', text: r.error || r.text || 'Brief accepted.' }], isError: !!r.error });
  }
  if (method === 'tools/call' && params?.name === 'approve') {
    const decision = await ask({ ...(params.arguments || {}), ...(WHO ? { who: WHO } : {}) });
    return reply(id, { content: [{ type: 'text', text: JSON.stringify(decision) }] });
  }
  fail(id, `Unknown method ${method}`);
});
