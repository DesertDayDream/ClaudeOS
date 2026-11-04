// Harbor in-container verifier for AI Bench web tasks: a fast structural check of what the agent left in /app.
// The full behaviour tests (a real browser) run afterwards on the host, on the collected files.
// Writes /logs/verifier/reward.txt (0..1) and structure.json (each part).
import fs from 'node:fs';
import path from 'node:path';

const app = process.argv[2] || '/app', out = process.argv[3] || '/logs/verifier';
const checks = JSON.parse(fs.readFileSync(new URL('./checks.json', import.meta.url), 'utf8'));
fs.mkdirSync(out, { recursive: true });

const files = [];
(function walk(dir) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(html?|js|mjs|css)$/i.test(e.name)) files.push(p);
  }
})(app);
const text = files.map(f => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } }).join('\n');

const entry = fs.existsSync(path.join(app, checks.entry || 'index.html'));
const ids = checks.requiredTestids || [];
const found = ids.filter(id => new RegExp(`data-testid\\s*=\\s*["']${id}["']|["']${id}["']`).test(text));
// no external requests: scripts, styles, fonts or images loaded from the network
const external = /(?:src|href)\s*=\s*["']https?:\/\/|@import\s+url\(\s*["']?https?:\/\/|url\(\s*["']?https?:\/\//i.test(text);

const parts = { entry: entry ? 1 : 0, testids: ids.length ? found.length / ids.length : 1, offline: external ? 0 : 1 };
const reward = entry ? (parts.testids * 0.8 + parts.offline * 0.2) : 0;
fs.writeFileSync(path.join(out, 'reward.txt'), reward.toFixed(4));
fs.writeFileSync(path.join(out, 'structure.json'), JSON.stringify(parts));
console.log(`entry=${entry} testids=${found.length}/${ids.length} offline=${!external} reward=${reward.toFixed(3)}`);
