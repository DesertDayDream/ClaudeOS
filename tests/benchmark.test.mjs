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
});

test('embedded routes enforce auth, preserve round files, export escaped evidence, and survive restart', async t => {
  const lab = fs.mkdtempSync(path.join(os.tmpdir(),'claudeos-benchmark-test-'));
  process.env.BENCH_HOME = path.join(lab,'bench'); process.env.BENCH_DRY = '1';
  process.env.BENCH_NO_JUDGE = '1'; process.env.CLAUDE_CONFIG_DIR = path.join(lab,'claude');
  const {createBenchmark} = await import('../benchmark/panel/server.mjs');
  const options = {kit:path.join(root,'benchmark'),dataDir:lab,port:0,token:'test-token',context:()=>({brainId:'fixture',brainName:'Lab',mode:'auto'}),start:async()=>{},stop:async()=>{}};
  let bench=createBenchmark(options);
  const server=http.createServer((req,res)=>bench.handle(req,res,new URL(req.url,'http://local')));
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{bench.close();server.close();});
  const base='http://127.0.0.1:'+server.address().port+'/benchmark';
  const api=async(route,body)=>{const res=await fetch(base+route,{headers:{'x-claudeos-token':'test-token',...(body?{'content-type':'application/json'}:{})},...(body?{method:'POST',body:JSON.stringify(body)}:{})});return res.json();};
  assert.equal((await fetch(base+'/api/state')).status,403);
  assert.equal((await fetch(base+'/api/prepare',{method:'POST',headers:{origin:'https://evil.test','x-claudeos-token':'test-token'}})).status,403);
  const page=await (await fetch(base+'/')).text();
  assert.match(page,/benchFetch\(p,/);assert.doesNotMatch(page,/benchmark\/benchmark/);
  assert.equal((await api('/api/prepare',{pair:'unknown'})).error,'Unknown pair.');
  assert.equal((await api('/api/prepare',{pair:'claude'})).ok,true);
  let state=await api('/api/state');assert.equal(state.round.context.brainName,'Lab');
  fs.writeFileSync(path.join(state.round.sides[0].dir,'marker.txt'),'preserve me');
  const result=await api('/api/run',{prompt:'<script>alert(1)</script> Reply OK.',autoSend:false});
  assert.equal(result.ok,true);
  assert.match((await api('/api/prepare',{pair:'codex'})).error,/Stop or finish/);
  await api('/api/stop',{});
  const history=await api('/api/history');assert.equal(history.length,1);assert.equal(history[0].verdict.winner,null);assert.equal(history[0].sides[0].score.pass,false);
  const report=await (await fetch(base+'/report?run='+result.runId)).text();
  assert.match(report,/&lt;script&gt;/);assert.doesNotMatch(report,/<script>alert/);assert.match(report,/preserve me/);
  assert.equal((await api('/api/prepare',{pair:'codex'})).ok,true);
  assert.equal(fs.readFileSync(path.join(lab,'bench','archive',result.runId,'claudeos-claude','marker.txt'),'utf8'),'preserve me');
  bench.close();bench=createBenchmark(options);assert.equal((await api('/api/history')).length,1);
  assert.equal((await fetch(base+'/site/unknown/A/..%2F..%2Fpackage.json')).status,404);
  await api('/api/prepare',{pair:'claude',template:'task:bill-splitter'});
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
