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
  return body.slice(0, end).trimEnd() + '\n' + fresh.join('\n') + '\n' + body.slice(end);
}

export function applyReview(employee, task, corrections) {
  const before = fs.readFileSync(employee.file, 'utf8');
  const after = reviewBody(before, task, corrections);
  if (before !== after) atomicWrite(employee.file, after);
  return before !== after;
}
