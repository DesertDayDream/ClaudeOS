// Brain links: one brain's chat hands a task to a linked brain. The task runs headless in the
// linked brain's folder (its CLAUDE.md, shared brain, team and activity hooks apply), and only
// Claude's final answer goes back. A hand-off can't hand off again, so links never loop.
import { spawn, execFile } from 'node:child_process';

export function runHandoff({ brain, task, mcpServers, onExit }) {
  const args = ['-p', task, '--output-format', 'json',
    '--mcp-config', JSON.stringify({ mcpServers }), '--permission-prompt-tool', 'mcp__claudeos__approve', '--allowedTools', 'mcp__memory'];
  const proc = spawn('claude', args, { cwd: brain.path, env: { ...process.env, MCP_TOOL_TIMEOUT: String(24 * 3600 * 1000) }, windowsHide: true });
  let out = '', err = '', killed = false;
  const done = new Promise(resolve => {
    proc.stdout.on('data', d => { out += d; });
    proc.stderr.on('data', d => { err += d; });
    proc.on('error', e => resolve({ error: `Could not start Claude Code: ${e.message}` }));
    proc.on('close', code => {
      if (killed) return resolve({ error: 'The hand-off was stopped.' });
      try {
        const r = JSON.parse(out.trim().split('\n').pop());
        resolve(r.is_error ? { error: String(r.result || 'The linked brain failed.') } : { result: String(r.result || '') });
      } catch { resolve({ error: err.trim().split('\n').pop() || `Claude exited with code ${code}` }); }
    });
  }).finally(onExit);
  return {
    done,
    // end Claude in the linked brain and anything it started
    stop() { killed = true; execFile('taskkill', ['/pid', String(proc.pid), '/T', '/F'], () => {}); },
  };
}
