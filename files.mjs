// The files of a chat's folder, for @mentions in the message box: git's list in a repository (tracked
// and new, minus ignored), else a walk that skips the usual heavy folders. Cached briefly per folder.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.cache', '__pycache__', '.venv', 'venv', 'Intermediate', 'Saved', 'DerivedDataCache', 'Binaries', '.vs', 'attachments']);
const MAX = 20000, TTL = 30e3;
const cache = new Map(); // folder -> { at, files }

function gitFiles(dir) {
  return new Promise(resolve => {
    execFile('git', ['ls-files', '-co', '--exclude-standard'], { cwd: dir, windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: 15000 },
      (err, out) => resolve(err ? null : out.split('\n').filter(Boolean).slice(0, MAX)));
  });
}
function walk(dir) {
  const out = [], queue = [''];
  while (queue.length && out.length < MAX) {
    const rel = queue.shift();
    let list;
    try { list = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }); } catch { continue; }
    for (const e of list) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!SKIP.has(e.name) && !e.name.startsWith('.')) queue.push(r); }
      else if (e.isFile()) out.push(r);
    }
  }
  return out;
}
async function filesOf(dir) {
  const c = cache.get(dir);
  if (c && Date.now() - c.at < TTL) return c.files;
  const files = (await gitFiles(dir)) || walk(dir);
  cache.set(dir, { at: Date.now(), files });
  return files;
}

// best matches first: the name starts with the query, then the name contains it, then the path
// does, then its letters in order (fuzzy)
export async function findFiles(dir, q = '', limit = 30) {
  const files = await filesOf(dir);
  q = String(q || '').toLowerCase().replace(/\\/g, '/');
  if (!q) return files.slice(0, limit);
  const score = f => {
    const p = f.toLowerCase(), name = p.slice(p.lastIndexOf('/') + 1);
    if (name.startsWith(q)) return 0;
    if (name.includes(q)) return 1;
    if (p.includes(q)) return 2;
    let k = 0;
    for (const ch of p) if (ch === q[k]) k++;
    return k === q.length ? 3 : -1;
  };
  const hits = [];
  for (const f of files) { const s = score(f); if (s >= 0) hits.push([s, f.length, f]); }
  return hits.sort((a, b) => a[0] - b[0] || a[1] - b[1]).slice(0, limit).map(h => h[2]);
}
