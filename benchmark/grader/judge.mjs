// Blind pairwise screenshot judge. The judge is from the other model family than the contestants:
// Claude pair -> Codex (GPT) judges; Codex pair -> Claude judges. 4 calls (both orders, twice);
// a winner needs `agree` (default 3) of them, otherwise it's a tie.
import { findExe, codexCommand, refreshPath } from '../../agents.mjs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

const VIEWS = [['desktop', 'desktop, 1440 wide, full page'], ['phone', 'phone, 375 wide, full page'], ['states', 'after interaction: error state shown and the first FAQ answer opened']];

function run(cmd, args, { input, cwd, timeout = 6 * 60e3 }) {
  return new Promise(resolve => {
    const p = spawn(cmd, args, { cwd, windowsHide: true });
    let out = '', err = '';
    const t = setTimeout(() => p.kill(), timeout);
    p.stdout.on('data', d => out += d); p.stderr.on('data', d => err += d);
    p.on('error', e => { clearTimeout(t); resolve({code: -1, out, err:e.message}); });
    p.on('close', code => { clearTimeout(t); resolve({ code, out, err }); });
    if (input) p.stdin.end(input); else p.stdin.end();
  });
}
export function parseVerdict(text) {
  const m = String(text || '').match(/\{[\s\S]*"overall"[\s\S]*\}/);
  if (!m) return null;
  for (let end = m[0].length; end > 0; end = m[0].lastIndexOf('}', end - 1)) {
    try { const j = JSON.parse(m[0].slice(0, end + 1)); if (/^(A|B|TIE)$/i.test(j.overall)) return { ...j, overall: j.overall.toUpperCase() }; } catch { /* shorter */ }
  }
  return null;
}

// first/second: { shots: {desktop, phone, states} }. Returns the raw verdict from the judge's point of view (A = first).
async function oneCall(engine, task, first, second, i) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-judge-'));
  const images = [];
  for (const [label, page] of [['A', first], ['B', second]]) for (const [v] of VIEWS) if (page.shots[v]) {
    const f = path.join(work, `${label}-${v}.png`); fs.copyFileSync(page.shots[v], f); images.push([label, v, f]);
  }
  const list = images.map(([l, v, f]) => `- page ${l}, ${VIEWS.find(x => x[0] === v)[1]}: ${engine === 'claude' ? f : path.basename(f)}`).join('\n');
  const prompt = `${task.rubric}\n\nThe brief both pages were built from:\n"""\n${task.prompt}\n"""\n\nScreenshots${engine === 'claude' ? ' (open each file with the Read tool)' : ' (attached, in this order)'}:\n${list}\n`;
  let r;
  try {
    if (engine === 'codex') {
      const outFile = path.join(work, 'verdict.txt');
      refreshPath();
      const spec = codexCommand();
      if (!spec) throw new Error('Codex is not installed for judging.');
      r = await run(spec.command, [...spec.args, 'exec', '--skip-git-repo-check', '--ephemeral', '-s', 'read-only', ...images.flatMap(([, , f]) => ['-i', f]), '-o', outFile, '-'], { input: prompt, cwd: work });
      r.text = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : r.out;
    } else {
      refreshPath();
      const cmd = findExe('claude');
      if (!cmd) throw new Error('Claude is not installed for judging.');
      r = await run(cmd, ['-p', '--allowedTools', 'Read', '--output-format', 'text'], { input: prompt, cwd: work });
      r.text = r.out;
    }
  } finally { setTimeout(() => fs.rmSync(work, { recursive: true, force: true }), 1000); }
  const v = parseVerdict(r.text);
  return v ? { call: i, ...v } : { call: i, overall: null, error: (r.err || r.text || '').trim().split('\n').slice(-2).join(' ').slice(0, 300) };
}

// sides: [{id, shots}, {id, shots}] — the two contestants. Returns { engine, calls, votes, winner, agreement }.
export async function judgePair(engine, task, sides, { calls = 4, agree = 3 } = {}) {
  const orders = Array.from({ length: calls }, (_, i) => (i % 2 ? [sides[1], sides[0]] : [sides[0], sides[1]]));
  const raw = await Promise.all(orders.map((o, i) => oneCall(engine, task, o[0], o[1], i)));
  const votes = raw.map((v, i) => ({ ...v, first: orders[i][0].id, pick: v.overall === 'A' ? orders[i][0].id : v.overall === 'B' ? orders[i][1].id : v.overall === 'TIE' ? 'tie' : null }));
  const count = id => votes.filter(v => v.pick === id).length;
  const valid = votes.filter(v => v.pick).length;
  const winner = sides.find(s => count(s.id) >= agree)?.id || (valid ? 'tie' : null);
  const top = Math.max(...sides.map(s => count(s.id)), count('tie'));
  return { engine, calls: votes, winner, agreement: valid ? top / valid : null, valid };
}
