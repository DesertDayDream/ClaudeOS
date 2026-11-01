// Brains: the environments ClaudeOS can switch between. Each brain is a folder with its own
// shared-brain file (brain/memory.jsonl), team (.claude/skills), CLAUDE.md and chat.
// Setting a folder up only ever adds what is missing; it never overwrites or deletes anything.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MEMORY_SERVER = { command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] };
const HOOK_EVENTS = [['UserPromptSubmit'], ['PreToolUse', 'Skill'], ['Stop']];

const BRAIN_SECTION = `## The shared brain
Long-term memory lives in the \`memory\` MCP server (\`brain/memory.jsonl\` in this folder).
- **Search first.** Before answering about the user's work, plans, preferences or past decisions, call \`mcp__memory__search_nodes\` or \`mcp__memory__open_nodes\`. Prefer what you find over guessing; say so if it looks out of date.
- **Save after.** When the user makes a decision, states a preference ("from now on…", "always…", "never…") or a fact worth keeping comes up, save it right away: \`mcp__memory__add_observations\` on the matching entity, or \`mcp__memory__create_entities\` for a new one. One short, dated fact per observation. Confirm in one line.
- Never save passwords, API keys, tokens or private details about other people.
`;

const TEAM_SECTION = `## The team
Skills in \`.claude/skills/\` are this brain's team. Hand work to the skills that match the task, and only those; when a task has several parts, give each part to its own skill. When the user wants a new kind of help, offer to write a new skill (a folder with a \`SKILL.md\`) and show it before saving.
`;

export function slugFor(dir) {
  return path.resolve(dir).replace(/[^a-zA-Z0-9]/g, '-');
}

export function samePath(a, b) {
  const n = p => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
  return n(a) === n(b);
}

export function inside(child, parent) {
  const c = path.resolve(child).toLowerCase() + path.sep;
  const p = path.resolve(parent).replace(/[\\/]+$/, '').toLowerCase() + path.sep;
  return c.startsWith(p);
}

function readJsonFile(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return e.code === 'ENOENT' ? undefined : null; }
}
function writeJsonFile(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

// The command each brain's hooks run. It names the data folder so the log lands in the right place.
export function hookCommand(hookScript, dataDir) {
  return `node "${hookScript.replace(/\\/g, '/')}" "${dataDir.replace(/\\/g, '/')}"`;
}

// Adds missing ClaudeOS hooks and points existing ones at this copy of the app, so moving the
// app folder heals itself. Returns true if the settings changed.
function ensureHooks(s, command) {
  let changed = false;
  s.hooks ||= {};
  for (const [event, matcher] of HOOK_EVENTS) {
    s.hooks[event] ||= [];
    let found = false;
    for (const g of s.hooks[event]) {
      for (const h of g.hooks || []) {
        if (!String(h.command || '').includes('claude-os-hook')) continue;
        found = true;
        if (h.command !== command) { h.command = command; changed = true; }
      }
    }
    if (!found) { s.hooks[event].push({ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command }] }); changed = true; }
  }
  return changed;
}

export function repairHooks(dir, command) {
  const file = path.join(dir, '.claude', 'settings.json');
  const s = readJsonFile(file);
  if (!s || !ensureHooks(s, command)) return false;
  writeJsonFile(file, s);
  return true;
}

// Adds the ClaudeOS pieces a folder is missing. Returns a list of what it did, for the page.
export function setupBrain(dir, { name, hookCommand: command, template, templatesDir }) {
  const done = [];
  const creative = template === 'creative' ? path.join(templatesDir, 'creative') : null;
  fs.mkdirSync(path.join(dir, 'brain'), { recursive: true });

  const memFile = path.join(dir, 'brain', 'memory.jsonl');
  if (!fs.existsSync(memFile)) {
    let seed = '';
    if (creative) { try { seed = fs.readFileSync(path.join(creative, 'memory.jsonl'), 'utf8'); } catch { /* start empty */ } }
    fs.writeFileSync(memFile, seed);
    done.push(seed ? 'brain/memory.jsonl (with starter brand rules)' : 'brain/memory.jsonl (empty brain)');
  }

  const mcpFile = path.join(dir, '.mcp.json');
  const mcp = readJsonFile(mcpFile);
  if (mcp === null) done.push('skipped .mcp.json: it is not valid JSON, so I left it alone');
  else {
    const cfg = mcp || {};
    cfg.mcpServers ||= {};
    if (!cfg.mcpServers.memory) {
      cfg.mcpServers.memory = { ...MEMORY_SERVER, env: { MEMORY_FILE_PATH: memFile.replace(/\\/g, '/') } };
      writeJsonFile(mcpFile, cfg);
      done.push(mcp ? 'added the memory server to .mcp.json' : '.mcp.json');
    }
  }

  const settingsFile = path.join(dir, '.claude', 'settings.json');
  const settings = readJsonFile(settingsFile);
  if (settings === null) done.push('skipped .claude/settings.json: it is not valid JSON, so I left it alone');
  else {
    const s = settings || {};
    let changed = false;
    s.permissions ||= {};
    const extra = creative ? (readJsonFile(path.join(creative, 'settings.json'))?.permissions || {}) : {};
    for (const kind of ['allow', 'ask', 'deny']) {
      const want = [...(kind === 'allow' ? ['mcp__memory'] : []), ...(extra[kind] || [])];
      if (!want.length) continue;
      s.permissions[kind] ||= [];
      for (const rule of want) if (!s.permissions[kind].includes(rule)) { s.permissions[kind].push(rule); changed = true; }
    }
    s.enabledMcpjsonServers ||= [];
    if (!s.enabledMcpjsonServers.includes('memory')) { s.enabledMcpjsonServers.push('memory'); changed = true; }
    if (ensureHooks(s, command)) changed = true;
    if (changed) { writeJsonFile(settingsFile, s); done.push(settings ? 'added ClaudeOS settings to .claude/settings.json' : '.claude/settings.json'); }
  }

  const claudeMd = path.join(dir, 'CLAUDE.md');
  const title = name || path.basename(dir);
  if (!fs.existsSync(claudeMd)) {
    let text = `# ${title}\n\nThis folder is a ClaudeOS brain: one Claude with its own shared brain and team.\n\n${BRAIN_SECTION}\n${TEAM_SECTION}`;
    if (creative) { try { text = fs.readFileSync(path.join(creative, 'CLAUDE.md'), 'utf8').replace('{{NAME}}', title); } catch { /* generic */ } }
    fs.writeFileSync(claudeMd, text);
    done.push('CLAUDE.md');
  } else if (!fs.readFileSync(claudeMd, 'utf8').includes('## The shared brain')) {
    fs.appendFileSync(claudeMd, `\n\n${BRAIN_SECTION}`);
    done.push('added a "shared brain" section to CLAUDE.md');
  }

  const agentsMd = path.join(dir, 'AGENTS.md');
  if (!fs.existsSync(agentsMd)) {
    fs.writeFileSync(agentsMd, `# ${title} (for Codex and other agents)\n\nRead \`CLAUDE.md\` in this folder; its rules apply to you too. The shared brain is the \`memory\` MCP server with \`MEMORY_FILE_PATH\` set to this folder's \`brain/memory.jsonl\`.\n`);
    done.push('AGENTS.md');
  }

  if (creative) {
    const from = path.join(creative, 'skills');
    const to = path.join(dir, '.claude', 'skills');
    for (const entry of fs.existsSync(from) ? fs.readdirSync(from) : []) {
      const dest = path.join(to, entry);
      if (fs.existsSync(dest)) continue;
      fs.cpSync(path.join(from, entry), dest, { recursive: true, filter: src => !src.includes('__pycache__') });
      done.push(`.claude/skills/${entry}`);
    }
    for (const sub of ['inbox/radar', 'inbox/stats', 'out', 'done']) {
      if (!fs.existsSync(path.join(dir, sub))) { fs.mkdirSync(path.join(dir, sub), { recursive: true }); done.push(sub + '/'); }
    }
  }
  return done;
}

export function createRegistry({ file }) {
  let reg = readJsonFile(file);
  if (!reg || !Array.isArray(reg.brains)) reg = { active: null, brains: [] }; // first run: no brains yet
  const save = () => writeJsonFile(file, reg);
  return {
    list: () => reg.brains,
    active: () => reg.brains.find(b => b.id === reg.active) || reg.brains[0] || null,
    find: id => reg.brains.find(b => b.id === id),
    byPath: p => reg.brains.find(b => samePath(b.path, p)),
    add(brain) { reg.brains.push(brain); save(); return brain; },
    remove(id) { reg.brains = reg.brains.filter(b => b.id !== id); if (reg.active === id) reg.active = reg.brains[0]?.id ?? null; save(); },
    activate(id) { reg.active = id; save(); },
  };
}

// Folder browser for the setup, "New brain" and "Add existing folder" dialogs.
export function listFolder(dir) {
  if (!dir) {
    const home = os.homedir();
    const places = [['Desktop', path.join(home, 'Desktop')], ['Documents', path.join(home, 'Documents')], ['Home', home]];
    const oneDrive = path.join(home, 'OneDrive', 'Desktop');
    if (fs.existsSync(oneDrive)) places.splice(1, 0, ['OneDrive Desktop', oneDrive]);
    const roots = [];
    if (process.platform === 'win32') { for (const l of 'CDEFGH') if (fs.existsSync(`${l}:\\`)) roots.push([`${l}:`, `${l}:\\`]); }
    else roots.push(['/', '/']);
    return { dir: '', parent: null, folders: [...places, ...roots].filter(([, p]) => fs.existsSync(p)).map(([name, p]) => ({ name, path: p })) };
  }
  const abs = path.resolve(dir);
  let entries = [];
  try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch (e) { return { error: `Can't open ${abs}: ${e.code}` }; }
  const folders = entries.filter(d => d.isDirectory() && !d.name.startsWith('.') && !d.name.startsWith('$') && d.name !== 'node_modules')
    .map(d => ({ name: d.name, path: path.join(abs, d.name) }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  const parent = path.dirname(abs);
  return { dir: abs, parent: parent === abs ? '' : parent, folders,
    isBrain: fs.existsSync(path.join(abs, 'brain', 'memory.jsonl')) };
}
