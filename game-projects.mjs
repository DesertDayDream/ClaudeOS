import fs from 'node:fs';
import path from 'node:path';

// A brain's projects (a studio's games, a client's sites...): one Projects/<Name>/PROJECT.md each. They show
// as buttons beside the team, and a chat started from one works on that project only: its sheet goes in the
// chat's instructions and its folder is added to the chat, while the chat stays in the brain (skills, memory).
// Projects/README.md, when it has a table with "| [Name](Name/PROJECT.md) | status |" rows, gives each one's status.

const SHEET_MAX = 6000;

export function readProjects(brainDir) {
  const root = path.join(brainDir, 'Projects');
  let dirs;
  try { dirs = fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); } catch { return []; }
  let registry = '';
  try { registry = fs.readFileSync(path.join(root, 'README.md'), 'utf8'); } catch { /* no registry */ }
  return dirs.flatMap(id => {
    const sheet = path.join(root, id, 'PROJECT.md');
    let text;
    try { text = fs.readFileSync(sheet, 'utf8'); } catch { return []; }
    const title = (text.match(/^#\s+(.+)$/m)?.[1] || id).trim();
    const raw = text.match(/\*\*Folder:\*\*\s*`([^`]+)`/i)?.[1];
    const folder = raw && isDir(raw) ? path.resolve(raw) : null;
    const row = registry.split(/\r?\n/).find(l => l.includes(`](${id}/PROJECT.md)`));
    const status = row ? (row.split('|')[2] || '').trim() : '';
    return [{ id, name: id, title, status, folder, sheet, text: text.length > SHEET_MAX ? text.slice(0, SHEET_MAX) + '\n…' : text }];
  }).sort((a, b) => a.name.localeCompare(b.name));
}

function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }

// what a project chat is told on top of the brain's own instructions
export function projectPrompt(p, brainDir) {
  const rel = path.relative(brainDir, p.sheet).replace(/\\/g, '/');
  return `This chat is for the ${p.name} project (the user opened it from the ${p.name} button). Everything asked here is about ${p.name} unless the user names another project: ` +
    `work on its files only and never edit another project's files to fix this one${p.folder ? `. Its folder ${p.folder} is added to this chat` : ''}. ` +
    `Employees file this work under the project's name in their cabinet (Office/<Employee>/${p.name}/). Memory facts about it go on entities whose names start with "${p.name}". ` +
    `Its project sheet (${rel}):\n${p.text.trim()}`;
}
