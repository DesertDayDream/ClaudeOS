import fs from 'node:fs';

export const REVIEW_HEADING = '## Dynamic Performance Review Corrections & Constraints';
export const LEGACY_REVIEW_HEADING = /## (?:Performance Corrections & Constraints|Performance Review Corrections)(?=\r?\n|$)/g;

export function atomicWrite(file, text) {
  const pending = file + '.' + process.pid + '.tmp';
  try { fs.writeFileSync(pending, text); fs.renameSync(pending, file); }
  finally { try { fs.unlinkSync(pending); } catch (err) { if (err.code !== 'ENOENT') throw err; } }
}

// Only structured, attributable technical findings become instructions. Scores and praise do not.
export function concreteCorrections(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 8).flatMap(c => {
    if (!c || typeof c !== 'object') return [];
    const clean = s => typeof s === 'string' ? s.replace(/[\r\n]+/g, ' ').trim().slice(0, 600) : '';
    const mistake = clean(c.mistake), rule = clean(c.rule), employee = clean(c.employee);
    if (mistake.length < 15 || rule.length < 15 || !/\b(must not|never|do not)\b/i.test(rule)) return [];
    return [{ employee, mistake, rule, ...(clean(c.task) ? { task: clean(c.task) } : {}) }];
  });
}

export function reviewBody(body, task, corrections) {
  const lines = concreteCorrections(corrections).map(c => `- From Task ${String(task).replace(/[\r\n]/g, ' ')}: ${c.mistake} NEW RULE: ${c.rule}`);
  if (!lines.length) return body;
  body = body.replace(LEGACY_REVIEW_HEADING, REVIEW_HEADING);
  const fresh = [...new Set(lines)].filter(line => !body.includes(line));
  if (!fresh.length) return body;
  const at = body.indexOf(REVIEW_HEADING);
  if (at < 0) return body.trimEnd() + '\n\n' + REVIEW_HEADING + '\n\n' + fresh.join('\n') + '\n';
  const rest = body.slice(at + REVIEW_HEADING.length);
  const next = rest.search(/\r?\n## /);
  const end = next < 0 ? body.length : at + REVIEW_HEADING.length + next;
  return pruneRules(body.slice(0, end).trimEnd() + '\n' + fresh.join('\n') + '\n' + body.slice(end));
}

// Keep the rules short and current: the same rule learned twice is kept once (the newest), and past
// MAX_RULES the oldest retire, so the instructions don't fill up with stale or clashing rules.
export const MAX_RULES = 12;
const ruleOf = line => (line.split('NEW RULE:')[1] || line).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
export function pruneRules(body) {
  const at = body.indexOf(REVIEW_HEADING);
  if (at < 0) return body;
  const next = body.slice(at + REVIEW_HEADING.length).search(/\r?\n## /);
  const end = next < 0 ? body.length : at + REVIEW_HEADING.length + next;
  const lines = body.slice(at + REVIEW_HEADING.length, end).split(/\r?\n/);
  const rules = lines.filter(l => l.startsWith('- From Task'));
  const seen = new Set();
  const keep = [...rules].reverse().filter(l => { const k = ruleOf(l); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, MAX_RULES).reverse();
  if (keep.length === rules.length) return body;
  const other = lines.filter(l => !l.startsWith('- From Task') && l.trim());
  return body.slice(0, at) + REVIEW_HEADING + '\n\n' + [...other, ...keep].join('\n') + '\n' + body.slice(end);
}

export function applyReview(employee, task, corrections) {
  const before = fs.readFileSync(employee.file, 'utf8');
  const after = reviewBody(before, task, corrections);
  if (before !== after) atomicWrite(employee.file, after);
  return before !== after;
}
