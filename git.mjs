// The Git tab: the repository the open chat works in, as Claude Desktop shows it. Branch and
// changes, worktrees (a second checkout per branch, so Claude can work on one while you're on
// another), pull requests and CI status. Local facts come from git; pull requests and Actions runs
// from GitHub's gh CLI (signed in once with `gh auth login`). Every command runs without a shell,
// with fixed arguments.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const run = (cmd, args, cwd, timeout = 20000) => new Promise(resolve => {
  execFile(cmd, args, { cwd, timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1', NO_COLOR: '1' } },
    (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || ''), err: String(stderr || err?.message || '').trim(), missing: err?.code === 'ENOENT' }));
});
const git = (args, cwd, t) => run('git', args, cwd, t);
const gh = (args, cwd, t) => run('gh', args, cwd, t);
const firstLine = s => String(s || '').split('\n').find(l => l.trim()) || '';

export function createGit() {
  const ghCache = new Map(); // root|branch -> { at, value }

  // the top of the repository a folder is in, or null
  async function rootOf(dir) {
    try { if (!fs.statSync(dir).isDirectory()) return null; } catch { return null; }
    const r = await git(['rev-parse', '--show-toplevel'], dir);
    return r.ok ? path.resolve(r.out.trim()) : null;
  }

  // branch, upstream, ahead/behind and changed files, from one porcelain v2 status
  async function status(root) {
    const r = await git(['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'], root);
    if (!r.ok) return { error: firstLine(r.err) };
    const s = { branch: '', head: '', upstream: '', ahead: 0, behind: 0, changes: [] };
    const parts = r.out.split('\0');
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (!p) continue;
      if (p.startsWith('# branch.head ')) s.branch = p.slice(14) === '(detached)' ? '' : p.slice(14);
      else if (p.startsWith('# branch.oid ')) s.head = p.slice(13, 20);
      else if (p.startsWith('# branch.upstream ')) s.upstream = p.slice(18);
      else if (p.startsWith('# branch.ab ')) { const [, a, b] = p.match(/\+(\d+) -(\d+)/) || []; s.ahead = +a || 0; s.behind = +b || 0; }
      else if (p[0] === '1' || p[0] === 'u') { const f = p.split(' '); s.changes.push({ xy: f[1], file: f.slice(p[0] === '1' ? 8 : 10).join(' '), conflict: p[0] === 'u' }); }
      else if (p[0] === '2') { const f = p.split(' '); s.changes.push({ xy: f[1], file: f.slice(9).join(' '), from: parts[++i] }); }
      else if (p[0] === '?') s.changes.push({ xy: '??', file: p.slice(2) });
    }
    return s;
  }

  async function worktrees(root) {
    const r = await git(['worktree', 'list', '--porcelain'], root);
    if (!r.ok) return [];
    return r.out.split(/\n\n+/).filter(Boolean).map(block => {
      const w = {};
      for (const line of block.split('\n')) {
        const [k, ...v] = line.split(' ');
        if (k === 'worktree') w.path = path.resolve(v.join(' '));
        else if (k === 'HEAD') w.head = v[0]?.slice(0, 7);
        else if (k === 'branch') w.branch = v.join(' ').replace(/^refs\/heads\//, '');
        else if (k === 'detached') w.detached = true;
        else if (k === 'bare') w.bare = true;
        else if (k === 'locked') w.locked = v.join(' ') || true;
        else if (k === 'prunable') w.prunable = v.join(' ') || true;
      }
      w.main = path.resolve(w.path || '') === root;
      return w;
    }).filter(w => w.path);
  }

  // pull requests and CI runs from GitHub (cached half a minute; Refresh skips the cache)
  async function github(root, branch, fresh, remote) {
    if (!remote) return { error: 'This repository has no remote named origin yet, so there are no pull requests or CI runs to show.' };
    if (!/github/i.test(remote)) return { error: `origin is ${remote}, not GitHub, so pull requests and CI aren't shown here.` };
    const key = `${root}|${branch}`;
    const hit = ghCache.get(key);
    if (hit && !fresh && Date.now() - hit.at < 30000) return hit.value;
    const prFields = 'number,title,headRefName,baseRefName,author,isDraft,state,reviewDecision,statusCheckRollup,url,updatedAt,additions,deletions';
    const [list, mine, runs] = await Promise.all([
      gh(['pr', 'list', '--limit', '20', '--json', prFields], root),
      branch ? gh(['pr', 'view', branch, '--json', prFields], root) : Promise.resolve({ ok: false, err: '' }),
      gh(['run', 'list', '--limit', '10', ...(branch ? ['--branch', branch] : []), '--json', 'databaseId,displayTitle,status,conclusion,workflowName,event,headBranch,url,createdAt'], root),
    ]);
    let value;
    if (list.missing) value = { error: 'GitHub CLI (gh) is not installed. Get it from cli.github.com to see pull requests and CI here.' };
    else if (!list.ok) {
      const e = list.err;
      value = /auth login|not logged|authentication/i.test(e) ? { error: 'Sign in to GitHub once to see pull requests and CI here.', signIn: true } : { error: /no git remotes|none of the git remotes|not a github/i.test(e) ? 'This repository has no GitHub remote, so there are no pull requests or CI runs to show.'
        : firstLine(e) };
    } else {
      const parse = s => { try { return JSON.parse(s); } catch { return null; } };
      const pr = p => p && ({ ...p, author: p.author?.login || '', checks: checks(p.statusCheckRollup), statusCheckRollup: undefined });
      value = {
        prs: (parse(list.out) || []).map(pr),
        current: mine.ok ? pr(parse(mine.out)) : null,
        runs: runs.ok ? (parse(runs.out) || []) : [],
        runsError: runs.ok ? '' : firstLine(runs.err),
      };
      // the current branch's PR: its checks one by one
      if (value.current) value.current.checkList = (parse(mine.out)?.statusCheckRollup || []).map(c => ({ name: c.name || c.context || '', state: checkState(c), url: c.detailsUrl || c.targetUrl || '', workflow: c.workflowName || '' }));
    }
    ghCache.set(key, { at: Date.now(), value });
    return value;
  }
  // one check (an Actions job or a commit status): pass, fail, pending or skip
  function checkState(c) {
    const v = String(c.conclusion || c.state || c.status || '').toUpperCase();
    if (['SUCCESS', 'NEUTRAL'].includes(v)) return 'pass';
    if (['SKIPPED', 'STALE'].includes(v)) return 'skip';
    if (['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(v)) return 'fail';
    return 'pending';
  }
  function checks(rollup) {
    const n = { pass: 0, fail: 0, pending: 0, skip: 0 };
    for (const c of rollup || []) n[checkState(c)]++;
    return n;
  }

  // everything the tab shows for a folder; gh only when asked (it's slower, and online)
  async function view({ dir, withGithub, fresh }) {
    const root = await rootOf(dir);
    if (!root) {
      const probe = await git(['--version'], undefined);
      return { dir, error: probe.missing ? 'Git is not installed. Get it from git-scm.com.' : 'This folder is not in a git repository.' };
    }
    const [s, wts, remote, last] = await Promise.all([
      status(root), worktrees(root),
      git(['remote', 'get-url', 'origin'], root),
      git(['log', '-1', '--format=%h%x00%s%x00%cr'], root),
    ]);
    if (s.error) return { dir, root, error: s.error };
    const [h, subject, when] = last.out.trim().split('\0');
    const out = { dir, root, name: path.basename(root), ...s, worktrees: wts, remote: remote.ok ? remote.out.trim() : '', last: h ? { hash: h, subject, when } : null };
    if (withGithub) out.github = await github(root, s.branch, fresh, out.remote);
    return out;
  }

  // a file's changes: staged and unstaged against HEAD, or the whole file when it's new
  async function diff({ dir, file }) {
    const root = await rootOf(dir);
    if (!root) return { error: 'Not a git repository.' };
    const abs = path.resolve(root, file);
    if (!abs.startsWith(root + path.sep)) return { error: 'That file is outside the repository.' };
    let r = await git(['diff', '--no-color', '--no-ext-diff', 'HEAD', '--', file], root);
    if (r.ok && !r.out.trim()) r = await git(['diff', '--no-color', '--no-ext-diff', '--no-index', '--', process.platform === 'win32' ? 'NUL' : '/dev/null', file], root);
    const text = r.out || (r.ok ? '' : r.err);
    return { ok: true, text: text.length > 400000 ? `${text.slice(0, 400000)}\n… (cut: the diff is very long)` : text };
  }

  // A new worktree: a sibling folder "<repo>.worktrees/<branch>", on a new branch from the current
  // one (or on an existing branch), so its files don't land inside the repository.
  async function addWorktree({ dir, branch, base }) {
    const root = await rootOf(dir);
    if (!root) return { error: 'Not a git repository.' };
    branch = String(branch || '').trim();
    const ok = await git(['check-ref-format', '--branch', branch], root);
    if (!branch || !ok.ok || branch.startsWith('-')) return { error: `“${branch}” isn't a valid branch name.` };
    const main = (await worktrees(root)).find(w => w.main)?.path || root;
    const target = path.join(path.dirname(main), `${path.basename(main)}.worktrees`, branch.replace(/[\\/:*?"<>|]+/g, '-'));
    if (fs.existsSync(target)) return { error: `${target} already exists.` };
    const exists = (await git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], root)).ok;
    const args = exists ? ['worktree', 'add', target, branch] : ['worktree', 'add', '-b', branch, target, ...(base ? [String(base)] : [])];
    if (base && String(base).startsWith('-')) return { error: 'Bad base.' };
    const r = await git(args, root, 120000);
    return r.ok ? { ok: true, path: target, branch } : { error: firstLine(r.err) || 'git worktree add failed.' };
  }
  async function removeWorktree({ dir, path: wt, force }) {
    const root = await rootOf(dir);
    if (!root) return { error: 'Not a git repository.' };
    const w = (await worktrees(root)).find(x => x.path === path.resolve(String(wt || '')));
    if (!w) return { error: 'No such worktree.' };
    if (w.main) return { error: "That's the main checkout; it can't be removed." };
    const r = await git(['worktree', 'remove', ...(force ? ['--force'] : []), w.path], root, 60000);
    if (!r.ok) return { error: firstLine(r.err), dirty: /modified or untracked|contains modified/i.test(r.err) };
    // the "<repo>.worktrees" folder goes too once its last worktree has
    const parent = path.dirname(w.path);
    if (parent.endsWith('.worktrees')) try { fs.rmdirSync(parent); } catch { /* others are still in it */ }
    return { ok: true };
  }
  // a pull request checked out in a worktree of its own (your checkout stays as it is)
  async function prWorktree({ dir, number }) {
    const root = await rootOf(dir);
    if (!root) return { error: 'Not a git repository.' };
    number = Number(number);
    if (!Number.isInteger(number) || number <= 0) return { error: 'Bad pull request number.' };
    const info = await gh(['pr', 'view', String(number), '--json', 'headRefName'], root);
    if (!info.ok) return { error: firstLine(info.err) };
    const head = JSON.parse(info.out).headRefName;
    const local = `pr-${number}-${head}`.replace(/[^\w.\-/]+/g, '-').slice(0, 80);
    const f = await git(['fetch', 'origin', `pull/${number}/head:${local}`], root, 120000);
    if (!f.ok && !/non-fast-forward|rejected/.test(f.err)) return { error: firstLine(f.err) };
    return addWorktree({ dir: root, branch: local });
  }
  async function fetchAll({ dir }) {
    const root = await rootOf(dir);
    if (!root) return { error: 'Not a git repository.' };
    const r = await git(['fetch', '--all', '--prune'], root, 120000);
    ghCache.clear();
    return r.ok ? { ok: true } : { error: firstLine(r.err) };
  }
  async function rerun({ dir, id }) {
    const root = await rootOf(dir);
    if (!root) return { error: 'Not a git repository.' };
    if (!/^\d+$/.test(String(id))) return { error: 'Bad run id.' };
    const r = await gh(['run', 'rerun', String(id), '--failed'], root, 60000);
    ghCache.clear();
    return r.ok ? { ok: true } : { error: firstLine(r.err) };
  }
  // the current branch pushed and opened as a draft pull request, titled from its commits
  async function createPr({ dir }) {
    const root = await rootOf(dir);
    if (!root) return { error: 'Not a git repository.' };
    const s = await status(root);
    if (!s.branch) return { error: 'Check out a branch first (HEAD is detached).' };
    const p = await git(['push', '-u', 'origin', 'HEAD'], root, 120000);
    if (!p.ok) return { error: firstLine(p.err) };
    const r = await gh(['pr', 'create', '--fill', '--draft'], root, 60000);
    ghCache.clear();
    return r.ok ? { ok: true, url: firstLine(r.out) } : { error: firstLine(r.err) };
  }

  return { view, diff, addWorktree, removeWorktree, prWorktree, fetchAll, rerun, createPr };
}
