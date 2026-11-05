// A benchmark contestant's own console window: the benchmark starts this helper in a new window
// (`start` from cmd), and it runs Claude Code or Codex there with the user's own setup.
// The job file holds the exact command, so the prompt's quotes and line breaks reach the program
// unchanged (passing them through cmd or PowerShell would mangle them).
// argv[2]: job file { title, command, args, cwd, pidFile }
import fs from 'node:fs';
import { spawn } from 'node:child_process';

const job = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
process.title = job.title || 'ClaudeOS benchmark';
process.stdout.write(`\x1b]0;${process.title}\x07`);
try { fs.writeFileSync(job.pidFile, String(process.pid)); } catch { /* the benchmark can still find the session by its tag */ }
const env = { ...process.env, ...(job.env || {}) };
// the user's subscription sign-in, never an API key; and not a nested session of the app that started us
for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_API_KEY', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT']) delete env[k];
const child = spawn(job.command, job.args, { cwd: job.cwd, stdio: 'inherit', env });
child.on('error', err => { console.error(`\nCould not start ${job.command}: ${err.message}`); setTimeout(() => process.exit(1), 60e3); });
child.on('exit', code => process.exit(code ?? 0));
