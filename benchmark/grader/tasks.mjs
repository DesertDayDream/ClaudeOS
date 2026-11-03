// Task folders in tasks/<id>: prompt.md (what both apps get), checks.json, hidden/ (never copied), rubric.md.
import fs from 'node:fs';
import path from 'node:path';

export function createTasks(root) {
function listTasks() {
  try { return fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory() && fs.existsSync(path.join(root, d.name, 'checks.json'))).map(d => d.name); } catch { return []; }
}
function loadTask(id) {
  if (!listTasks().includes(id)) return null;
  const dir = path.join(root, id);
  return { id, dir, checks: JSON.parse(fs.readFileSync(path.join(dir, 'checks.json'), 'utf8')), prompt: fs.readFileSync(path.join(dir, 'prompt.md'), 'utf8').trim(),
    rubric: fs.existsSync(path.join(dir, 'rubric.md')) ? fs.readFileSync(path.join(dir, 'rubric.md'), 'utf8') : '' };
}

return {listTasks, loadTask};
}
