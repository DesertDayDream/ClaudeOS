// The Git tab: the open chat's repository like Claude Desktop shows it. Branch and changes (click a
// file for its diff), worktrees (open a terminal in one, or a chat), pull requests with their checks,
// and the CI runs of the current branch. git runs locally; pull requests and CI come from gh.
import { enableReview, reviewing } from '/review.js';
import { highlight, langOf } from '/markdown.js';
const TOKEN = window.CLAUDEOS_TOKEN;
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
async function api(p, body) {
  const res = await fetch(p, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', 'x-claudeos-token': TOKEN }, body: body === undefined ? undefined : JSON.stringify(body) });
  return res.json().catch(() => ({ error: `HTTP ${res.status}` }));
}
const el = document.getElementById('git');
const tabBtn = name => document.querySelector(`aside header [data-tab="${name}"]`);
const showing = () => tabBtn('git').getAttribute('aria-selected') === 'true';
let dir = localStorage.getItem('claudeos.gitDir') || ''; // '' = the open chat's folder
let data = null, gh = null, ghAt = 0, busy = '', openDiffs = new Map(); // file -> diff text (or null while loading)
const fold = JSON.parse(localStorage.getItem('claudeos.gitFold') || '{}'); // section -> collapsed

function ago(iso) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (!(s >= 0)) return '';
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}
const BR = '<svg class="gico" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M5 3.25a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Zm0 2.122a2.25 2.25 0 1 0-1.5 0v5.256a2.25 2.25 0 1 0 1.5 0V9.5h3.25A2.75 2.75 0 0 0 11 6.75v-.378a2.25 2.25 0 1 0-1.5 0v.378c0 .69-.56 1.25-1.25 1.25H5ZM4.25 12a.75.75 0 1 1 0 1.5.75.75 0 0 1 0-1.5Zm6-9.5a.75.75 0 1 1 0 1.5.75.75 0 0 1 0-1.5Z"/></svg>';
const STATE = { pass: '✓', fail: '✕', pending: '●', skip: '–' };
const runState = r => r.status !== 'completed' ? 'pending' : ['success', 'neutral', 'skipped'].includes(r.conclusion) ? (r.conclusion === 'skipped' ? 'skip' : 'pass') : 'fail';
function checksBadge(c) {
  if (!c) return '';
  const total = c.pass + c.fail + c.pending + c.skip;
  if (!total) return '<span class="gchk none" title="No checks">no checks</span>';
  const k = c.fail ? 'fail' : c.pending ? 'pending' : 'pass';
  return `<span class="gchk ${k}" title="${c.pass} passed, ${c.fail} failed, ${c.pending} running or waiting${c.skip ? `, ${c.skip} skipped` : ''}">${STATE[k]} ${c.fail ? `${c.fail} failing` : c.pending ? `${c.pending} running` : `${c.pass} passed`}</span>`;
}
const review = d => ({ APPROVED: '<span class="gtag ok">approved</span>', CHANGES_REQUESTED: '<span class="gtag bad">changes requested</span>', REVIEW_REQUIRED: '<span class="gtag">review required</span>' }[d] || '');
const XY = { M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied', U: 'conflict', T: 'type changed', '?': 'new' };
function changeKind(c) {
  if (c.conflict) return ['U', 'conflict'];
  if (c.xy === '??') return ['?', 'new, not tracked'];
  const x = c.xy[0], y = c.xy[1];
  const k = y !== '.' ? y : x;
  return [k === '?' ? 'N' : k, `${XY[k] || k}${x !== '.' && y === '.' ? ', staged' : x !== '.' && y !== '.' ? ', partly staged' : ''}`];
}
// a file's diff, coloured by its language, with line numbers (review comments use them)
function diffBody(text, file) {
  if (text == null) return '<div class="gap">Loading…</div>';
  if (!text.trim()) return '<div class="gap">No changes to show (binary, or only the mode changed).</div>';
  const lang = langOf(file);
  let oldLn = 0, newLn = 0;
  return text.split('\n').filter(l => !/^(diff --git|index |--- |\+\+\+ |new file mode|deleted file mode|similarity|rename (from|to)|\\ No newline)/.test(l)).map(l => {
    const h = l.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)/);
    if (h) { oldLn = Number(h[1]); newLn = Number(h[2]); return `<div class="gap">${esc(l)}</div>`; }
    const code = highlight(l.slice(1), lang);
    if (l.startsWith('+')) return `<div class="l a" data-ln="${newLn++}">${code}</div>`;
    if (l.startsWith('-')) return `<div class="l d" data-ln="${oldLn++}">${code}</div>`;
    oldLn++;
    return `<div class="l" data-ln="${newLn++}">${code}</div>`;
  }).join('');
}
const section = (key, title, count, body, extra = '') => `<div class="gsec${fold[key] ? ' folded' : ''}" data-sec="${key}">
  <div class="gsec-h"><button type="button" class="gfold" data-fold="${key}">${fold[key] ? '▸' : '▾'} ${title}${count != null ? ` <em>${count}</em>` : ''}</button>${extra}</div>
  <div class="gsec-b">${body}</div></div>`;

function draw() {
  if (!data) { el.innerHTML = '<div class="empty">Loading…</div>'; return; }
  const top = `<div class="ghead">
      <div class="grepo"><b title="${esc(data.root || data.dir)}">${esc(data.name || 'No repository')}</b><span title="${esc(data.root || data.dir)}">${esc(data.root || data.dir)}</span></div>
      <button type="button" class="btn mini" data-act="pick" title="Show another repository">Change</button>
      ${dir ? '<button type="button" class="btn mini" data-act="chatdir" title="Back to the open chat\'s folder">Chat\'s</button>' : ''}
      <button type="button" class="btn mini" data-act="refresh" title="Load everything again (git and GitHub)"${busy ? ' disabled' : ''}>${busy === 'refresh' ? '…' : '↻'}</button>
    </div>`;
  if (data.error) { el.innerHTML = top + `<div class="empty">${esc(data.error)}<br><br>The Git tab shows the repository of the open chat's folder (pick one with the folder button in the chat), or any repository you choose with Change.</div>`; return; }
  const sync = data.upstream ? `${data.ahead ? `↑${data.ahead} ` : ''}${data.behind ? `↓${data.behind} ` : ''}${!data.ahead && !data.behind ? 'up to date with ' : 'vs '}${esc(data.upstream)}` : 'not pushed yet';
  const branch = `<div class="gbranch">
      <span class="gbr" title="Current branch">${BR}${esc(data.branch || `detached at ${data.head}`)}</span><span class="gsync">${sync}</span>
      <button type="button" class="btn mini" data-act="fetch" title="git fetch --all --prune"${busy ? ' disabled' : ''}>${busy === 'fetch' ? 'Fetching…' : 'Fetch'}</button>
      <button type="button" class="btn mini" data-act="term" data-path="${esc(data.root)}" title="A terminal in this repository">Terminal</button>
    </div>${data.last ? `<div class="glast">${esc(data.last.hash)} · ${esc(data.last.subject)} · ${esc(data.last.when)}</div>` : ''}`;

  const changes = data.changes.length ? data.changes.slice(0, 300).map(c => {
    const [k, label] = changeKind(c);
    const open = openDiffs.has(c.file);
    return `<div class="gfile${open ? ' open' : ''}"><button type="button" data-diff="${esc(c.file)}" title="${esc(label)}${c.from ? ` (from ${esc(c.from)})` : ''} · click for the diff"><i class="k k${esc(k)}">${esc(k)}</i><span>${esc(c.file)}</span></button><a href="#" data-open="${esc(c.file)}" title="Open in your editor">Open</a></div>
      ${open ? `<div class="diff" data-file="${esc(c.file)}" title="Click a line to comment on it for Claude">${diffBody(openDiffs.get(c.file), c.file)}</div>` : ''}`;
  }).join('') + (data.changes.length > 300 ? `<div class="gmore">… and ${data.changes.length - 300} more</div>` : '') : '<div class="gnone">No changes. The working tree is clean.</div>';

  const wts = data.worktrees.map(w => `<div class="gwt${path(w.path) === path(data.root) ? ' here' : ''}">
      <div class="gwt-t"><b>${BR}${esc(w.branch || (w.detached ? `detached ${w.head}` : w.head || ''))}</b>${w.main ? '<span class="gtag">main</span>' : ''}${w.locked ? '<span class="gtag">locked</span>' : ''}${w.prunable ? '<span class="gtag bad" title="Its folder is gone">missing</span>' : ''}</div>
      <div class="gwt-p" title="${esc(w.path)}">${esc(w.path)}</div>
      <div class="gacts"><button type="button" class="btn mini" data-act="term" data-path="${esc(w.path)}">Terminal</button>
        <button type="button" class="btn mini" data-act="chatfolder" data-path="${esc(w.path)}" title="Make this the folder of the open chat (before its first message), so Claude works in this worktree">Use for chat</button>
        <button type="button" class="btn mini" data-act="show" data-path="${esc(w.path)}" title="Show this worktree's changes here">Show</button>
        ${w.main ? '' : `<button type="button" class="btn mini danger" data-act="wtrm" data-path="${esc(w.path)}" title="git worktree remove (the branch stays)">Remove</button>`}</div>
    </div>`).join('') + `<form class="gnew" data-form="wt"><input name="branch" placeholder="New worktree: branch name, e.g. fix/login" autocomplete="off" spellcheck="false"><button class="btn mini" type="submit"${busy ? ' disabled' : ''}>${busy === 'wt' ? 'Creating…' : 'Create'}</button></form>`;

  let prs, ci;
  if (!gh) prs = ci = '<div class="gnone">Loading from GitHub…</div>';
  else if (gh.error) prs = ci = `<div class="gnone">${esc(gh.error)}${gh.signIn ? ' <button type="button" class="btn mini primary" data-act="ghlogin">Sign in to GitHub</button>' : ''}</div>`;
  else {
    const cur = gh.current;
    const curHtml = cur ? `<div class="gpr cur"><div class="gpr-t"><a href="${esc(cur.url)}" target="_blank" rel="noopener">#${cur.number} ${esc(cur.title)}</a></div>
        <div class="gpr-m">${cur.isDraft ? '<span class="gtag">draft</span>' : ''}${cur.state !== 'OPEN' ? `<span class="gtag">${esc(cur.state.toLowerCase())}</span>` : ''}${review(cur.reviewDecision)}${checksBadge(cur.checks)}<span>+${cur.additions} −${cur.deletions}</span></div>
        ${cur.checkList?.length ? `<div class="gchecks">${cur.checkList.map(c => `<div class="gck ${c.state}"><i>${STATE[c.state]}</i>${c.url ? `<a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.name)}</a>` : esc(c.name)}${c.workflow ? `<span>${esc(c.workflow)}</span>` : ''}</div>`).join('')}</div>` : ''}</div>`
      : data.branch && !data.worktrees.find(w => w.main && w.branch === data.branch && /^(main|master|trunk|develop)$/.test(data.branch)) ? `<div class="gnone">No pull request for ${esc(data.branch)} yet. <button type="button" class="btn mini" data-act="prcreate"${busy ? ' disabled' : ''}>${busy === 'pr' ? 'Creating…' : 'Push and open a draft PR'}</button></div>` : '';
    const others = gh.prs.filter(p => p.number !== cur?.number);
    prs = curHtml + (others.length ? others.map(p => `<div class="gpr"><div class="gpr-t"><a href="${esc(p.url)}" target="_blank" rel="noopener">#${p.number} ${esc(p.title)}</a></div>
        <div class="gpr-m"><span>${esc(p.headRefName)} → ${esc(p.baseRefName)}</span><span>${esc(p.author)}</span>${p.isDraft ? '<span class="gtag">draft</span>' : ''}${review(p.reviewDecision)}${checksBadge(p.checks)}<span>${ago(p.updatedAt)}</span>
        <button type="button" class="btn mini" data-act="prwt" data-n="${p.number}" title="Check this pull request out in a worktree of its own; your checkout stays as it is">Worktree</button></div></div>`).join('')
      : `<div class="gnone">No ${cur ? 'other ' : ''}open pull requests.</div>`);
    ci = gh.runs.length ? gh.runs.map(r => { const s = runState(r); return `<div class="grun ${s}"><i>${STATE[s]}</i><div><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.workflowName)}</a><span>${esc(r.displayTitle)} · ${esc(r.event)} · ${ago(r.createdAt)}${r.status !== 'completed' ? ` · ${esc(r.status.replace('_', ' '))}` : ''}</span></div>
        ${s === 'fail' ? `<button type="button" class="btn mini" data-act="log" data-id="${r.databaseId}" title="Show the failed steps' logs in a terminal">Log</button><button type="button" class="btn mini" data-act="rerun" data-id="${r.databaseId}" title="Run the failed jobs again">Re-run</button>` : ''}</div>`; }).join('')
      : `<div class="gnone">${esc(gh.runsError || `No workflow runs for ${data.branch || 'this commit'}.`)}</div>`;
  }
  el.innerHTML = top + branch
    + section('changes', 'Changes', data.changes.length, changes)
    + section('worktrees', 'Worktrees', data.worktrees.length, wts)
    + (gh?.error ? section('prs', 'Pull requests and CI', null, prs)
      : section('prs', 'Pull requests', gh ? gh.prs.length : null, prs) + section('ci', `CI${data.branch ? ` · ${esc(data.branch)}` : ''}`, null, ci));
}
const path = p => String(p || '').replace(/[\\/]+$/, '').toLowerCase();

let loadNo = 0;
async function load({ github = false, fresh = false } = {}) {
  const no = ++loadNo;
  const q = new URLSearchParams({ dir, ...(github ? { gh: '1' } : {}), ...(fresh ? { fresh: '1' } : {}) });
  const r = await api(`/api/git?${q}`);
  if (no !== loadNo) return;
  if (data?.root !== r.root) { openDiffs = new Map(); if (!github) { gh = null; ghAt = 0; } }
  data = r;
  if (github) { gh = r.github || null; ghAt = Date.now(); }
  // diffs that are open stay current
  for (const f of openDiffs.keys()) if (!r.changes?.some(c => c.file === f)) openDiffs.delete(f);
  draw();
  if (!github && !r.error && !gh) load({ github: true });
}
async function refreshDiffs() {
  await Promise.all([...openDiffs.keys()].map(async f => { const d = await api(`/api/git/diff?${new URLSearchParams({ dir, file: f })}`); openDiffs.set(f, d.error || d.text); }));
}
async function act(name, body, label) {
  busy = label || name; draw();
  const r = await api(`/api/git/${name}`, { dir, ...body });
  busy = '';
  if (r.error) alert(r.error);
  await load({ github: true, fresh: true });
  return r;
}
async function openTerminal(cwd) {
  const r = await api('/api/terminal/open', { cwd });
  if (r.error) return alert(r.error);
  tabBtn('term').click();
}

el.addEventListener('click', async e => {
  const f = e.target.closest('[data-fold]')?.dataset.fold;
  if (f) { fold[f] = !fold[f]; localStorage.setItem('claudeos.gitFold', JSON.stringify(fold)); return draw(); }
  const file = e.target.closest('[data-diff]')?.dataset.diff;
  if (file) {
    if (openDiffs.has(file)) { openDiffs.delete(file); return draw(); }
    openDiffs.set(file, null); draw();
    const d = await api(`/api/git/diff?${new URLSearchParams({ dir, file })}`);
    if (openDiffs.has(file)) { openDiffs.set(file, d.error || d.text); draw(); }
    return;
  }
  const open = e.target.closest('[data-open]')?.dataset.open;
  if (open) { e.preventDefault(); const r = await api('/api/open-file', { path: `${data.root}/${open}` }); if (r.error) alert(r.error); return; }
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const a = b.dataset.act, p = b.dataset.path;
  // the sign-in runs in the Apps panel, which shows GitHub's one-time code
  if (a === 'ghlogin') { document.dispatchEvent(new CustomEvent('claudeos:open-apps')); const r = await api('/api/integrations/account', { key: 'github', act: 'login' }); if (r.error) alert(r.error); return; }
  if (a === 'refresh') { busy = 'refresh'; draw(); await refreshDiffs(); busy = ''; return load({ github: true, fresh: true }); }
  if (a === 'pick') {
    let recent = [];
    try { recent = JSON.parse(localStorage.getItem('claudeos.gitRepos') || '[]'); } catch { /* none */ }
    const pick = prompt(`Repository folder (full path). Leave empty for the open chat's folder.${recent.length ? `\n\nRecent:\n${recent.join('\n')}` : ''}`, dir || data?.root || '');
    if (pick == null) return;
    return setDir(pick.trim().replace(/^"|"$/g, ''));
  }
  if (a === 'chatdir') return setDir('');
  if (a === 'show') return setDir(p);
  if (a === 'term') return openTerminal(p);
  if (a === 'chatfolder') {
    const r = await api('/api/chat/folder', { folder: p });
    if (r.error) return alert(r.error);
    tabBtn('chat').click();
    return;
  }
  if (a === 'fetch') return act('fetch', {});
  if (a === 'wtrm') {
    if (!confirm(`Remove the worktree at\n${p}?\n\nIts folder is deleted; the branch stays.`)) return;
    busy = 'wtrm'; draw();
    let r = await api('/api/git/worktree-remove', { dir, path: p });
    if (r.dirty && confirm('It has changes that aren\'t committed. Remove it anyway and lose them?')) r = await api('/api/git/worktree-remove', { dir, path: p, force: true });
    busy = '';
    if (r.error && !r.dirty) alert(r.error);
    return load({ github: !!gh });
  }
  if (a === 'prwt') { const r = await act('pr-worktree', { number: Number(b.dataset.n) }, 'prwt'); if (r.ok && confirm(`Pull request #${b.dataset.n} is checked out in\n${r.path}\n\nOpen a terminal there?`)) openTerminal(r.path); return; }
  if (a === 'prcreate') {
    if (!confirm(`Push ${data.branch} to origin and open a draft pull request, titled and described from its commits?`)) return;
    const r = await act('pr-create', {}, 'pr');
    if (r.url) window.open(r.url, '_blank', 'noopener');
    return;
  }
  if (a === 'rerun') return act('rerun', { id: b.dataset.id });
  if (a === 'log') {
    const r = await api('/api/terminal/run', { command: `gh run view ${Number(b.dataset.id)} --log-failed`, cwd: data.root });
    if (r.error) return alert(r.error);
    tabBtn('term').click();
  }
});
el.addEventListener('submit', async e => {
  e.preventDefault();
  const branch = e.target.branch?.value.trim();
  if (!branch) return;
  const r = await act('worktree-add', { branch }, 'wt');
  if (r.ok && confirm(`Worktree for ${r.branch} created at\n${r.path}\n\nOpen a terminal there?`)) openTerminal(r.path);
});
function setDir(d) {
  dir = d;
  if (d) {
    localStorage.setItem('claudeos.gitDir', d);
    let recent = [];
    try { recent = JSON.parse(localStorage.getItem('claudeos.gitRepos') || '[]'); } catch { /* none */ }
    localStorage.setItem('claudeos.gitRepos', JSON.stringify([d, ...recent.filter(x => x !== d)].slice(0, 8)));
  } else localStorage.removeItem('claudeos.gitDir');
  data = null; gh = null; openDiffs = new Map(); draw();
  load({ github: true });
}

// fresh when the tab opens; while it's open, local status every 10 s and GitHub every minute
tabBtn('git').addEventListener('click', () => load({ github: !gh || Date.now() - ghAt > 30000 }));
setInterval(async () => {
  if (!showing() || busy || document.hidden || reviewing(el)) return;
  if (openDiffs.size) await refreshDiffs();
  load({ github: Date.now() - ghAt > 60000 });
}, 10000);
enableReview(el);
draw();
