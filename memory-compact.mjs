// Compact brain: shrink a brain's shared memory (brain/memory.jsonl) without losing what matters.
// Every search or read of memory puts its notes into the chat, so a bloated entry costs tokens in every chat
// that touches it. Compacting rewrites each oversized entry's notes into a few short, dated ones (current
// preferences, decisions, rules and facts, plus a short history), with Claude, and keeps everything else as is.
// A backup is taken first; Undo puts it back. An entry that changed while Claude worked on it is left alone.
import fs from 'node:fs';
import path from 'node:path';
import { askClaude } from './grades.mjs';

export const LIMITS = { notes: 12, chars: 6000 }; // an entry above either is worth compacting
const KEEP_BACKUPS = 5;
const TIMEOUT_MS = 5 * 60 * 1000;

const readGraph = file => {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  return text.split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
};
const entrySize = e => JSON.stringify(e).length;

// how big the brain is, and which entries are worth compacting
export function sizeOf(file) {
  const rows = readGraph(file), entities = rows.filter(r => r.type === 'entity');
  const large = entities.filter(e => e.observations.length > LIMITS.notes || entrySize(e) > LIMITS.chars)
    .map(e => ({ name: e.name, notes: e.observations.length, chars: entrySize(e) })).sort((a, b) => b.chars - a.chars);
  let chars = 0; try { chars = fs.statSync(file).size; } catch { /* no memory yet */ }
  return { chars, entries: entities.length, notes: entities.reduce((n, e) => n + e.observations.length, 0), large, suggest: large.length > 0 };
}

export function compactPrompt(e, max) {
  return `You keep a team's shared memory compact. Every note is read by AI agents in later chats, so every word costs.
Rewrite the notes of the memory entry below into at most ${max} short notes.

Keep: current preferences and rules, decisions, facts that are still true, open tasks, and a short history of real milestones (versions, dates, commit or build ids) written as plain history.
Drop: status that is no longer current, duplicates, anything a later note replaces, test logs, long file lists and step-by-step detail.
Each note is one fact, one or two sentences, starting with the date it is true from (YYYY-MM-DD, the newest date among the notes it merges). When two notes disagree, the newer one wins. Never invent anything. Never keep passwords, keys or tokens.

Reply with only a JSON array of strings, nothing else.

Entry: ${e.name} (${e.entityType})
Notes, oldest first:
${e.observations.map((o, i) => `${i + 1}. ${o}`).join('\n')}`;
}

export function parseNotes(text, original, max) {
  const m = String(text || '').match(/\[[\s\S]*\]/);
  if (!m) return null;
  let notes; try { notes = JSON.parse(m[0]); } catch { return null; }
  if (!Array.isArray(notes) || !notes.length || notes.length > max || !notes.every(n => typeof n === 'string' && n.trim())) return null;
  notes = notes.map(n => n.trim().replace(/\s+/g, ' '));
  // only a real shrink is accepted; anything else keeps the original notes
  return notes.join('').length < original.join('').length ? notes : null;
}

export function createCompactor({ dataDir, ask = prompt => askClaude(prompt, { model: 'sonnet', timeout: TIMEOUT_MS }) }) {
  const busy = new Set();
  const backups = brainId => path.join(dataDir, 'memory-backups', brainId.replace(/[^\w-]/g, '_'));
  const last = new Map(); // brainId -> the newest compaction's result (for Undo)

  async function compact(brain, file) {
    if (busy.has(brain.id)) return { error: 'Already compacting this brain.' };
    const before = sizeOf(file);
    if (!before.large.length) return { ok: true, nothing: true, before, after: before, entries: [] };
    busy.add(brain.id);
    try {
      const dir = backups(brain.id);
      fs.mkdirSync(dir, { recursive: true });
      const backup = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
      fs.copyFileSync(file, backup);
      for (const old of fs.readdirSync(dir).sort().slice(0, -KEEP_BACKUPS)) fs.rmSync(path.join(dir, old), { force: true });
      const snapshot = readGraph(file);
      const results = [];
      for (const big of before.large) {
        const e = snapshot.find(r => r.type === 'entity' && r.name === big.name);
        const max = Math.max(3, Math.min(LIMITS.notes, Math.ceil(e.observations.length / 4)));
        const notes = parseNotes(await ask(compactPrompt(e, max)), e.observations, max);
        results.push({ name: e.name, from: e.observations, notes, before: big });
      }
      // write once, into the memory as it is now: an entry someone changed meanwhile keeps its new notes
      const now = readGraph(file), entries = [];
      for (const r of results) {
        const cur = now.find(x => x.type === 'entity' && x.name === r.name);
        const unchanged = cur && JSON.stringify(cur.observations) === JSON.stringify(r.from);
        if (r.notes && unchanged) cur.observations = r.notes;
        entries.push({ name: r.name, before: r.before, after: cur ? { notes: cur.observations.length, chars: entrySize(cur) } : null,
          kept: !r.notes ? 'Claude did not return a shorter version' : !unchanged ? 'it changed while Claude worked' : null });
      }
      const pending = file + '.compact.tmp';
      fs.writeFileSync(pending, now.map(x => JSON.stringify(x)).join('\n') + '\n');
      fs.renameSync(pending, file);
      const result = { ok: true, before, after: sizeOf(file), entries, backup, at: Date.now() };
      last.set(brain.id, result);
      return result;
    } catch (err) { return { error: err.message }; }
    finally { busy.delete(brain.id); }
  }

  // put the newest backup back (the memory as it is now is backed up too, so Undo can itself be undone)
  function undo(brain, file) {
    const dir = backups(brain.id);
    let list = []; try { list = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).sort(); } catch { /* none */ }
    const newest = list.at(-1);
    if (!newest) return { error: 'There is no compaction to undo.' };
    const keep = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-before-undo.jsonl.bak`);
    fs.copyFileSync(file, keep);
    fs.copyFileSync(path.join(dir, newest), file + '.undo.tmp');
    fs.renameSync(file + '.undo.tmp', file);
    fs.rmSync(path.join(dir, newest), { force: true });
    last.delete(brain.id);
    return { ok: true, restored: newest, after: sizeOf(file) };
  }

  const canUndo = brain => { try { return fs.readdirSync(backups(brain.id)).some(f => f.endsWith('.jsonl')); } catch { return false; } };
  return { compact, undo, canUndo, busy: id => busy.has(id), last: id => last.get(id) || null };
}
