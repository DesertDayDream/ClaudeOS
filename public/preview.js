// The preview panel beside the chat: a file Claude made or linked, or a code block it wrote, shown
// rendered (pages and SVGs in a sandboxed frame, PDFs, images, video, Markdown, CSV as a table,
// code as text). It reloads by itself when Claude changes the file.
import { events } from '/events.js';
import { markdown } from '/markdown.js';

const TOKEN = window.CLAUDEOS_TOKEN;
const panel = document.getElementById('preview');
const nameEl = document.getElementById('pvName');
const bodyEl = document.getElementById('pvBody');
let shown = null; // { req, res }

async function api(path, body) {
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-claudeos-token': TOKEN }, body: JSON.stringify(body) });
  return res.json().catch(() => ({ error: `HTTP ${res.status}` }));
}
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// "a,b\n1,2" -> rows of cells (quotes and "" inside them)
function parseCsv(text, sep) {
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; continue; }
    if (c === '"') q = true;
    else if (c === sep) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function draw(r, keepScroll) {
  const scroll = keepScroll ? bodyEl.scrollTop : 0;
  nameEl.textContent = r.name || 'Preview';
  nameEl.title = r.file || '';
  panel.querySelector('[data-pv-act="editor"]').hidden = !r.file;
  const bust = `${r.url && r.url.includes('?') ? '&' : '?'}t=${Date.now()}`;
  if (r.kind === 'frame') bodyEl.innerHTML = `<iframe src="${esc(r.url + bust)}" title="${esc(r.name)}"></iframe>`;
  else if (r.kind === 'image') bodyEl.innerHTML = `<div class="pv-img"><img src="${esc(r.url + bust)}" alt="${esc(r.name)}"></div>`;
  else if (r.kind === 'video') bodyEl.innerHTML = `<div class="pv-img"><video src="${esc(r.url)}" controls></video></div>`;
  else if (r.kind === 'audio') bodyEl.innerHTML = `<div class="pv-img"><audio src="${esc(r.url)}" controls></audio></div>`;
  else if (r.kind === 'markdown') bodyEl.innerHTML = `<div class="msg assistant pv-doc"><div class="body">${markdown(r.text)}</div></div>`;
  else if (r.kind === 'table') {
    const rows = parseCsv(r.text, r.lang === 'tsv' ? '\t' : ',').slice(0, 2000);
    const [head = [], ...rest] = rows;
    bodyEl.innerHTML = `<div class="pv-table"><table><thead><tr>${head.map(c => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${rest.map(row => `<tr>${row.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  } else bodyEl.innerHTML = `<pre class="pv-text">${esc(r.text)}</pre>`;
  bodyEl.scrollTop = scroll;
}

// what: { path } or { content, type }. Files with nothing to render open in the editor instead.
export async function preview(what) {
  const r = await api('/api/preview', what);
  if (r.error) { alert(r.error); return; }
  if (r.kind === 'none') {
    const o = await api('/api/open-file', { path: r.file || what.path });
    if (o.error) alert(o.error);
    return;
  }
  shown = { req: what, res: r };
  panel.hidden = false;
  document.body.classList.add('previewing');
  draw(r);
}
export function closePreview() {
  shown = null;
  panel.hidden = true;
  bodyEl.innerHTML = '';
  document.body.classList.remove('previewing');
}
// a local image in a reply: ask the server for its URL on the preview port
export async function loadLocalImages(root) {
  for (const img of root.querySelectorAll('img.md-img[data-local]:not([src])')) {
    const r = await api('/api/preview', { path: img.dataset.local });
    if (r.kind === 'image') { img.src = r.url; img.addEventListener('click', () => preview({ path: img.dataset.local })); }
    else img.replaceWith(Object.assign(document.createElement('span'), { textContent: img.alt || img.dataset.local, className: 'md-img-missing' }));
  }
}

panel.addEventListener('click', async e => {
  const act = e.target.closest('[data-pv-act]')?.dataset.pvAct;
  if (act === 'close') closePreview();
  else if (act === 'reload' && shown) preview(shown.req);
  else if (act === 'editor' && shown?.res.file) { const o = await api('/api/open-file', { path: shown.res.file }); if (o.error) alert(o.error); }
});
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !panel.hidden && !e.target.closest('input, textarea')) closePreview(); });
// Claude changed the file: show the new version where you were
events.addEventListener('preview-changed', async e => {
  const { token } = JSON.parse(e.data);
  if (!shown || shown.res.token !== token) return;
  const r = await api('/api/preview', shown.req);
  if (r.error || r.kind === 'none') return;
  shown.res = r;
  draw(r, true);
});
