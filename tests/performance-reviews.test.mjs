import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGrades, parseGrade } from '../grades.mjs';
import { reviewBody } from '../performance-reviews.mjs';
const finding = { employee: 'builder', mistake: 'The assembly used one monolithic script for all modules.', rule: 'You must not build monolithic assembly scripts; use modular architecture.' };
test('review section preserves frontmatter and later sections and deduplicates findings', () => {
  const original = '---\nname: builder\n---\nBody\n\n## Performance Review Corrections\n\n## Tools\nKeep this.\n';
  const once = reviewBody(original, 'b:1', [finding]);
  assert.equal(reviewBody(once, 'b:1', [finding]), once);
  assert.ok(once.startsWith('---\nname: builder\n---'));
  assert.ok(once.indexOf('NEW RULE:') < once.indexOf('## Tools'));
  assert.equal(reviewBody(original, 'b:1', [{ mistake: 'bad', rule: 'good' }]), original);
});
test('grade output updates only the attributed employee and survives restart without duplication', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reviews-lab-'));
  try {
    const file = path.join(dir, 'grades.json');
    const employees = ['builder', 'writer'].map(name => ({ name, file: path.join(dir, `${name}.md`) }));
    for (const e of employees) fs.writeFileSync(e.file, `---\nname: ${e.name}\n---\nInstructions.\n`);
    const at = Date.now() - 120000;
    const activity = [{ session:'brief-one-task', type:'task', ts:at, prompt:'Build modules' }, {session:'brief-one-task', type:'skill', skill:'builder', ts:at+1}, {session:'brief-one-task', type:'stop', outcome:'done', ts:at+2, result:'Used one monolithic script.'}];
    const grade = parseGrade(JSON.stringify({grade:2, why:finding.mistake, corrections:[finding]}));
    await createGrades({file, ask:async () => grade}).tick(activity, employees);
    const text = fs.readFileSync(employees[0].file, 'utf8');
    assert.match(text, /From Task brief-one-task:/);
    assert.match(text, /NEW RULE: You must not/);
    assert.doesNotMatch(fs.readFileSync(employees[1].file, 'utf8'), /Corrections/);
    await createGrades({file, ask:async () => { throw Error('already graded'); }}).tick(activity, employees);
    assert.equal(fs.readFileSync(employees[0].file, 'utf8'), text);
  } finally { fs.rmSync(dir, {recursive:true, force:true}); }
});

test('coaching preserves learned corrections and adds only findings from this employee tasks', async () => {
  const { createCoaching } = await import('../coaching.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coach-review-lab-'));
  try {
    const file = path.join(dir, 'SKILL.md');
    fs.writeFileSync(file, reviewBody('Original body.', 'old:1', [finding]));
    const employee = {id:'builder', name:'builder', file, read:()=>({name:'builder', body:fs.readFileSync(file,'utf8')}), write:({body})=>fs.writeFileSync(file,body)};
    const c = createCoaching({file:path.join(dir,'history.json'), backupDir:path.join(dir,'backups'), coach:async()=>({body:'Rewritten.',summary:'Corrected technical mistake.',weak:1,corrections:[{...finding,task:'new:1'},{...finding,task:'wrong:1'}]})});
    const result = await c.run(employee, [{key:'new:1',skillNames:['builder']}], {});
    assert.equal(result.ok,true);
    const text = fs.readFileSync(file,'utf8');
    assert.match(text,/From Task old:1/);assert.match(text,/From Task new:1/);assert.doesNotMatch(text,/From Task wrong:1/);
    assert.equal(text.match(/## Dynamic Performance Review Corrections & Constraints/g).length,1);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
