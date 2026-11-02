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
      html += `<div class="code">${lang ? `<span class="lang">${esc(lang)}</span>` : ''}${pv}<button type="button" class="copy" title="Copy">Copy</button><pre><code>${highlight(body.join('\n'), lang)}</code></pre></div>`;
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

// ---------- syntax highlighting ----------
// One regex per language family; the first alternative that matches at a spot wins, so comments and
// strings come before keywords. Patterns use only non-capturing groups (the match index says which).
const kw = words => new RegExp(`\\b(?:${words.split(' ').join('|')})\\b`);
const C_COMMENT = /\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/, HASH_COMMENT = /#[^\n]*/;
const DQ = /"(?:[^"\\\n]|\\.)*"?/, SQ = /'(?:[^'\\\n]|\\.)*'?/, BQ = /`(?:[^`\\]|\\.)*`?/;
const NUM = /\b(?:0x[\da-fA-F_]+|\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?)[a-zA-Z]*\b/;
const FN = /\b[A-Za-z_$][\w$]*(?=\s*\()/, TYPE = /\b[A-Z][A-Za-z0-9_]*\b/;
const JS_KW = 'async await break case catch class const continue debugger default delete do else export extends finally for from function if import in instanceof let new of return static super switch this throw try typeof var void while with yield interface type enum implements private public protected readonly as declare namespace abstract';
const SPECS = {
  js: [['com', C_COMMENT], ['str', BQ], ['str', DQ], ['str', SQ], ['kw', kw(JS_KW)], ['lit', kw('true false null undefined NaN Infinity')], ['num', NUM], ['fn', FN], ['type', TYPE]],
  c: [['com', C_COMMENT], ['meta', /^[ \t]*#[ \t]*\w+[^\n]*/], ['str', DQ], ['str', SQ], ['kw', kw('auto break case catch char class const continue default delete do double else enum explicit extern float for friend goto if inline int long namespace new operator private protected public register return short signed sizeof static struct switch template this throw try typedef typename union unsigned using virtual void volatile while bool override final nullptr constexpr noexcept fn let mut impl pub use mod match loop trait where crate self func package import go chan defer select var interface map range type fallthrough val fun when object internal is as in out ref string base foreach lock readonly sealed async await')],
    ['lit', kw('true false null nil NULL None')], ['num', NUM], ['fn', FN], ['type', TYPE]],
  py: [['com', HASH_COMMENT], ['str', /[rbfRBF]{0,2}(?:"""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$))/], ['str', DQ], ['str', SQ], ['meta', /@[\w.]+/],
    ['kw', kw('and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case')],
    ['lit', kw('True False None self cls')], ['num', NUM], ['fn', FN], ['type', TYPE]],
  sh: [['com', HASH_COMMENT], ['str', DQ], ['str', SQ], ['var', /\$\{[^}]*\}|\$[\w@#?*!-]+/],
    ['kw', kw('if then else elif fi for while until do done case esac in function return local export source alias set unset echo exit cd param begin process end foreach switch try catch finally throw')],
    ['meta', /(?:^|(?<=\s))-{1,2}[A-Za-z][\w-]*/], ['num', NUM]],
  verse: [['com', /<#[\s\S]*?(?:#>|$)|#[^\n]*/], ['str', DQ], ['meta', /<\w+>|@\w+/],
    ['kw', kw('using module class struct interface enum var set if else then for loop break return block spawn sync race rush branch defer case where of and or not array map option tuple subtype type logic int float string char void any comparable external override final abstract concrete unique castable persistable public private protected internal epic_internal suspends decides transacts computes varies converges reads writes allocates localizes native native_callable')],
    ['lit', kw('true false Self')], ['num', NUM], ['fn', /\b[A-Za-z_]\w*(?=(?:<\w+>)*\s*[(\[])/], ['type', /\b[a-z_]\w*_(?:device|component)\b|\b[A-Z]\w*\b/]],
  json: [['key', /"(?:[^"\\\n]|\\.)*"(?=\s*:)/], ['str', DQ], ['lit', kw('true false null')], ['num', /-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/]],
  html: [['com', /<!--[\s\S]*?(?:-->|$)/], ['tag', /<\/?[\w:-]+|\/?>/], ['attr', /\b[\w:-]+(?==)/], ['str', DQ], ['str', SQ]],
  css: [['com', /\/\*[\s\S]*?(?:\*\/|$)/], ['str', DQ], ['str', SQ], ['meta', /@[\w-]+/], ['key', /[\w-]+(?=\s*:[^;{}\n]*[;}\n])/], ['tag', /[.#]?[\w-]+(?=[^{};]*\{)/], ['num', /#[\da-fA-F]{3,8}\b|-?\b\d+(?:\.\d+)?(?:px|em|rem|%|vh|vw|s|ms|deg|fr)?\b/]],
  sql: [['com', /--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/], ['str', SQ], ['str', DQ],
    ['kw', /\b(?:select|from|where|and|or|not|insert|into|values|update|set|delete|create|table|drop|alter|add|index|join|left|right|inner|outer|on|group|by|order|having|limit|offset|as|distinct|union|all|primary|key|foreign|references|null|is|in|like|between|case|when|then|else|end|with|returning|default|exists)\b/i], ['num', NUM], ['fn', FN]],
  yaml: [['com', HASH_COMMENT], ['key', /^[ \t-]*[\w.-]+(?=[ \t]*[:=])/m], ['str', DQ], ['str', SQ], ['lit', kw('true false null yes no on off')], ['num', NUM]],
  diff: [['meta', /^(?:@@[^\n]*|diff [^\n]*|index [^\n]*|--- [^\n]*|\+\+\+ [^\n]*)/m], ['add', /^\+[^\n]*/m], ['del', /^-[^\n]*/m]],
};
const ALIAS = { js: 'js', javascript: 'js', jsx: 'js', ts: 'js', tsx: 'js', typescript: 'js', mjs: 'js', cjs: 'js', node: 'js',
  c: 'c', cpp: 'c', 'c++': 'c', h: 'c', hpp: 'c', cs: 'c', csharp: 'c', java: 'c', go: 'c', golang: 'c', rust: 'c', rs: 'c', swift: 'c', kotlin: 'c', kt: 'c', php: 'c', dart: 'c', scala: 'c', hlsl: 'c', glsl: 'c',
  python: 'py', py: 'py', python3: 'py', ruby: 'py', rb: 'py',
  bash: 'sh', shell: 'sh', zsh: 'sh', sh: 'sh', console: 'sh', powershell: 'sh', ps1: 'sh', pwsh: 'sh', bat: 'sh', cmd: 'sh', dockerfile: 'sh',
  verse: 'verse', json: 'json', jsonc: 'json', json5: 'json', html: 'html', xml: 'html', svg: 'html', vue: 'html', css: 'css', scss: 'css', less: 'css',
  sql: 'sql', yaml: 'yaml', yml: 'yaml', toml: 'yaml', ini: 'yaml', diff: 'diff', patch: 'diff' };
const compiled = new Map();
export function highlight(code, lang) {
  const key = ALIAS[String(lang || '').toLowerCase()];
  if (!key || code.length > 200000) return esc(code);
  if (!compiled.has(key)) {
    const spec = SPECS[key];
    compiled.set(key, { spec, re: new RegExp(spec.map(([, r]) => `(${r.source})`).join('|'), 'gm' + (spec.some(([, r]) => r.flags.includes('i')) ? 'i' : '')) });
  }
  const { spec, re } = compiled.get(key);
  let out = '', last = 0;
  for (const m of code.matchAll(re)) {
    if (!m[0]) continue;
    const k = m.findIndex((g, n) => n > 0 && g !== undefined) - 1;
    out += esc(code.slice(last, m.index)) + `<span class="t-${spec[k][0]}">${esc(m[0])}</span>`;
    last = m.index + m[0].length;
  }
  return out + esc(code.slice(last));
}
// the file's language from its name, for diffs and previews
export const langOf = file => { const ext = String(file || '').split('.').pop().toLowerCase(); return ALIAS[ext] ? ext : ''; };

export function markdown(src) {
  return blocks(String(src ?? '').replace(/\r\n?/g, '\n').split('\n'));
}
