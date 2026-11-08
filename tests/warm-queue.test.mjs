import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createChat } from '../chat.mjs';

const turn = () => new Promise(r => setImmediate(r));
test('brief queue retains one process, session, stable prompt and persisted history', async () => {
  const lab = fs.mkdtempSync(path.join(os.tmpdir(), 'warm-queue-'));
  const processes = [], writes = [], launches = [];
  fs.writeFileSync(path.join(lab, 'CLAUDE.md'), 'Company foundations: master Medieval FPS rules.');
  let crew = [{ name: 'First', skill: 'first' }];
  const chat = createChat({ cwd: lab, dir: path.join(lab, 'chats'), memoryFile: path.join(lab, 'memory.jsonl'), globalClaudeDir: path.join(lab, 'home-claude'),
    activityFile: path.join(lab, 'activity.jsonl'), helper: () => ({ command: 'test' }), memoryServer: () => ({ command: 'test' }),
    broadcast() {}, team: () => crew, spawnProcess: (command, args) => {
      launches.push(args); const proc = new EventEmitter();
      proc.stdout = new PassThrough(); proc.stderr = new PassThrough();
      proc.stdin = new Writable({ write(chunk, enc, cb) { writes.push(JSON.parse(String(chunk))); cb(); } });
      processes.push(proc); return proc;
    } });
  chat.setOptions({ engine: 'claude' });
  const id = chat.currentId();
  const emit = result => processes.at(-1).stdout.write(JSON.stringify({ type: 'result', session_id: 'same-session', result }) + '\n');
  try {
    chat.send('Manager turn');
    const first = chat.runInline({ chat: id, prompt: 'Sphere one' });
    const cancelled = chat.runInline({ chat: id, prompt: 'Never send' });
    const second = chat.runInline({ chat: id, prompt: 'Sphere two' });
    cancelled.stop(); assert.equal((await cancelled.done).stopped, true);
    await turn(); assert.equal(writes.length, 1);
    emit('Manager ready'); await turn(); assert.equal(writes.length, 2);
    emit('First report'); assert.equal((await first.done).result, 'First report');
    await turn(); assert.equal(writes.length, 3);
    const disk = JSON.parse(fs.readFileSync(path.join(lab, 'chats', id + '.json')));
    assert.ok(disk.messages.some(m => m.text === 'First report'));
    assert.equal(disk.sessionId, 'same-session');
    emit('Second report'); assert.equal((await second.done).result, 'Second report');
    assert.equal(processes.length, 1);
    assert.match(writes[0].message.content, /Manager turn$/);
    assert.deepEqual(writes.slice(1).map(w => w.message.content), ['Sphere one', 'Sphere two'].map(s => `=== SPHERE EXECUTION BOUNDARY: assignment ===\n${s}\n===`));
    // ClaudeOS's instructions go in once, as an appended system prompt; the brain's CLAUDE.md is left as the user wrote it
    const appended = l => l[l.indexOf('--append-system-prompt') + 1];
    assert.match(appended(launches[0]), /ClaudeOS desk tools/);
    const foundations = fs.readFileSync(path.join(lab, 'CLAUDE.md'), 'utf8');
    assert.equal(foundations, 'Company foundations: master Medieval FPS rules.');
    // A team/project refresh must not replace the process or mutate the stable prefix.
    crew = [{ name: 'Changed', skill: 'changed' }];
    const third = chat.runInline({ chat: id, prompt: 'Sphere three' }); await turn();
    assert.equal(processes.length, 2); // MCP tool inventory changes legitimately restart the runtime.
    assert.equal(appended(launches[1]), appended(launches[0]), 'the same instructions every launch, so the cached prefix stays the same');
    assert.equal(fs.readFileSync(path.join(lab, 'CLAUDE.md'), 'utf8'), foundations);
    assert.ok(launches[1].includes('--resume'));
    emit('Third report'); await third.done;
    const desk = chat.employeeChat({ id: 'first', name: 'First', skill: 'first', cabinet: path.join(lab, 'Office', 'First') });
    chat.view(desk.id); chat.send('Desk question');
    assert.equal(processes.length, 2);
    emit('Desk report'); await turn();
    assert.equal(chat.currentId(), id);
    assert.ok(fs.readFileSync(path.join(lab, 'Office', 'First', 'Chats', new Date().toISOString().slice(0, 10) + '.md'), 'utf8').includes('Desk report'));
    chat.view(null);
  } finally { chat.stopAll(); fs.rmSync(lab, { recursive: true, force: true }); }
});

import { createManager } from '../manager.mjs';
import { runHandoff } from '../handoff.mjs';
test('all briefs serialize and save full cabinet reports before advancing', async () => {
  const lab = fs.mkdtempSync(path.join(os.tmpdir(), 'warm-manager-'));
  const calls = [], reports = [];
  const m = createManager({ cwd: lab, dataFile: path.join(lab, 'manager.json'), activityFile: path.join(lab, 'activity.jsonl'),
    broadcast() {}, team: () => [{ name: 'One', skill: 'one' }], cabinet: () => path.join(lab, 'Office'),
    onBriefDone: b => reports.push(b), inlineRunner: args => {
      let resolve; const done = new Promise(r => { resolve = r; });
      calls.push({ args, resolve }); return { done, stop() { resolve({ stopped: true }); } };
    } });
  try {
    assert.ok(m.postBrief({ chat: 'shared', tasks: [{ id: 'a', employee: 'one', task: 'First' }, { id: 'b', employee: 'one', task: 'Second' }] }).ok);
    assert.ok(m.postBrief({ chat: 'shared', tasks: [{ employee: 'one', task: 'Third' }] }).ok);
    assert.equal(calls.length, 1);
    const payload = JSON.parse(fs.readFileSync(path.join(lab, '.claude', 'active_brief.json')));
    assert.equal(payload.chatId, 'shared');
    assert.equal(payload.task.task, 'First');
    assert.equal(payload.skill.id, 'one');
    assert.match(calls[0].args.prompt, /active_brief.json/);
    const full = 'Full report '.repeat(600);
    calls[0].resolve({ result: full, session: 'warm-session' }); await turn();
    assert.equal(calls.length, 2);
    const logs = fs.readdirSync(path.join(lab, 'Office'), { recursive: true }).filter(x => String(x).endsWith('.md'));
    assert.ok(logs.some(x => fs.readFileSync(path.join(lab, 'Office', x), 'utf8').includes(full)));
    calls[1].resolve({ result: 'Second done' }); await turn(); assert.equal(calls.length, 3);
    calls[2].resolve({ result: 'Third done' }); await turn(); assert.equal(reports.length, 2);
    assert.ok(calls.every(c => c.args.chat === 'shared'));
    let delegated = false;
    const handoff = runHandoff({ task: 'Linked work', runner: args => { delegated = true; assert.match(args.prompt, /Linked work/); return { done: Promise.resolve({ result: 'Linked done' }), stop() {} }; } });
    assert.equal((await handoff.done).result, 'Linked done'); assert.ok(delegated);
  } finally { m.stop(); fs.rmSync(lab, { recursive: true, force: true }); }
});

test('headless turns validate split completion tokens, flush final JSON, and reload changed skills', async () => {
  const lab = fs.mkdtempSync(path.join(os.tmpdir(), 'headless-lab-'));
  const processes = [], launches = [], writes = [], telemetry=[];
  const skill = path.join(lab, '.claude', 'skills', 'builder', 'SKILL.md');
  fs.mkdirSync(path.dirname(skill), { recursive: true }); fs.writeFileSync(skill, 'Original rules');
  const chat = createChat({ cwd: lab, dir: path.join(lab, 'chats'), memoryFile: path.join(lab, 'memory.jsonl'), globalClaudeDir: path.join(lab, 'home-claude'),
    activityFile: path.join(lab, 'activity.jsonl'), helper: () => ({ command: 'test' }), memoryServer: () => ({ command: 'test' }),
    broadcast(_event, data) { telemetry.push(data); }, team: () => [], spawnProcess: (command, args) => {
      launches.push(args); const proc = new EventEmitter(); proc.stdout = new PassThrough(); proc.stderr = new PassThrough();
      proc.stdin = new Writable({ write(chunk, enc, cb) { writes.push(JSON.parse(String(chunk))); cb(); } });
      processes.push(proc); return proc;
    } });
  chat.setOptions({ engine: 'claude' }); const id = chat.currentId();
  try {
    const first = chat.runInline({ chat: id, skillId: 'builder', headless: true, prompt: 'Execute' }); await turn();
    assert.match(writes.at(-1).message.content, /=== SPHERE EXECUTION BOUNDARY: builder ===\nExecute\n===$/);
    assert.equal(launches[0][launches[0].indexOf('--permission-mode') + 1], 'bypassPermissions');
    processes[0].stdout.write(JSON.stringify({type:'assistant',message:{content:[],usage:{input_tokens:10, cache_read_input_tokens:900}}})+'\n');
    assert.ok(telemetry.some(e=>e.kind==='sphere-cache' && e.skillId==='builder' && e.cached===900));
    assert.ok(telemetry.some(e=>e.kind==='stdout' && e.skillId==='builder'));
    const event = JSON.stringify({ type:'result', session_id:'warm', result:'Report [TASK_COMPLETE]' });
    processes[0].stdout.write(event.slice(0, -8)); processes[0].stdout.end(event.slice(-8));
    assert.equal((await first.done).result, 'Report');
    const disk = JSON.parse(fs.readFileSync(path.join(lab, 'chats', id + '.json')));
    assert.equal(disk.messages.at(-1).text, 'Report'); assert.equal(disk.messages.at(-1).streaming, false);
    fs.writeFileSync(skill, 'Updated technical constraints');
    const second = chat.runInline({chat:id, skillId:'builder', headless:true, prompt:'Next'}); await turn();
    assert.equal(processes.length, 2); assert.ok(launches[1].includes('--resume'));
    processes[1].stdout.write(JSON.stringify({type:'result',result:'Forgot marker'}) + '\n');
    assert.match((await second.done).error, /without \[TASK_COMPLETE\]/);
  } finally { chat.stopAll(); fs.rmSync(lab, {recursive:true,force:true}); }
});
