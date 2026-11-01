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
    }] : [])] });
  }
  if (method === 'tools/call' && params?.name === 'ask_brain') {
    const r = await ask(params.arguments || {}, '/api/handoff');
    return reply(id, { content: [{ type: 'text', text: r.error || `${r.brain} answered:\n\n${r.result}` }], isError: !!r.error });
  }
  if (method === 'tools/call' && params?.name === 'approve') {
    const decision = await ask(params.arguments || {});
    return reply(id, { content: [{ type: 'text', text: JSON.stringify(decision) }] });
  }
  fail(id, `Unknown method ${method}`);
});
