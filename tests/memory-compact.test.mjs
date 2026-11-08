import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { trimSearch } from '../memory-mcp.mjs';
import { createCompactor, sizeOf, parseNotes, LIMITS } from '../memory-compact.mjs';
import { removeFoundationsBlock } from '../chat.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'claudeos-compact-'));
const entity = (name, observations, entityType = 'project') => ({ type: 'entity', name, entityType, observations });
const write = (file, rows) => fs.writeFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
const read = file => fs.readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l));

test('a memory search returns only the matching notes of each entry, and says how many more there are', () => {
  const big = entity('ClaudeOS', [...Array.from({ length: 60 }, (_, i) => `2026-11-0${i % 9 + 1}: release ${i} notes`), '2026-11-05: built a studio website page']);
  const other = entity('Studio', ['2026-11-01: our studio is Verde']);
  const r = trimSearch({ entities: [big, other], relations: [{ from: 'ClaudeOS', to: 'Studio', relationType: 'x' }] }, 'studio');
  assert.deepEqual(r.entities[0].observations, ['2026-11-05: built a studio website page', '(60 more notes on this entry; open_nodes with its name shows them all)']);
  assert.deepEqual(r.entities[1].observations, ['2026-11-01: our studio is Verde']);
  assert.equal(r.relations.length, 1);
  // found by its name: its newest notes
  const byName = trimSearch({ entities: [big], relations: [] }, 'claudeos', 3);
  assert.deepEqual(byName.entities[0].observations.slice(0, 3), big.observations.slice(-3));
  assert.match(byName.entities[0].observations[3], /58 more notes/);
  assert.ok(JSON.stringify(r).length < JSON.stringify(big).length / 5);
});

test('the brain size names the entries worth compacting', () => {
  const dir = tmp();
  try {
    const file = path.join(dir, 'memory.jsonl');
    write(file, [entity('Small', ['a']), entity('Many', Array.from({ length: LIMITS.notes + 1 }, (_, i) => 'note ' + i)), entity('Long', ['x'.repeat(LIMITS.chars + 10)])]);
    const s = sizeOf(file);
    assert.equal(s.entries, 3); assert.equal(s.suggest, true);
    assert.deepEqual(s.large.map(e => e.name), ['Long', 'Many']);
    assert.equal(sizeOf(path.join(dir, 'none.jsonl')).entries, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('only a real, well-formed shrink is accepted', () => {
  const orig = ['2026-11-01: a long note about many things that went on', '2026-11-02: another long note with detail'];
  assert.deepEqual(parseNotes('Sure:\n["2026-11-02: short"]', orig, 3), ['2026-11-02: short']);
  assert.equal(parseNotes('["' + 'y'.repeat(200) + '"]', orig, 3), null, 'longer is refused');
  assert.equal(parseNotes('["a","b","c","d"]', orig, 3), null, 'too many notes');
  assert.equal(parseNotes('not json', orig, 3), null);
  assert.equal(parseNotes('[1, 2]', orig, 3), null);
});

test('compacting rewrites only oversized entries, keeps a backup, leaves an entry changed meanwhile, and Undo restores it', async () => {
  const dir = tmp();
  try {
    const file = path.join(dir, 'memory.jsonl');
    const many = Array.from({ length: 20 }, (_, i) => `2026-11-0${i % 9 + 1}: detailed release note number ${i} with long text`);
    write(file, [entity('Big', many), entity('Busy', many.map(n => n + '!')), entity('Small', ['2026-11-01: keep me']), { type: 'relation', from: 'Big', to: 'Small', relationType: 'uses' }]);
    const original = fs.readFileSync(file, 'utf8');
    let calls = 0;
    const c = createCompactor({ dataDir: dir, ask: async prompt => {
      calls++;
      assert.match(prompt, /JSON array of strings/);
      // while Claude works on "Busy", a chat adds a note to it
      if (prompt.includes('Entry: Busy')) { const rows = read(file); rows.find(r => r.name === 'Busy').observations.push('2026-11-05: new from a chat'); write(file, rows); }
      return '["2026-11-09: Big shipped releases 0-19; current state summarized."]';
    } });
    const brain = { id: 'b1' };
    const r = await c.compact(brain, file);
    assert.equal(r.ok, true); assert.equal(calls, 2);
    const rows = read(file);
    assert.deepEqual(rows.find(x => x.name === 'Big').observations, ['2026-11-09: Big shipped releases 0-19; current state summarized.']);
    assert.equal(rows.find(x => x.name === 'Busy').observations.length, 21, 'an entry changed meanwhile keeps its notes');
    assert.equal(r.entries.find(e => e.name === 'Busy').kept, 'it changed while Claude worked');
    assert.deepEqual(rows.find(x => x.name === 'Small').observations, ['2026-11-01: keep me']);
    assert.ok(rows.some(x => x.type === 'relation'), 'relations stay');
    assert.ok(r.after.chars < r.before.chars);
    assert.equal(fs.readFileSync(r.backup, 'utf8'), original);
    assert.equal(c.canUndo(brain), true);
    const u = c.undo(brain, file);
    assert.equal(u.ok, true);
    assert.equal(fs.readFileSync(file, 'utf8'), original);
    assert.equal(c.undo(brain, file).error, 'There is no compaction to undo.');
    // nothing large: no model call
    write(file, [entity('Small', ['a'])]);
    const n = await c.compact(brain, file);
    assert.equal(n.nothing, true); assert.equal(calls, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the old foundations copy is removed from a CLAUDE.md, and only that', () => {
  const dir = tmp();
  try {
    const own = path.join(dir, 'own.md'), only = path.join(dir, 'only.md'), none = path.join(dir, 'none.md');
    const block = '<!-- ClaudeOS foundations: begin -->\nDesk tools…\n<!-- ClaudeOS foundations: end -->';
    fs.writeFileSync(own, `# My rules\n\nAlways test.\n\n${block}\n\n## More\nKeep this.\n`);
    fs.writeFileSync(only, `\n${block}\n`);
    fs.writeFileSync(none, '# Untouched\n');
    assert.equal(removeFoundationsBlock(own), true);
    assert.equal(fs.readFileSync(own, 'utf8'), '# My rules\n\nAlways test.\n## More\nKeep this.\n');
    assert.equal(removeFoundationsBlock(only), true);
    assert.equal(fs.existsSync(only), false, 'a file that held only the block goes');
    assert.equal(removeFoundationsBlock(none), false);
    assert.equal(fs.readFileSync(none, 'utf8'), '# Untouched\n');
    assert.equal(removeFoundationsBlock(path.join(dir, 'missing.md')), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
