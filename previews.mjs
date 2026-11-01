// Previews: a file Claude made or linked, shown rendered beside the chat the way Claude Desktop
// does (a page, an SVG, a PDF, an image, Markdown, a CSV, code), and code blocks Claude wrote
// (```html, ```svg, ```mermaid). Pages are served from the artifacts port under a sandbox CSP, so
// their scripts can never reach ClaudeOS's page or its API. A previewed file is watched, and the
// panel reloads when Claude changes it.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const MAX = 16 * 1024 * 1024, MAX_TEXT = 1024 * 1024, KEEP = 40;
const SANDBOX = 'sandbox allow-scripts allow-popups allow-forms allow-modals allow-downloads';
const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.svg': 'image/svg+xml', '.pdf': 'application/pdf',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.avif': 'image/avif',
  '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.glb': 'model/gltf-binary',
};
const FRAME = new Set(['.html', '.htm', '.svg', '.pdf']);
const IMAGE = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.avif']);
const MEDIA = new Set(['.mp4', '.webm', '.mp3', '.wav']);
const TEXT = new Set(['.md', '.markdown', '.txt', '.csv', '.tsv', '.json', '.jsonl', '.log', '.xml', '.yml', '.yaml', '.toml', '.ini', '.cfg', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
  '.py', '.rs', '.go', '.java', '.cs', '.cpp', '.c', '.h', '.hpp', '.css', '.scss', '.sh', '.ps1', '.bat', '.cmd', '.sql', '.verse', '.lua', '.rb', '.php', '.kt', '.swift', '.gd', '.glsl', '.hlsl', '.env.example']);

const mermaidPage = src => `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;background:#fff;font-family:system-ui,sans-serif}#d{padding:16px;display:flex;justify-content:center}#e{color:#b00;padding:16px;white-space:pre-wrap;font:12px ui-monospace,monospace}
</style></head><body><div id="d"></div><div id="e"></div>
<script src="https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.min.js"></script>
<script>const src=${JSON.stringify(src).replace(/</g, '\\u003c')};
mermaid.initialize({startOnLoad:false,theme:'default',securityLevel:'strict'});
mermaid.render('g',src).then(r=>{document.getElementById('d').innerHTML=r.svg}).catch(err=>{document.getElementById('e').textContent=String(err.message||err)});</script></body></html>`;

export function createPreviews({ port, broadcast }) {
  const items = new Map(); // token -> { file?, dir?, name, content?, type?, watcher? }
  const base = () => `http://localhost:${port()}`;

  function remember(token, item) {
    items.set(token, item);
    while (items.size > KEEP) {
      const [old, it] = items.entries().next().value;
      it.watcher?.close();
      items.delete(old);
    }
  }
  // a file changed on disk: tell the panel to reload (a burst of writes is one change)
  function watch(token, file) {
    let t = 0;
    try {
      return fs.watch(file, () => { clearTimeout(t); t = setTimeout(() => broadcast('preview-changed', { token }), 250); });
    } catch { return null; }
  }

  // file: absolute path. Says how the page should show it.
  function ofFile(file) {
    let st;
    try { st = fs.statSync(file); } catch { return { error: `There's no ${file}.` }; }
    if (!st.isFile()) return { kind: 'none', file };
    const name = path.basename(file), ext = path.extname(file).toLowerCase();
    const out = { file, name, size: st.size, modified: st.mtimeMs };
    if (FRAME.has(ext) || IMAGE.has(ext) || MEDIA.has(ext)) {
      if (st.size > MAX && !MEDIA.has(ext)) return { ...out, kind: 'none', why: 'Over 16 MB.' };
      // existing token for the same file: same URL, so the panel just reloads it
      let token = [...items].find(([, it]) => it.file === file)?.[0];
      if (!token) {
        token = crypto.randomBytes(9).toString('hex');
        remember(token, { file, dir: path.dirname(file), name, watcher: watch(token, file) });
      }
      const url = `${base()}/p/${token}/${encodeURIComponent(name)}`;
      return { ...out, token, url, kind: IMAGE.has(ext) ? 'image' : MEDIA.has(ext) ? (ext === '.mp3' || ext === '.wav' ? 'audio' : 'video') : 'frame' };
    }
    if (TEXT.has(ext) || (!ext && st.size < MAX_TEXT)) {
      if (st.size > MAX_TEXT) return { ...out, kind: 'none', why: 'Over 1 MB of text.' };
      const text = fs.readFileSync(file, 'utf8');
      if (text.includes('\u0000')) return { ...out, kind: 'none' };
      let token = [...items].find(([, it]) => it.file === file)?.[0];
      if (!token) { token = crypto.randomBytes(9).toString('hex'); remember(token, { file, name, watcher: watch(token, file) }); }
      const kind = ext === '.md' || ext === '.markdown' ? 'markdown' : ext === '.csv' || ext === '.tsv' ? 'table' : 'text';
      return { ...out, token, kind, lang: ext.slice(1), text };
    }
    return { ...out, kind: 'none' };
  }
  // a code block from the chat: html / svg / mermaid
  function ofContent(content, type) {
    type = String(type || '').toLowerCase();
    const map = { html: ['text/html; charset=utf-8', 'page.html'], svg: ['image/svg+xml', 'drawing.svg'], xml: ['image/svg+xml', 'drawing.svg'], mermaid: ['text/html; charset=utf-8', 'diagram.html'] };
    if (!map[type]) return { error: `No preview for ${type || 'that'}.` };
    const body = String(content || '');
    if (body.length > MAX) return { error: 'Too big to preview.' };
    // the same block clicked twice reuses its URL
    const token = crypto.createHash('sha1').update(type + '\0' + body).digest('hex').slice(0, 18);
    if (!items.has(token)) remember(token, { name: map[type][1], type: map[type][0], content: type === 'mermaid' ? mermaidPage(body) : body });
    return { token, kind: 'frame', name: type === 'mermaid' ? 'Diagram' : map[type][1], url: `${base()}/p/${token}/${map[type][1]}` };
  }

  // GET /p/<token>/<path>: the file, or a file beside it (a page's own CSS, scripts, images)
  function handle(req, res) {
    const m = req.url.match(/^\/p\/([0-9a-f]{18})\/([^?#]*)/);
    if (!m) return false;
    const it = items.get(m[1]);
    const send = (code, type, body) => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'content-security-policy': SANDBOX }); res.end(body); };
    if (!it || req.method !== 'GET') { send(404, 'text/plain', 'Not found'); return true; }
    if (it.content != null) { send(200, it.type, it.content); return true; }
    if (!it.dir) { send(404, 'text/plain', 'Not found'); return true; }
    let rel;
    try { rel = decodeURIComponent(m[2]); } catch { rel = m[2]; }
    const abs = path.resolve(it.dir, rel || it.name);
    if (abs !== it.dir && !abs.startsWith(it.dir + path.sep)) { send(404, 'text/plain', 'Not found'); return true; }
    let st;
    try { st = fs.statSync(abs); } catch { send(404, 'text/plain', 'Not found'); return true; }
    if (!st.isFile() || st.size > (MEDIA.has(path.extname(abs).toLowerCase()) ? Infinity : MAX)) { send(404, 'text/plain', 'Not found'); return true; }
    const ext = path.extname(abs).toLowerCase();
    // Chrome's PDF viewer can't run in a sandboxed document; a PDF's own scripts are off there anyway
    const headers = { 'content-type': MIME[ext] || 'application/octet-stream', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
    if (ext !== '.pdf') headers['content-security-policy'] = SANDBOX;
    res.writeHead(200, headers);
    fs.createReadStream(abs).on('error', () => res.end()).pipe(res);
    return true;
  }

  return { ofFile, ofContent, handle };
}
