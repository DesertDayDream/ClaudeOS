// Artifacts: HTML pages Claude makes in a chat (a report, a dashboard, a mock-up, a little tool),
// kept in ~/.claudeos/artifacts/<id>/ and shown in the Artifacts tab. They are served from their
// own port with a sandbox CSP, so a page's scripts run in an opaque origin and can never read
// ClaudeOS's page (its token) or call its API.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const MAX_SIZE = 16 * 1024 * 1024;
const TYPES = { '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.svg': 'image/svg+xml', '.md': 'text/plain; charset=utf-8' };

export function createArtifacts({ dir, port, broadcast }) {
  const indexFile = path.join(dir, 'index.json');
  let index = {};
  try { index = JSON.parse(fs.readFileSync(indexFile, 'utf8')); } catch { /* none yet */ }
  const save = () => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(indexFile, JSON.stringify(index, null, 1)); };
  const urlOf = id => `http://localhost:${port}/a/${id}/`;
  const view = (id, a) => ({ id, ...a, url: urlOf(id) });
  const list = () => Object.entries(index).map(([id, a]) => view(id, a)).sort((x, y) => y.updated - x.updated);

  // publish a page from a file (republishing the same file, or passing its id, updates it in place)
  function publish({ file, title, description = '', id, chat = '', brain = '' }) {
    const src = path.resolve(String(file || ''));
    let st;
    try { st = fs.statSync(src); } catch { return { error: `No such file: ${file}` }; }
    const ext = path.extname(src).toLowerCase();
    if (!st.isFile() || !TYPES[ext]) return { error: 'An artifact is one .html (or .svg) file, with its CSS and scripts inline or from a CDN.' };
    if (st.size > MAX_SIZE) return { error: 'That page is over 16 MB.' };
    id = id && index[id] ? id : Object.keys(index).find(k => index[k].source === src) || crypto.randomBytes(5).toString('hex');
    const prev = index[id];
    fs.mkdirSync(path.join(dir, id), { recursive: true });
    fs.copyFileSync(src, path.join(dir, id, `index${ext === '.htm' ? '.html' : ext}`));
    index[id] = { title: String(title || prev?.title || path.basename(src, ext)).slice(0, 80), description: String(description || prev?.description || '').slice(0, 300),
      source: src, ext: ext === '.htm' ? '.html' : ext, chat: prev?.chat || chat, brain: prev?.brain || brain, created: prev?.created || Date.now(), updated: Date.now(), version: (prev?.version || 0) + 1 };
    save();
    broadcast('artifacts', { list: list(), id });
    return { ok: true, artifact: view(id, index[id]), updated: !!prev };
  }
  function remove(id) {
    if (!index[id]) return { error: 'That artifact is gone.' };
    fs.mkdirSync(path.join(dir, 'trash'), { recursive: true });
    try { fs.renameSync(path.join(dir, id), path.join(dir, 'trash', `${id}-${Date.now()}`)); } catch { /* already gone */ }
    delete index[id];
    save();
    broadcast('artifacts', { list: list() });
    return { ok: true };
  }

  // the artifacts' own server: GET only, nothing but the published pages
  const server = http.createServer((req, res) => {
    const m = req.url.match(/^\/a\/([0-9a-f]{10})\/?(?:\?.*)?$/);
    const a = m && index[m[1]];
    if (req.method !== 'GET' || !a) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, {
      'content-type': TYPES[a.ext] || 'text/plain',
      'content-security-policy': 'sandbox allow-scripts allow-popups allow-forms allow-modals allow-downloads',
      'cache-control': 'no-store',
    });
    fs.createReadStream(path.join(dir, m[1], `index${a.ext}`)).on('error', () => res.end()).pipe(res);
  });
  server.on('error', err => console.log(`Artifacts can't be served on port ${port}: ${err.message}`));
  server.listen(port, '127.0.0.1');

  return { publish, remove, list, close: () => server.close() };
}
