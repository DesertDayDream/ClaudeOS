// Markdown for chat replies: code fences (language label, Copy), headings, nested and numbered lists
// that keep their numbers, tables, quotes, rules, and inline code/bold/italics/strike/links.
// Links to files (anything not http/https/mailto) open in the preview panel: data-file holds the path.
// html / svg / mermaid code blocks get a Preview button (data-pv); ![alt](src) shows the image.
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function inline(src) {
  // code spans first, so nothing inside them is touched
  const codes = [];
  let s = String(src).replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_, __, c) => { codes.push(c.trim()); return `\u0000${codes.length - 1}\u0000`; });
  s = esc(s)
    .replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^)]*&quot;)?\)/g, (_, alt, src) => image(alt, src))
    .replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^)]*&quot;)?\)/g, (_, text, href) => link(text, href))
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+[^\s<).,;:!?'"])/g, (_, pre, url) => `${pre}<a href="${url}" target="_blank" rel="noopener">${url}</a>`)
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^\w*])__(?=\S)([\s\S]*?\S)__(?!\w)/g, '$1<b>$2</b>')
    .replace(/(^|[^*\w])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?!\w)/g, '$1<i>$2</i>')
    .replace(/(^|[^\w_])_(?=[^\s_])([^_\n]*?[^\s_])_(?!\w)/g, '$1<i>$2</i>')
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<s>$1</s>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[i])}</code>`);
}
// ![alt](src): web images as they are; a file on this PC loads through the preview server (chat.js)
function image(alt, src) {
  if (/^https?:/i.test(src)) return `<img class="md-img" src="${src}" alt="${alt}" loading="lazy">`;
  if (/^(javascript|data|vbscript):/i.test(src)) return alt;
  return `<img class="md-img" data-local="${src}" alt="${alt}" title="${src}">`;
}
function link(text, href) {
  // href and text arrive escaped already
  if (/^(https?:|mailto:)/i.test(href)) return `<a href="${href}" target="_blank" rel="noopener">${text}</a>`;
  if (/^(javascript|data|vbscript):/i.test(href) || href.startsWith('#')) return text;
  return `<a href="#" class="file" data-file="${href}" title="Preview ${href}">${text}</a>`;
}

const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([\w+#.-]*)/;
const BULLET = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
// a table row's cells; a | inside `code` doesn't split
const cells = line => {
  const out = [];
  let cell = '', tick = 0;
  for (let k = 0, s = line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, ''); k < s.length; k++) {
    const c = s[k];
    if (c === '`') tick ^= 1;
    if (c === '\\' && s[k + 1] === '|') { cell += '|'; k++; continue; }
    if (c === '|' && !tick) { out.push(cell.trim()); cell = ''; continue; }
    cell += c;
  }
  return [...out, cell.trim()];
};
const width = s => s.replace(/\t/g, '    ').length;

function blocks(lines) {
  let html = '', i = 0;
  const para = [];
  const flush = () => { if (para.length) html += `<p>${para.map(inline).join('<br>')}</p>`; para.length = 0; };
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { flush(); i++; continue; }
    const fence = line.match(FENCE);
    if (fence) {
      flush();
      const close = new RegExp(`^\\s{0,3}${fence[1][0]}{${fence[1].length},}\\s*$`);
      const body = [];
      for (i++; i < lines.length && !close.test(lines[i]); i++) body.push(lines[i]);
      i++; // the closing fence (or the end, while it's still streaming)
      const lang = fence[2];
      const pv = /^(html|svg|mermaid)$/i.test(lang) ? `<button type="button" class="copy pv" data-pv="${esc(lang.toLowerCase())}" title="Show it rendered">Preview</button>` : '';
      html += `<div class="code">${lang ? `<span class="lang">${esc(lang)}</span>` : ''}${pv}<button type="button" class="copy" title="Copy">Copy</button><pre><code>${esc(body.join('\n'))}</code></pre></div>`;
      continue;
    }
    const h = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (h) { flush(); html += `<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`; i++; continue; }
    if (RULE.test(line)) { flush(); html += '<hr>'; i++; continue; }
    if (/^\s{0,3}>/.test(line)) {
      flush();
      const q = [];
      while (i < lines.length && /^\s{0,3}>/.test(lines[i])) q.push(lines[i++].replace(/^\s{0,3}>\s?/, ''));
      html += `<blockquote>${blocks(q)}</blockquote>`;
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      flush();
      const head = cells(line), align = cells(lines[i + 1]).map(c => c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : '');
      const td = (tag, c, k) => `<${tag}${align[k] ? ` style="text-align:${align[k]}"` : ''}>${inline(c)}</${tag}>`;
      let t = `<div class="table"><table><thead><tr>${head.map((c, k) => td('th', c, k)).join('')}</tr></thead><tbody>`;
      for (i += 2; i < lines.length && lines[i].includes('|') && lines[i].trim(); i++) t += `<tr>${cells(lines[i]).map((c, k) => td('td', c, k)).join('')}</tr>`;
      html += t + '</tbody></table></div>';
      continue;
    }
    if (BULLET.test(line) && (!para.length || !/^\d/.test(line.trim()))) { flush(); [html, i] = list(lines, i, html); continue; }
    para.push(line.trim());
    i++;
  }
  flush();
  return html;
}

// A list runs until a line that is neither an item at its indent, a deeper line, nor a blank between
// items. Blank lines between items don't end it, so "1. … (blank) 2. …" stays one list and
// a list that starts at 22 says 22.
function list(lines, i, html) {
  const first = lines[i].match(BULLET);
  const indent = width(first[1]), ordered = /\d/.test(first[2]);
  const items = [];
  while (i < lines.length) {
    const m = lines[i].match(BULLET);
    if (m && width(m[1]) === indent && /\d/.test(m[2]) === ordered) {
      items.push([m[3]]);
      i++;
      continue;
    }
    if (!lines[i].trim()) {
      // a blank: the list goes on only if the next non-blank line belongs to it
      let j = i;
      while (j < lines.length && !lines[j].trim()) j++;
      const n = lines[j];
      if (n === undefined) break;
      const nm = n.match(BULLET);
      const inList = (nm && width(nm[1]) === indent && /\d/.test(nm[2]) === ordered) || width(n.match(/^\s*/)[0]) > indent;
      if (!inList) break;
      items.at(-1).push('');
      i++;
      continue;
    }
    // deeper text or a nested list belongs to the item above; anything else ends the list
    if (width(lines[i].match(/^\s*/)[0]) > indent || (!m && !FENCE.test(lines[i]) && items.at(-1).at(-1) !== '')) {
      items.at(-1).push(lines[i]);
      i++;
      continue;
    }
    break;
  }
  const start = ordered ? parseInt(first[2], 10) : 1;
  const tag = ordered ? 'ol' : 'ul';
  html += `<${tag}${ordered && start !== 1 ? ` start="${start}"` : ''}>`;
  for (const item of items) {
    // the item's own lines, outdented by the item's indent so nested lists parse as lists
    const [head, ...rest] = item;
    const pad = Math.min(...rest.filter(l => l.trim()).map(l => width(l.match(/^\s*/)[0])), Infinity);
    const body = rest.map(l => l.replace(/\t/g, '    ').slice(Number.isFinite(pad) ? pad : 0));
    const inner = body.some(l => l.trim()) ? blocks([head, ...body]) : `<p>${inline(head)}</p>`;
    // the item's first paragraph sits in the <li> itself, so tight lists stay tight
    html += `<li>${inner.replace(/^<p>([\s\S]*?)<\/p>/, '$1')}</li>`;
  }
  return [html + `</${tag}>`, i];
}

export function markdown(src) {
  return blocks(String(src ?? '').replace(/\r\n?/g, '\n').split('\n'));
}
