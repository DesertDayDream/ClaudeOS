import test from 'node:test';
import assert from 'node:assert/strict';
import { skillEntry, codexSkill, toolSummary } from '../chat.mjs';

const crew = [
  { id: 'researcher', skill: 'researcher', name: 'Juno 2', invokeAs: 'researcher' },
  { id: 'modder', skill: 'modder', name: 'Rex', invokeAs: 'universal-modder:modder' },
];

test('a team skill shows the employee working on it', () => {
  const e = skillEntry('researcher', crew);
  assert.deepEqual(e.skill, { name: 'researcher', who: 'Juno 2', role: 'researcher' });
  assert.match(e.text, /Juno 2 \(researcher\) is working/);
});

test('plugin-prefixed and bare names both find the employee', () => {
  assert.equal(skillEntry('universal-modder:modder', crew).skill.who, 'Rex');
  assert.equal(skillEntry('modder', crew).skill.who, 'Rex');
  assert.equal(skillEntry('/researcher', crew).skill.who, 'Juno 2');
});

test('other skills show as plain skills', () => {
  const e = skillEntry('dataviz', crew);
  assert.equal(e.skill.who, null);
  assert.equal(e.text, 'Using the dataviz skill');
  assert.equal(skillEntry('', []).skill.name, 'a skill');
});

test('Codex reading a SKILL.md counts as using that skill', () => {
  assert.equal(codexSkill('Get-Content "C:\\Brain\\.claude\\skills\\researcher\\SKILL.md"'), 'researcher');
  assert.equal(codexSkill('cat /home/u/.codex/skills/dataviz/SKILL.md'), 'dataviz');
  assert.equal(codexSkill('cat README.md'), null);
});

test('the Skill tool no longer reads as a hand-off', () => {
  assert.equal(toolSummary('Skill', { skill: 'researcher' }), 'Using the researcher skill');
});
