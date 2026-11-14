import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { readProjects, projectPrompt } from '../game-projects.mjs';
import { createChat } from '../chat.mjs';

function brain() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudeos-projects-'));
  const game = fs.mkdtempSync(path.join(os.tmpdir(), 'claudeos-game-'));
  fs.mkdirSync(path.join(dir, 'Projects', 'Harbor'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'Projects', 'Empty'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'Projects', 'README.md'), '| Project | Status |\n|---|---|\n| [Harbor](Harbor/PROJECT.md) | In development | x |\n');
  fs.writeFileSync(path.join(dir, 'Projects', 'Harbor', 'PROJECT.md'), `# Harbor (working title)\n\n- **Folder:** \`${game.replace(/\\/g, '/')}\`\n- Rules here\n`);
  return { dir, game };
}

test('reads each Projects/<Name>/PROJECT.md with its folder and registry status', () => {
  const { dir, game } = brain();
  const list = readProjects(dir);
  assert.equal(list.length, 1, 'a folder without PROJECT.md is not a project');
  const [p] = list;
  assert.equal(p.id, 'Harbor');
  assert.equal(p.title, 'Harbor (working title)');
  assert.equal(p.status, 'In development');
  assert.equal(p.folder, path.resolve(game));
});

test('a brain without Projects has none, and a missing folder is left out', () => {
  assert.deepEqual(readProjects(fs.mkdtempSync(path.join(os.tmpdir(), 'claudeos-none-'))), []);
  const { dir } = brain();
  fs.writeFileSync(path.join(dir, 'Projects', 'Harbor', 'PROJECT.md'), '# Harbor\n- **Folder:** `Z:/nowhere/at/all`\n');
  assert.equal(readProjects(dir)[0].folder, null);
});

test('the project prompt names the project, its folder and its sheet', () => {
  const { dir, game } = brain();
  const text = projectPrompt(readProjects(dir)[0], dir);
  assert.match(text, /for the Harbor project/);
  assert.ok(text.includes(path.resolve(game)));
  assert.match(text, /Projects\/Harbor\/PROJECT\.md/);
  assert.match(text, /Rules here/);
});

test('a project button opens a chat that works on that project, beside the brain', async () => {
  const { dir, game } = brain();
  const launches = [], writes = [], events = [];
  const chat = createChat({ cwd: dir, dir: path.join(dir, 'chats'), memoryFile: path.join(dir, 'memory.jsonl'), globalClaudeDir: path.join(dir, 'home-claude'),
    activityFile: path.join(dir, 'activity.jsonl'), helper: () => ({ command: 'test' }), memoryServer: () => ({ command: 'test' }),
    broadcast(_k, ev) { events.push(ev); }, spawnProcess: (command, args, opts) => {
      launches.push({ args, cwd: opts.cwd }); const proc = new EventEmitter();
      proc.stdout = new PassThrough(); proc.stderr = new PassThrough();
      proc.stdin = new Writable({ write(chunk, enc, cb) { writes.push(JSON.parse(String(chunk))); cb(); } });
      return proc;
    } });
  chat.setOptions({ engine: 'claude' });
  assert.deepEqual(chat.projectList().projects.map(p => [p.id, p.count]), [['Harbor', 0]]);
  assert.match(chat.startProject('Nope').error, /gone/);
  const r = chat.startProject('Harbor');
  assert.equal(r.project, 'Harbor');
  assert.equal(chat.snapshot().project, 'Harbor');
  chat.send('Fix the dock');
  await new Promise(res => setImmediate(res));
  const { args, cwd } = launches[0];
  assert.equal(cwd, dir, 'the chat stays in the brain, with its skills and memory');
  assert.equal(args[args.indexOf('--add-dir') + 1], path.resolve(game), 'the project folder is added');
  assert.match(writes[0].message.content, /for the Harbor project[\s\S]*Rules here[\s\S]*Fix the dock$/);
  // the chat is filed under the project, and a second click starts a fresh one
  assert.equal(chat.projectList().projects[0].count, 1);
  const again = chat.startProject('Harbor');
  assert.notEqual(again.chat, r.chat);
  chat.stopAll();
});
