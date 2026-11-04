import { atomicWrite } from './performance-reviews.mjs';
// Skill editor: hire, edit and fire the active brain's employees (folders in <brain>/.claude/skills).
// The page edits three parts of a SKILL.md: name and description in the frontmatter, and the
// instructions below it. Any other frontmatter (allowed-tools, model, ...) is kept as it was.
// A fired employee's folder goes to <data>/trash/skills so it can be hired back.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { APPS, appsInText } from './public/apps.js';

// Claude Code's rule for skill names
const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const FM = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

// a YAML value on one line: quoted only when plain text would mean something else in YAML
function yamlValue(s) {
  return /^[\s'"&*!|>%@`#,\[\]{}?:-]|: | #|\s$/.test(s) ? JSON.stringify(s) : s;
}

export function parseSkill(text) {
  const m = text.match(FM);
  const lines = m ? m[1].split(/\r?\n/) : [];
  const get = key => {
    const line = lines.find(l => new RegExp(`^${key}:`).test(l));
    if (!line) return '';
    const v = line.slice(key.length + 1).trim();
    if (v.startsWith('"')) { try { return JSON.parse(v); } catch { /* fall through */ } }
    return v.replace(/^["']|["']$/g, '');
  };
  return { name: get('name'), description: get('description'), body: m ? text.slice(m[0].length).replace(/^\r?\n/, '') : text, lines };
}

// Puts name and description into the frontmatter lines, keeping every other line.
function compose(lines, { name, description, body }) {
  const out = [];
  let wroteName = false, wroteDesc = false, skipping = false;
  for (const line of lines) {
    // a multi-line value (description: >- and indented lines) is replaced whole
    if (skipping && /^\s+\S|^\s*$/.test(line)) continue;
    skipping = false;
    if (/^name:/.test(line)) { out.push(`name: ${name}`); wroteName = true; continue; }
    if (/^description:/.test(line)) { out.push(`description: ${yamlValue(description)}`); wroteDesc = true; skipping = true; continue; }
    out.push(line);
  }
  if (!wroteDesc) out.unshift(`description: ${yamlValue(description)}`);
  if (!wroteName) out.unshift(`name: ${name}`);
  return `---\n${out.join('\n')}\n---\n\n${body.replace(/^\s*\n/, '').replace(/\s*$/, '')}\n`;
}

export function createSkillEditor({ dataDir }) {
  const TRASH_DIR = path.join(dataDir, 'trash', 'skills');
  const TRASH = path.join(dataDir, 'trash', 'skills.jsonl');

  function read(teamDir, folder) {
    const file = path.join(teamDir, folder, 'SKILL.md');
    const s = parseSkill(fs.readFileSync(file, 'utf8'));
    return { file, name: s.name || folder, description: s.description, body: s.body };
  }

  function check({ name, description, body }) {
    name = String(name || '').trim();
    description = String(description || '').trim().replace(/\s*\n\s*/g, ' ');
    body = String(body ?? '');
    if (!name) return { error: 'Give the employee a skill name, like "proof-reader".' };
    if (!NAME.test(name) || name.length > 64) return { error: 'Use lowercase letters, numbers and dashes for the skill name (up to 64), like "proof-reader".' };
    if (!description) return { error: 'Say what it does and when Claude should use it. Claude reads this to decide.' };
    if (description.length > 1024) return { error: `The description is ${description.length} characters. Keep it under 1024.` };
    if (!body.trim()) return { error: 'Write the instructions: the steps this employee follows.' };
    return { name, description, body };
  }

  // folder null = hire someone new
  function save(teamDir, folder, fields) {
    const v = check(fields);
    if (v.error) return v;
    if (!folder) {
      const dir = path.join(teamDir, v.name);
      if (fs.existsSync(dir)) return { error: `There's already a .claude/skills/${v.name} folder. Pick another name, or edit that one.` };
      fs.mkdirSync(dir, { recursive: true });
      atomicWrite(path.join(dir, 'SKILL.md'), compose([], v));
      return { ok: true, folder: v.name, name: v.name };
    }
    const file = path.join(teamDir, folder, 'SKILL.md');
    const old = parseSkill(fs.readFileSync(file, 'utf8'));
    atomicWrite(file, compose(old.lines, v));
    // a renamed skill gets a matching folder when that name is free, so the two never drift apart
    let to = folder;
    if (v.name !== folder && !fs.existsSync(path.join(teamDir, v.name))) {
      try { fs.renameSync(path.join(teamDir, folder), path.join(teamDir, v.name)); to = v.name; } catch { /* folder in use; the name still changed */ }
    }
    return { ok: true, folder: to, name: v.name, oldName: old.name || folder };
  }

  function move(from, to) {
    try { fs.renameSync(from, to); } catch { fs.cpSync(from, to, { recursive: true }); fs.rmSync(from, { recursive: true, force: true }); }
  }

  function fire(teamDir, folder) {
    const trashId = crypto.randomUUID();
    const src = path.join(teamDir, folder);
    const name = parseSkill(fs.readFileSync(path.join(src, 'SKILL.md'), 'utf8')).name || folder;
    fs.mkdirSync(TRASH_DIR, { recursive: true });
    move(src, path.join(TRASH_DIR, trashId));
    fs.appendFileSync(TRASH, JSON.stringify({ trashId, at: Date.now(), dir: src, name }) + '\n');
    return { ok: true, trashId, name };
  }

  function restore(trashId) {
    let lines;
    try { lines = fs.readFileSync(TRASH, 'utf8').split('\n').filter(Boolean); } catch { return { error: 'Nothing to undo.' }; }
    const at = lines.findIndex(l => { try { return JSON.parse(l).trashId === trashId; } catch { return false; } });
    if (at < 0) return { error: 'That employee is no longer in the trash.' };
    const e = JSON.parse(lines[at]);
    if (fs.existsSync(e.dir)) return { error: `Someone is already at ${e.dir}.` };
    fs.mkdirSync(path.dirname(e.dir), { recursive: true });
    move(path.join(TRASH_DIR, trashId), e.dir);
    lines.splice(at, 1);
    fs.writeFileSync(TRASH, lines.length ? lines.join('\n') + '\n' : '');
    return { ok: true, folder: path.basename(e.dir), name: e.name };
  }

  function addApp(teamDir, folder, key) {
    if (!Object.hasOwn(APPS, key)) return { error: 'Choose an app from the list.' };
    const file = path.join(teamDir, folder, 'SKILL.md');
    const text = fs.readFileSync(file, 'utf8');
    if (appsInText(text).some(a => a.key === key)) return { ok: true };
    const app = APPS[key];
    atomicWrite(file, text.trimEnd() + `\n\n## App: ${app.title}\nUse ${app.title} through its connected integration when the task calls for it. If it is unavailable or needs sign-in, tell the user to connect it in Apps before continuing with work that needs it.\n`);
    return { ok: true };
  }

  return { read, save, fire, restore, addApp };
}
