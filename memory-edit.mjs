// Memory inspector: read, edit and delete one memory dot.
// Two kinds of memory: a Claude memory is one .md file in ~/.claude/projects/<slug>/memory (listed in
// that folder's MEMORY.md); a shared-brain memory is one observation of an entity in brain/memory.jsonl.
// Nothing is thrown away: a deleted memory goes to <data>/trash.jsonl so it can be put back.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function observationId(entity, obs) {
  let h = 0;
  for (let i = 0; i < obs.length; i++) h = (Math.imul(h, 31) + obs.charCodeAt(i)) | 0;
  return `brain/${entity}/${(h >>> 0).toString(36)}`;
}

// Rewrites only the line of the entity that changed; every other line stays byte for byte.
function editEntity(file, name, change) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  let found = false;
  const out = [];
  for (const line of lines) {
    let e = null;
    try { e = line.trim() ? JSON.parse(line) : null; } catch { /* keep as is */ }
    if (!found && e?.type === 'entity' && e.name === name) {
      found = true;
      const next = change(e);
      if (next) out.push(JSON.stringify(next));
      continue;
    }
    out.push(line);
  }
  if (!found) {
    const next = change(null);
    if (next) { while (out.length && out[out.length - 1] === '') out.pop(); out.push(JSON.stringify(next), ''); }
  }
  fs.writeFileSync(file, out.join('\n'));
}

export function createMemoryEditor({ claudeDir, dataDir, memoryFileOf }) {
  const TRASH = path.join(dataDir, 'trash.jsonl');
  const fileOf = m => path.join(claudeDir, 'projects', m.project, 'memory', m.id.slice(m.project.length + 1));
  const indexOf = m => path.join(claudeDir, 'projects', m.project, 'memory', 'MEMORY.md');

  function read(brain, m) {
    if (m.type === 'brain') return { kind: 'brain', entity: m.name, file: memoryFileOf(brain), text: m.description };
    const file = fileOf(m);
    return { kind: 'claude', file, text: fs.readFileSync(file, 'utf8') };
  }

  function save(brain, m, text) {
    text = String(text ?? '');
    if (!text.trim()) return { error: 'A memory can’t be empty. Delete it instead.' };
    if (m.type === 'brain') {
      const obs = text.trim().replace(/\s*\n\s*/g, ' ');
      let missing = false;
      editEntity(memoryFileOf(brain), m.name, e => {
        const i = e ? e.observations.indexOf(m.description) : -1;
        if (i < 0) { missing = true; return e; }
        e.observations[i] = obs;
        return e;
      });
      if (missing) return { error: 'That memory changed while you were editing it. Close it and open it again.' };
      return { ok: true, id: observationId(m.name, obs) };
    }
    fs.writeFileSync(fileOf(m), text);
    return { ok: true, id: m.id };
  }

  function remove(brain, m) {
    const entry = { trashId: crypto.randomUUID(), at: Date.now(), id: m.id, name: m.name, project: m.project };
    if (m.type === 'brain') {
      Object.assign(entry, { kind: 'brain', file: memoryFileOf(brain), text: m.description });
      editEntity(entry.file, m.name, e => {
        if (!e) return null;
        const i = e.observations.indexOf(m.description);
        if (i >= 0) { e.observations.splice(i, 1); entry.entityType = e.entityType; entry.index = i; }
        return e; // an entity with no observations left stays, so its relations still make sense
      });
    } else {
      const file = fileOf(m), index = indexOf(m);
      Object.assign(entry, { kind: 'claude', file, text: fs.readFileSync(file, 'utf8'), indexLines: [] });
      // drop the MEMORY.md pointer too, or Claude keeps being told about a memory that is gone
      try {
        const base = path.basename(file);
        const lines = fs.readFileSync(index, 'utf8').split('\n');
        const keep = lines.filter(l => !(l.includes(`(${base})`) && entry.indexLines.push(l)));
        if (entry.indexLines.length) fs.writeFileSync(index, keep.join('\n'));
      } catch { /* no index */ }
      fs.mkdirSync(dataDir, { recursive: true });
      fs.appendFileSync(TRASH, JSON.stringify(entry) + '\n');
      fs.rmSync(file);
      return { ok: true, trashId: entry.trashId };
    }
    fs.mkdirSync(dataDir, { recursive: true });
    fs.appendFileSync(TRASH, JSON.stringify(entry) + '\n');
    return { ok: true, trashId: entry.trashId };
  }

  function restore(trashId) {
    let lines;
    try { lines = fs.readFileSync(TRASH, 'utf8').split('\n').filter(Boolean); } catch { return { error: 'Nothing to undo.' }; }
    const at = lines.findIndex(l => { try { return JSON.parse(l).trashId === trashId; } catch { return false; } });
    if (at < 0) return { error: 'That memory is no longer in the trash.' };
    const e = JSON.parse(lines[at]);
    if (e.kind === 'brain') {
      editEntity(e.file, e.name, ent => {
        ent ||= { type: 'entity', name: e.name, entityType: e.entityType || 'note', observations: [] };
        if (!ent.observations.includes(e.text)) ent.observations.splice(Math.min(e.index ?? Infinity, ent.observations.length), 0, e.text);
        return ent;
      });
    } else {
      if (fs.existsSync(e.file)) return { error: `A file is already back at ${e.file}.` };
      fs.mkdirSync(path.dirname(e.file), { recursive: true });
      fs.writeFileSync(e.file, e.text);
      if (e.indexLines?.length) {
        const index = path.join(path.dirname(e.file), 'MEMORY.md');
        let text = '';
        try { text = fs.readFileSync(index, 'utf8'); } catch { /* recreate */ }
        fs.writeFileSync(index, text.replace(/\n*$/, text ? '\n' : '') + e.indexLines.join('\n') + '\n');
      }
    }
    lines.splice(at, 1);
    fs.writeFileSync(TRASH, lines.length ? lines.join('\n') + '\n' : '');
    return { ok: true, id: e.kind === 'brain' ? observationId(e.name, e.text) : e.id };
  }

  return { read, save, remove, restore };
}
