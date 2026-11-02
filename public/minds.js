// How intelligent an employee is, shown as the brain over their head:
//   size       - the model they think with (their own pick, the skill's, or the Manager's)
//   brightness - the effort they think with
//   meter      - how much their SKILL.md gives them to work with (instructions, structure, examples, files)
//   number     - their rating: how their runs went (finished well, how many)
// Shared by the server (craft, from the SKILL.md) and the page (rating, from the activity log).

const MODEL_TIER = { fable: 1, opus: 0.9, sonnet: 0.7, haiku: 0.45 };
const EFFORT_LEVEL = { minimal: 0.1, low: 0.25, medium: 0.5, high: 0.75, xhigh: 0.9, max: 1 };
const clamp = n => Math.max(0, Math.min(1, n));

// claude model ids and aliases (claude-opus-5-5, opus, opus[1m]) to their family
export function modelFamily(model = '') {
  const m = String(model).toLowerCase();
  return Object.keys(MODEL_TIER).find(f => m.includes(f)) || '';
}

// { engine, model } -> 0..1, the brain's size
export function modelTier({ engine, model } = {}) {
  return engine === 'codex' ? 0.85 : MODEL_TIER[modelFamily(model)] ?? 0.8; // unknown: Claude Code's default
}
// effort -> 0..1, the brain's brightness
export function effortLevel(effort) {
  return EFFORT_LEVEL[String(effort || '').toLowerCase()] ?? 0.6; // unknown: Claude Code's default
}

// runs: [{ status: done | error | stopped | unfinished | working }] -> their rating, 0..1
// A good rate counts more the more runs it is over: a new hire starts low and earns it.
export function rating(runs = []) {
  const ended = runs.filter(r => r.status !== 'working');
  const done = ended.filter(r => r.status === 'done').length;
  const stopped = ended.filter(r => r.status === 'stopped').length;
  const rate = (done + 0.5 * stopped + 1) / (ended.length + 2);
  const experience = 1 - Math.exp(-ended.length / 6);
  return { score: rate * (0.4 + 0.6 * experience), runs: ended.length, done, failed: ended.length - done - stopped };
}

// What a SKILL.md gives its employee. text: the whole file; files: other files in the skill's folder.
export function craftOf(text = '', description = '', files = []) {
  const body = String(text).replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
  const words = (body.match(/[A-Za-z0-9][\w'’-]*/g) || []).length;
  const sections = (body.match(/^#{1,6}\s+\S/gm) || []).length;
  const steps = (body.match(/^\s*(?:[-*+]|\d+[.)])\s+\S/gm) || []).length;
  const examples = Math.floor((body.match(/^\s*```/gm) || []).length / 2);
  const scripts = files.filter(f => /\.(py|m?js|cjs|ts|sh|ps1|bat|cmd|rb|go)$/i.test(f)).length;
  const d = String(description);
  const parts = {
    // says what it does and when to use it
    description: clamp(d.length / 200) * 0.7 + (/\b(use (it |this )?(when|for|whenever)|trigger)/i.test(d) ? 0.3 : 0),
    // enough instructions to work from: grows to ~600 words, a little less past 3,000
    length: words < 40 ? (words / 40) * 0.2 : clamp(0.2 + 0.8 * Math.log(words / 40) / Math.log(15)) - (words > 3000 ? clamp((words - 3000) / 12000) * 0.4 : 0),
    structure: clamp(sections / 5) * 0.5 + clamp(steps / 10) * 0.5,
    examples: clamp(examples / 3) * 0.7 + (/\bexamples?\b/i.test(body) ? 0.3 : 0),
    // scripts, references and assets it brings along
    resources: clamp(files.length / 4) * 0.7 + (scripts ? 0.3 : 0),
  };
  const score = parts.description * 0.2 + parts.length * 0.3 + parts.structure * 0.2 + parts.examples * 0.1 + parts.resources * 0.2;
  return { score: Math.round(score * 1000) / 1000, words, sections, steps, examples, files: files.length, scripts };
}
