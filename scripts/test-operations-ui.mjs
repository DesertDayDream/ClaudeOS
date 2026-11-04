import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const root=path.resolve(import.meta.dirname,'..');
const require=createRequire(path.join(process.argv[2] || root,'benchmark/package.json'));
const {chromium}=require('playwright-core');
const home=fs.mkdtempSync(path.join(os.tmpdir(),'claudeos-operations-ui-'));
const data=path.join(home,'data'),brain=path.join(home,'brain');
fs.mkdirSync(data); fs.mkdirSync(path.join(brain,'.claude/skills/builder'),{recursive:true});
fs.writeFileSync(path.join(brain,'CLAUDE.md'),'# Studio foundations\nMaster operations lab.');
fs.writeFileSync(path.join(brain,'.claude/skills/builder/SKILL.md'),'---\nname: builder\ndescription: Build interfaces\n---\nYou must not skip validation; run the relevant checks.');
fs.writeFileSync(path.join(data,'brains.json'),JSON.stringify({active:'lab',brains:[{id:'lab',name:'Operations lab',path:brain}]}));
const child=spawn(process.execPath,['server.mjs'],{cwd:root,windowsHide:true,env:{...process.env,PORT:'4800',ARTIFACT_PORT:'4810',CLAUDEOS_HOME:data,CLAUDE_CONFIG_DIR:path.join(home,'claude'),CODEX_HOME:path.join(home,'codex'),CLAUDEOS_NO_OPEN:'1'}});
let logs='';child.stdout.on('data',d=>logs+=d);child.stderr.on('data',d=>logs+=d);
let browser;
try {
 for(let i=0;i<100;i++){try{const r=await fetch('http://localhost:4800/api/state');if(r.ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
 browser=await chromium.launch({channel:'msedge',headless:true});
 const page=await browser.newPage({viewport:{width:1440,height:900}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://localhost:4800');
 await page.evaluate(async()=>{const r=await fetch('/api/brains/switch',{method:'POST',headers:{'content-type':'application/json','x-claudeos-token':window.CLAUDEOS_TOKEN},body:JSON.stringify({id:'lab'})});if(!r.ok)throw Error('switch failed');});
 await page.getByRole('button',{name:'Skip for now'}).click();
 await page.waitForFunction(()=>document.querySelector('#opsRoster').textContent.includes('builder'));
 assert.match(await page.locator('#opsFoundations').textContent(),/Master operations lab/);
 assert.match(await page.locator('#opsRoster').textContent(),/must not skip validation/);
 fs.appendFileSync(path.join(brain,'CLAUDE.md'),'\nUpdated master instructions.');
 await page.waitForFunction(()=>document.querySelector('#opsFoundations').textContent.includes('Updated master instructions.'));
 fs.appendFileSync(path.join(brain,'.claude/skills/builder/SKILL.md'),'\nNever ignore module boundaries; use small components.');
 await page.waitForFunction(()=>document.querySelector('#opsRoster').textContent.includes('Never ignore module boundaries')); 
 const bounds=await page.locator('#scene').boundingBox(); assert.equal(bounds.x,265); assert.equal(bounds.width,890);
 await page.locator('#opsChatToggle').click(); assert.equal(await page.locator('aside').isVisible(),true);
 await page.locator('#opsChatToggle').click(); assert.equal(await page.locator('aside').isVisible(),false);
 await page.evaluate(async()=>{
   const {events}=await import('/events.js');
   events.dispatchEvent(new MessageEvent('chat',{data:JSON.stringify({kind:'stdout',skillId:'builder',text:'Fixture headless output',ts:Date.now()})}));
   events.dispatchEvent(new MessageEvent('manager',{data:JSON.stringify({inbox:[],files:[],briefs:[{id:'test',title:'Lab brief',tasks:[{id:'test',employee:'builder',name:'Builder',task:'Validate interface',status:'working',after:[]}]}]})}));
 });
 await page.waitForFunction(()=>document.querySelector('#opsTicker').textContent.includes('Fixture headless output'));
 assert.match(await page.locator('#opsQueue').textContent(),/Validate interface/);
 await page.screenshot({path:path.join(root,'operations-desktop.png')});
 await page.setViewportSize({width:390,height:844});
 await page.waitForTimeout(200); const mobile=await page.locator('#scene').boundingBox();assert.equal(mobile.width,390);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 await page.screenshot({path:path.join(root,'operations-mobile.png'),fullPage:true});
 assert.deepEqual(errors,[]);console.log(JSON.stringify({ok:true,home,desktop:bounds,mobile,errors}));
}finally{await browser?.close();child.kill();}

