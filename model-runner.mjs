import { spawn, execFile } from 'node:child_process';
import { runCodexTurn } from './codex.mjs';
import { TOOL_TIMEOUT_MS } from './tool-timeouts.mjs';
import { selectModel, fallbackModel, usageLimited, modelCatalog } from './model-routing.mjs';

// Both attempts keep the same permissions and tools. Injectable adapters make failure/stop tests deterministic.
export function runModelTask({ prompt, selection, caller, cwd, mcpServers, allowed = ['mcp__memory'], scope = {}, addDirs = [], session,
  onLog = () => {}, onModel = () => {}, onApproval, catalog = modelCatalog(), claudeRun = runClaudeTask, codexRun = runCodexTask }) {
  let active, stopped = false;
  const history = [];
  const done = (async () => {
    let pick = selectModel(selection, caller, catalog);
    if (pick.error) return pick;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (stopped) return { stopped: true };
      onModel(pick, attempt);
      onLog({ ts: Date.now(), kind: 'text', text: `Model: ${pick.engine} / ${pick.model || 'provider default'}${pick.effort ? ` / ${pick.effort}` : ''}. ${pick.reason}` });
      const resumed = history.length ? `\n\nPrevious attempt stopped on a usage limit. Inspect current files and the actions below before continuing. Do not repeat completed writes or external actions. If an action's outcome is uncertain, verify it first.\n${history.join('\n').slice(-24000)}` : '';
      const servers = { ...mcpServers };
      if (servers.claudeos?.env?.CLAUDEOS_MODEL_TASK) servers.claudeos = { ...servers.claudeos, env: { ...servers.claudeos.env,
        CLAUDEOS_MODEL_SELECTION: JSON.stringify({ ...pick.selection, ...(pick.selection.model && !pick.selection.fallback ? { engine: pick.engine } : {}) }),
        CLAUDEOS_MODEL_CALLER: JSON.stringify({ ...caller, engine: pick.engine, ...(pick.engine === 'codex' ? { codexModel: pick.model, codexEffort: pick.effort } : { model: pick.model, effort: pick.effort }) }) } };
      active = (pick.engine === 'claude' ? claudeRun : codexRun)({ ...pick, prompt: prompt + resumed, cwd, mcpServers: servers, allowed, scope, addDirs, onApproval, mode: caller?.mode, session,
        onLog: entry => { history.push(`${entry.kind}: ${entry.text}`); if (history.length > 150) history.shift(); onLog(entry); } });
      const result = await active.done;
      if (stopped || result.stopped) return { stopped: true };
      const next = attempt === 0 && usageLimited(result.error) ? fallbackModel(pick, caller, catalog) : null;
      if (!next) return { ...result, model: { engine: pick.engine, model: pick.model, effort: pick.effort, reason: pick.reason }, attempts: attempt + 1 };
      onLog({ ts: Date.now(), kind: 'text', text: `Usage limit on ${pick.engine}; switching to ${next.engine}.` });
      pick = next;
    }
  })().catch(error => ({ error: error.message || String(error) }));
  return { done, stop() { stopped = true; active?.stop(); } };
}

export function runClaudeTask({ prompt, model, effort, cwd, mcpServers, allowed, scope, addDirs, onLog, mode, session }) {
  // Pipe the prompt: fallback context can exceed Windows' command-line length limit.
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--model', model,
    ...(effort ? ['--effort', effort] : []), ...(session ? ['--session-id', session] : []), '--mcp-config', JSON.stringify({ mcpServers }),
    '--permission-prompt-tool', 'mcp__claudeos__approve', '--allowedTools', allowed.join(','),
    ...(scope.disallowed?.length ? ['--disallowedTools', scope.disallowed.join(',')] : []),
    ...(scope.settings ? ['--settings', JSON.stringify(scope.settings)] : []), ...(mode ? ['--permission-mode', mode] : []), ...addDirs.flatMap(d => ['--add-dir', d])];
  const proc = spawn('claude', args, { cwd, windowsHide: true, env: { ...process.env, MCP_TOOL_TIMEOUT: String(TOOL_TIMEOUT_MS), CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' } });
  proc.stdin.on('error', () => {}); // startup/quota failures can close stdin before the prompt is consumed
  proc.stdin.end(prompt);
  let buffer = '', stderr = '', last, stopped = false;
  const done = new Promise(resolve => {
    proc.stdout.on('data', chunk => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl); buffer = buffer.slice(nl + 1);
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type === 'result') last = ev;
        if (ev.type === 'assistant') for (const b of ev.message?.content || []) {
          if (b.type === 'text') onLog({ ts: Date.now(), kind: 'text', text: b.text });
          if (b.type === 'tool_use') onLog({ ts: Date.now(), kind: 'tool', text: `${b.name}: ${JSON.stringify(b.input).slice(0, 2000)}` });
        }
      }
    });
    proc.stderr.on('data', d => { stderr = (stderr + d).slice(-8000); });
    proc.on('error', e => resolve({ error: `Could not start Claude: ${e.message}` }));
    proc.on('close', code => resolve(stopped ? { stopped: true } : last ? last.is_error
      ? { error: String(last.result || last.errors?.join('\n') || 'Claude failed.') }
      : { result: String(last.result || ''), usage: { cost: last.total_cost_usd ?? null, turns: last.num_turns || 0 } }
      : { error: stderr.trim() || `Claude exited with code ${code}.` }));
  });
  return { done, stop() { stopped = true; if (proc.pid) execFile('taskkill', ['/pid', String(proc.pid), '/T', '/F'], () => {}); } };
}

export function runCodexTask({ prompt, model, effort, cwd, mcpServers, scope, addDirs, onLog, onApproval, mode }) {
  // Plugin visibility rules must not be silently weakened on a provider switch.
  if (scope.disallowed?.some(t => !/^Skill\(.+\)$/.test(t)) || Object.keys(scope.settings || {}).some(k => k !== 'enabledPlugins')) return { done: Promise.resolve({ error: 'This task has Claude-specific tool restrictions that cannot be preserved by Codex.' }), stop() {} };
  const excluded = (scope.disallowed || []).map(t => t.slice(6, -1));
  prompt += `\n\nBrain scope: do not use personal skills named ${excluded.join(', ') || '(none excluded)'}. Only this brain's team skills apply. Claude plugin enablement is provider-specific and is not permission to use a Codex integration; verify required tools are present before acting.`;
  let result = '', usage;
  const servers = Object.fromEntries(Object.entries(mcpServers).map(([name, server]) => [name, name === 'claudeos'
    ? { ...server, disabled_tools: ['approve', 'terminal_run', 'schedule_task', 'delete_scheduled', 'update_app'] } : server]));
  if (mode === 'plan') delete servers.claudeos;
  const run = runCodexTurn({ cwd, prompt, model, effort, mcpServers: servers, addDirs, mode,
    onApproval: onApproval || (async () => 'decline'),
    onEvent: ev => {
      if (ev.type === 'turn.completed') usage = ev.usage;
      if (ev.type !== 'item.completed') return;
      const item = ev.item;
      if (item?.type === 'agent_message') { result = item.text || result; onLog({ ts: Date.now(), kind: 'text', text: item.text || '' }); }
      else if (item && ['command_execution', 'file_change', 'mcp_tool_call', 'web_search', 'error'].includes(item.type)) onLog({ ts: Date.now(), kind: item.type === 'error' ? 'error' : 'tool', text: JSON.stringify(item).slice(0, 8000) });
    } });
  return { done: run.done.then(r => ({ ...r, result, usage })), stop: () => run.stop() };
}
