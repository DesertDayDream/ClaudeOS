import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { scoreSide, verdict } from '../benchmark/grader/scoring.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
test('unobserved, stopped and wrong-folder runs cannot pass; ungraded prompts cannot win on speed', () => {
  const metrics = {logFile:'fixture.jsonl', status:'done', cwdOk:true, model:'same', effort:'medium', reply:'OK', elapsedMs:1000, tokens:{fresh:10}};
  const score = m => scoreSide({id:'a',metrics:m}, {prompt:'Reply OK.'});
  assert.equal(score(metrics).pass, true);
  for (const change of [{logFile:null},{status:'stopped'},{cwdOk:false},{reply:'OK. I created it'}]) assert.equal(score({...metrics,...change}).pass,false);
  assert.equal(verdict([{id:'a',metrics,score:score(metrics)},{id:'b',metrics:{...metrics,elapsedMs:10000},score:score(metrics)}]).winner,null);
  const passing = {...score(metrics), quality:100};
  assert.equal(verdict([{id:'a',metrics,score:passing},{id:'b',metrics:{...metrics,status:'failed'},score:{...passing,pass:false}}]).winner,null);
});

test('embedded routes enforce auth, preserve round files, export escaped evidence, and survive restart', async t => {
  const lab = fs.mkdtempSync(path.join(os.tmpdir(),'claudeos-benchmark-test-'));
  process.env.BENCH_HOME = path.join(lab,'bench'); process.env.BENCH_DRY = '1';
  process.env.BENCH_NO_JUDGE = '1'; process.env.CLAUDE_CONFIG_DIR = path.join(lab,'claude');
  const {createBenchmark} = await import('../benchmark/panel/server.mjs');
  const options = {kit:path.join(root,'benchmark'),dataDir:lab,port:0,token:'test-token',context:()=>({brainId:'fixture',brainName:'Lab',mode:'auto',options:{model:'opus',effort:'high'}}),start:async()=>{},stop:async()=>{},
    environments:()=>({brains:[{id:'fixture',name:'Lab',active:true},{id:'second',name:'Second'}],claude:{command:'claude',args:[],env:{}},codex:{command:'codex',args:[],env:{X:'1'}}})};
  let bench=createBenchmark(options);
  const server=http.createServer((req,res)=>bench.handle(req,res,new URL(req.url,'http://local')));
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{bench.close();server.close();});
  const base='http://127.0.0.1:'+server.address().port+'/benchmark';
  const api=async(route,body)=>{const res=await fetch(base+route,{headers:{'x-claudeos-token':'test-token',...(body?{'content-type':'application/json'}:{})},...(body?{method:'POST',body:JSON.stringify(body)}:{})});return res.json();};
  assert.equal((await fetch(base+'/api/state')).status,403);
  assert.equal((await fetch(base+'/api/prepare',{method:'POST',headers:{origin:'https://evil.test','x-claudeos-token':'test-token'}})).status,403);
  const page=await (await fetch(base+'/')).text();
  assert.match(page,/benchFetch\(p,/);assert.doesNotMatch(page,/benchmark\/benchmark/);
  assert.equal((await api('/api/prepare',{a:'unknown',b:'desktop-claude'})).error,'Pick two contestants.');
  assert.equal((await api('/api/prepare',{a:'desktop-claude',b:'desktop-claude'})).error,'Pick two different contestants.');
  assert.equal((await api('/api/prepare',{a:'claudeos:fixture',b:'desktop-claude'})).ok,true);
  let state=await api('/api/state');assert.equal(state.round.context.brainName,'Lab');
  fs.writeFileSync(path.join(state.round.sides[0].dir,'marker.txt'),'preserve me');
  const result=await api('/api/run',{prompt:'<script>alert(1)</script> Reply OK.',autoSend:false});
  assert.equal(result.ok,true);
  assert.match((await api('/api/prepare',{a:'claudeos-codex:fixture',b:'desktop-codex'})).error,/Stop or finish/);
  await api('/api/stop',{});
  const history=await api('/api/history');assert.equal(history.length,1);assert.equal(history[0].verdict.winner,null);assert.equal(history[0].sides[0].score.pass,false);
  const report=await (await fetch(base+'/report?run='+result.runId)).text();
  assert.match(report,/&lt;script&gt;/);assert.doesNotMatch(report,/<script>alert/);assert.match(report,/preserve me/);
  assert.equal((await api('/api/prepare',{a:'claudeos-codex:fixture',b:'desktop-codex'})).ok,true);
  assert.equal(fs.readFileSync(path.join(lab,'bench','archive',result.runId,'A','marker.txt'),'utf8'),'preserve me');
  bench.close();bench=createBenchmark(options);assert.equal((await api('/api/history')).length,1);
  assert.equal((await fetch(base+'/site/unknown/A/..%2F..%2Fpackage.json')).status,404);
  await api('/api/prepare',{a:'claudeos:fixture',b:'desktop-claude',start:'task:bill-splitter'});
  await api('/api/run',{prompt:'Build the bill splitter. Reply DONE.',autoSend:false});
  state=await api('/api/state');
  const logs=path.join(lab,'claude','projects','fixture');fs.mkdirSync(logs,{recursive:true});
  for (const [i, side] of state.round.sides.entries()) {
    fs.cpSync(path.join(root,'benchmark','tasks','bill-splitter','hidden','reference-site'),side.dir,{recursive:true});
    const rows=[{type:'user',timestamp:new Date().toISOString(),cwd:side.dir,message:{content:side.tag}},
      {type:'assistant',timestamp:new Date(Date.now()+1000+i*100).toISOString(),effort:'medium',message:{id:'reply-'+i,model:'fixture-model',stop_reason:'end_turn',content:[{type:'text',text:'DONE'}],usage:{input_tokens:100,output_tokens:20}}}];
    fs.writeFileSync(path.join(logs,i+'.jsonl'),rows.map(x=>JSON.stringify(x)).join('\n'));
  }
  for (let i=0;i<150;i++) {
    state=await api('/api/state');
    if(state.round.saved && !state.round.grading)break;
    await new Promise(r=>setTimeout(r,300));
  }
  assert.equal(state.round.grading,null);assert.equal(state.round.gradeError,undefined);
  assert.equal(state.round.sides[0].score.pass,true);
  assert.equal(state.round.sides[0].web.F,1);assert.equal(state.round.sides[0].web.R,1);
  const runId=state.round.runId;
  const blind=await api('/api/vote?run='+runId);assert.equal(blind.revealed,null);
  const vote=await api('/api/vote',{runId,slot:'A',note:'Fixture vote'});assert.equal(vote.ok,true);assert.ok(vote.verdict.winner);
  const site=await fetch(base+'/site/'+runId+'/A/');assert.equal(site.status,200);assert.match(site.headers.get('content-security-policy'),/sandbox allow-scripts/);
  const shot=await fetch(base+'/shot/'+runId+'/A/desktop.png');assert.equal(shot.status,200);
  const voted=await api('/api/history');assert.ok(voted.find(r=>r.runId===runId).vote);
  console.log('PASS: fixture logs ? browser checks and screenshots ? blind vote ? persisted verdict. No model calls.');
});

// ---------- any two environments, own windows, project copies, taking turns, repeats ----------
async function bench(t, extra = {}) {
  const lab = fs.mkdtempSync(path.join(os.tmpdir(), 'claudeos-bench-env-'));
  process.env.BENCH_HOME = path.join(lab, 'bench'); process.env.BENCH_DRY = '1'; process.env.BENCH_NO_JUDGE = '1';
  const { createBenchmark } = await import('../benchmark/panel/server.mjs');
  const b = createBenchmark({ kit: path.join(root, 'benchmark'), dataDir: lab, port: 0, token: 'tk', start: async () => {}, stop: async () => {},
    context: () => ({ brainId: 'one', brainName: 'One', mode: '', options: { model: 'sonnet', effort: 'medium', codexModel: 'gpt-x', codexEffort: 'high' } }),
    environments: () => ({ brains: [{ id: 'one', name: 'One', active: true }, { id: 'two', name: 'Two' }], claude: { command: 'claude.exe', args: [], env: {} }, codex: { command: 'codex.exe', args: ['--x'], env: { CODEX_HOME_HINT: '1' } } }), ...extra });
  const server = http.createServer((req, res) => b.handle(req, res, new URL(req.url, 'http://local')));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => { b.close(); server.close(); fs.rmSync(lab, { recursive: true, force: true }); });
  const base = 'http://127.0.0.1:' + server.address().port + '/benchmark';
  const api = async (route, body) => (await fetch(base + route, { headers: { 'x-claudeos-token': 'tk', ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) })).json();
  return { lab, api, live: path.join(lab, 'bench') };
}
function finishedLog(side, i) {
  const logs = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', 'env-fixture'); fs.mkdirSync(logs, { recursive: true });
  const rows = [{ type: 'user', timestamp: new Date().toISOString(), cwd: side.dir, message: { content: side.tag } },
    { type: 'assistant', timestamp: new Date(Date.now() + 500).toISOString(), message: { id: 'r-' + side.tag, model: 'fixture', stop_reason: 'end_turn', content: [{ type: 'text', text: 'DONE' }], usage: { input_tokens: 10 + i, output_tokens: 5 } } }];
  fs.writeFileSync(path.join(logs, side.tag.replace(/\W/g, '_') + '.jsonl'), rows.map(x => JSON.stringify(x)).join('\n'));
}
const until = async (api, ok, tries = 60) => { let s; for (let i = 0; i < tries; i++) { s = await api('/api/state'); if (ok(s)) return s; await new Promise(r => setTimeout(r, 250)); } return s; };

test('every brain and your own Claude Code / Codex setups are offered as contestants', async t => {
  const { api } = await bench(t);
  const ids = (await api('/api/state')).contestants.map(c => c.id);
  assert.deepEqual(ids, ['claudeos:one', 'claudeos:two', 'desktop-claude', 'claudeos-codex:one', 'claudeos-codex:two', 'desktop-codex']);
});

test('each side gets its own copy of the project; the original is never touched', async t => {
  const { api, live } = await bench(t);
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'claudeos-bench-proj-'));
  t.after(() => fs.rmSync(proj, { recursive: true, force: true }));
  fs.writeFileSync(path.join(proj, 'main.txt'), 'original');
  fs.mkdirSync(path.join(proj, 'src')); fs.writeFileSync(path.join(proj, 'src', 'a.js'), 'x');
  fs.mkdirSync(path.join(proj, 'node_modules', 'dep'), { recursive: true }); fs.writeFileSync(path.join(proj, 'node_modules', 'dep', 'i.js'), 'big');
  assert.match((await api('/api/prepare', { a: 'claudeos:one', b: 'desktop-claude', start: 'folder:' + live })).error, /outside/);
  assert.equal((await api('/api/prepare', { a: 'claudeos:one', b: 'desktop-claude', start: 'folder:' + proj })).ok, true);
  const s = await api('/api/state');
  for (const side of s.round.sides) {
    assert.equal(fs.readFileSync(path.join(side.dir, 'src', 'a.js'), 'utf8'), 'x');
    assert.ok(!fs.existsSync(path.join(side.dir, 'node_modules')));
    fs.writeFileSync(path.join(side.dir, 'main.txt'), 'changed by ' + side.id);
  }
  assert.equal(fs.readFileSync(path.join(proj, 'main.txt'), 'utf8'), 'original');
  assert.notEqual(s.round.sides[0].dir, s.round.sides[1].dir);
});

test('the Claude Desktop and Codex sides open with the exact prompt and the shared settings', async t => {
  const { api, live } = await bench(t);
  const prompt = 'Say "hi" & then | stop.\nSecond line with "quotes".';
  await api('/api/prepare', { a: 'desktop-codex', b: 'desktop-claude', settings: { model: 'opus', effort: 'high', mode: 'bypassPermissions', codexModel: 'gpt-y', codexEffort: 'low' } });
  const r = await api('/api/run', { prompt });
  assert.equal(r.ok, true); assert.deepEqual(r.watch, []);
  const a = JSON.parse(fs.readFileSync(path.join(live, 'window-A.json'), 'utf8')), b = JSON.parse(fs.readFileSync(path.join(live, 'window-B.json'), 'utf8'));
  assert.equal(b.command, 'claude.exe');
  assert.deepEqual(b.args.slice(0, 6), ['--model', 'opus', '--effort', 'high', '--permission-mode', 'bypassPermissions']);
  assert.ok(b.args.at(-1).endsWith('\n\n' + prompt)); assert.match(b.args.at(-1), /^Benchmark run .*-B\./);
  assert.equal(a.command, 'codex.exe'); assert.deepEqual(a.env, { CODEX_HOME_HINT: '1' });
  assert.deepEqual(a.args.slice(0, 6), ['--x', '-m', 'gpt-y', '-c', 'model_reasoning_effort="low"', '--dangerously-bypass-approvals-and-sandbox']);
  assert.ok(a.cwd.endsWith('side-A')); assert.ok(b.cwd.endsWith('side-B'));
  await api('/api/stop', {});
});

test('two ClaudeOS brains take turns, and a repeat starts fresh with the other one first', async t => {
  const { api } = await bench(t);
  const p = await api('/api/prepare', { a: 'claudeos:one', b: 'claudeos:two', order: 'together', repeats: 2 });
  assert.equal(p.order, 'sequence');
  const r = await api('/api/run', { prompt: 'Reply DONE.' });
  assert.deepEqual(r.watch, ['A', 'B']);
  let s = await api('/api/state');
  assert.equal(s.round.sides[0].waiting, false); assert.equal(s.round.sides[1].waiting, true);
  finishedLog(s.round.sides[0], 0);
  s = await until(api, x => x.round.sides[1].waiting === false);
  assert.equal(s.round.sides[1].waiting, false, 'the second brain starts once the first has finished');
  finishedLog(s.round.sides[1], 1);
  s = await until(api, x => x.series?.n === 2 && x.round.runId);
  assert.equal(s.series.n, 2); assert.equal(s.series.recorded, 1);
  assert.equal(s.round.sides[0].id, 'B', 'the repeat lets the other side go first');
  assert.equal(s.series.sides.A.rounds, 1); assert.equal(s.series.sides.B.done, 1);
  await api('/api/stop', {});
  assert.equal((await api('/api/state')).series.stopped, true);
});
