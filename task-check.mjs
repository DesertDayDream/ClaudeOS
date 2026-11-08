// Every brief task is checked before it counts (the generator-verifier pattern: research/agentic-workflows.md).
// A cheap reviewer (Haiku) with a clean context, not the employee's own chat, reads the task, the employee's
// report and what actually changed: new or changed files in the task's folder, and the project's git diff.
// It answers pass or fail with concrete problems; a failed task gets one fix turn in the same warm chat.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { askClaude } from './grades.mjs';

const MAX_WORK = 40000;
const TEXT = /\.(md|txt|json|jsonc|ya?ml|toml|csv|html?|css|s?js|mjs|cjs|tsx?|jsx|py|verse|cs|cpp|c|h|hpp|java|kt|go|rs|rb|php|sh|ps1|bat|ini|cfg|xml|svg|sql|lua|gd|uplugin|uproject)$/i;

// what the employee made: files in its folder changed since the task started, and the project's uncommitted diff
export function collectWork({ folder, projectFolder, since = 0, max = MAX_WORK }) {
  const parts = [];
  let used = 0;
  const add = text => { if (used >= max) return; const t = text.slice(0, max - used); parts.push(t); used += t.length; };
  if (folder) {
    const files = [];
    (function walk(dir) {
      let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.name === 'node_modules' || e.name === '.git' || e.isSymbolicLink()) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else { try { const st = fs.statSync(p); if (st.mtimeMs >= since) files.push({ p, size: st.size }); } catch { /* gone */ } }
      }
    })(folder);
    for (const f of files.slice(0, 60)) {
      const rel = path.relative(folder, f.p);
      if (!TEXT.test(f.p) || f.size > 400000) { add(`--- ${rel} (${f.size} bytes, not text or too large to show)\n`); continue; }
      try { add(`--- ${rel}\n${fs.readFileSync(f.p, 'utf8')}\n`); } catch { /* unreadable */ }
    }
  }
  if (projectFolder && fs.existsSync(path.join(projectFolder, '.git'))) {
    try {
      const git = args => execFileSync('git', ['-C', projectFolder, ...args], { encoding: 'utf8', windowsHide: true, timeout: 20000, maxBuffer: 8 << 20 });
      const status = git(['status', '--short']).trim();
      if (status) add(`--- git status (${projectFolder})\n${status}\n`);
      const diff = git(['diff', '--no-color']).trim();
      if (diff) add(`--- git diff\n${diff}\n`);
    } catch { /* not a usable repository */ }
  }
  const text = parts.join('');
  return used >= max ? text + '\n[… cut: more work than the reviewer reads]' : text;
}

export function checkPrompt({ task, report, work }) {
  return `You review an AI employee's finished task before it counts as done. You did not do the work; judge only what is here.

Fail it only for concrete problems that matter: something the task asked for is missing or wrong, the work clearly does not run or would break, the report claims something the work does not show, or it touched what it was told not to. Do not fail for style, taste or wording. If the work is not visible below (for example it lives in an app or editor), judge the report against the task and pass unless something is clearly wrong.

Reply with only JSON: {"pass": true|false, "issues": ["short, specific problem and where", ...]} (at most 5 issues; [] when it passes).

TASK
${task}

EMPLOYEE'S REPORT
${report || '(no report)'}

WHAT CHANGED
${work || '(no files changed in the task folder or project)'}`;
}

export function parseCheck(text) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    if (typeof j.pass !== 'boolean') return null;
    const issues = (Array.isArray(j.issues) ? j.issues : []).filter(i => typeof i === 'string' && i.trim()).slice(0, 5).map(i => i.trim().slice(0, 400));
    return { pass: j.pass || !issues.length ? j.pass : false, issues };
  } catch { return null; }
}

export async function checkTask({ task, report, folder, projectFolder, since, ask = prompt => askClaude(prompt, { model: 'haiku' }) }) {
  const work = collectWork({ folder, projectFolder, since });
  const r = parseCheck(await ask(checkPrompt({ task, report, work })));
  return r || { skipped: true, issues: [] };
}

export const fixPrompt = issues => `A reviewer checked your last task and found problems:\n${issues.map(i => `- ${i}`).join('\n')}\n\nFix them in place (same files and folder), verify, then end with a short report of what you changed.`;
