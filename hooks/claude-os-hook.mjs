// Claude Code hook: logs tasks, skill hand-offs and task ends to <data folder>/activity.jsonl
// so ClaudeOS can show which employees (skills) are working. The data folder is passed as the
// first argument (ClaudeOS writes it into each brain's hooks), else ~/.claudeos.
// Never blocks Claude: any error is swallowed and the hook always exits 0.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA = process.argv[2] || process.env.CLAUDEOS_HOME || path.join(os.homedir(), '.claudeos');
const LOG = path.join(DATA, 'activity.jsonl');

let input = '';
process.stdin.on('data', d => { input += d; });
process.stdin.on('end', () => {
  try {
    const h = JSON.parse(input);
    const base = { ts: Date.now(), session: h.session_id, cwd: h.cwd };
    let ev = null;
    if (h.hook_event_name === 'UserPromptSubmit') {
      const prompt = String(h.prompt || '').replace(/\s+/g, ' ').trim();
      ev = { ...base, type: 'task', prompt: prompt.length > 140 ? prompt.slice(0, 139) + '…' : prompt };
    } else if (h.hook_event_name === 'PreToolUse' && h.tool_name === 'Skill') {
      ev = { ...base, type: 'skill', skill: h.tool_input?.skill || h.tool_input?.command || 'unknown' };
    } else if (h.hook_event_name === 'Stop') {
      ev = { ...base, type: 'stop' };
    }
    if (ev) {
      fs.mkdirSync(DATA, { recursive: true });
      fs.appendFileSync(LOG, JSON.stringify(ev) + '\n');
    }
  } catch { /* never break Claude over a log line */ }
  process.exit(0);
});
