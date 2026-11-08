// Shared selection policy for Managers, employees and their specialist calls.
import { claudeInstalled, codexInstalled, defaultEngine } from './agents.mjs';
import { codexModels } from './codex.mjs';

export const MODEL_SELECTION_SCHEMA = { type: 'object', properties: {
  complexity: { type: 'string', enum: ['simple', 'standard', 'complex'], description: 'Simple: bounded extraction/formatting. Standard: ordinary implementation or writing. Complex: architecture, difficult debugging, ambiguous reasoning.' },
  engine: { type: 'string', enum: ['auto', 'claude', 'codex'], description: 'Default auto follows the caller. Prefer another provider only for a concrete task/tool reason.' },
  model: { type: 'string', description: 'Optional exact id from model_catalog. Leave empty to select by complexity.' },
  reason: { type: 'string', description: 'Why this choice fits this task; cite required tools, complexity or measured results, not brand stereotypes.' },
  requiredEngine: { type: 'string', enum: ['claude', 'codex'], description: 'Only for an explicit user requirement or a verified provider-only tool. Prevents cross-provider fallback.' },
  fallback: { type: 'boolean', description: 'Default true: try the other installed provider once on a usage-limit error. Set false for an explicit exact-model requirement.' },
} };

export const MODEL_GUIDANCE = `Models (applies to skills too):
- Keep work in this session, loading skills here. post_brief, run_model_task and side sessions only when the user asks for separate, parallel or background work. post_brief queues turns in this same warm chat; annotate complexity and a short reason. run_model_task runs a bounded subtask and returns its answer: give it full context and exact file ownership. Never delegate tiny steps or let two runs edit the same files.
- Simple tasks: smaller model, lower effort. Standard: balanced. Complex (architecture, hard debugging, ambiguous multi-step): stronger model, higher effort. Check model_catalog before asking for another model. Verify against the task's acceptance criteria; escalate only after a concrete failure.
- Auto follows the caller's provider; explicit user requirements win; do not invent universal rankings of Claude versus Codex. requiredEngine only for a verified provider-only need, fallback:false for an exact-model requirement. Keep required tools on every delegation.
- Never launch claude/codex directly to bypass this routing. On fallback, check current files and earlier actions first; never blindly repeat writes or external actions. Specialist runs cannot delegate.`;

export function modelCatalog() {
  return { providers: { claude: { installed: claudeInstalled(), models: ['haiku', 'sonnet', 'opus', 'fable'] },
    codex: { installed: codexInstalled(), models: codexModels().filter(m => !m.inferred), defaultWhenEmpty: 'Let Codex choose its default; no cached catalog is available.' } }, quota: 'Unknown until a request succeeds or a usage-limit error is returned.' };
}

export function cleanSelection(s = {}) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return { error: 'selection must be an object.' };
  for (const [key, values] of [['complexity', ['simple', 'standard', 'complex']], ['engine', ['auto', 'claude', 'codex']], ['requiredEngine', ['claude', 'codex']]]) {
    if (s[key] !== undefined && !values.includes(s[key])) return { error: `Invalid selection.${key}.` };
  }
  if (s.fallback !== undefined && typeof s.fallback !== 'boolean') return { error: 'selection.fallback must be boolean.' };
  if (s.model !== undefined && (typeof s.model !== 'string' || !/^[\w.:[\]-]{1,100}$/.test(s.model))) return { error: 'Invalid selection.model.' };
  if (s.requiredEngine && s.engine && s.engine !== 'auto' && s.engine !== s.requiredEngine) return { error: 'selection.engine conflicts with requiredEngine.' };
  return { selection: { complexity: s.complexity || 'standard', engine: s.engine || 'auto', reason: String(s.reason || '').slice(0, 500),
    ...(s.model ? { model: s.model } : {}), ...(s.requiredEngine ? { requiredEngine: s.requiredEngine } : {}), fallback: s.fallback !== false } };
}

export function selectModel(selection = {}, caller = {}, catalog = modelCatalog()) {
  const checked = cleanSelection(selection);
  if (checked.error) return checked;
  const s = checked.selection;
  const eng = s.requiredEngine || (s.engine === 'auto' ? caller.engine || defaultEngine() : s.engine);
  let engine = eng;
  if (!catalog.providers[engine]?.installed) {
    const other = engine === 'claude' ? 'codex' : 'claude';
    if (s.requiredEngine || !s.fallback || s.model || !catalog.providers[other]?.installed) return { error: `${engine} is required or no compatible installed fallback is available.` };
    engine = other;
  }
  const models = catalog.providers[engine].models;
  let model, effort;
  if (engine === 'claude') {
    model = s.model || ({ simple: 'haiku', standard: 'sonnet', complex: 'opus' })[s.complexity];
    if (!models.includes(model)) return { error: `Unknown Claude model: ${model}. Use model_catalog.` };
    effort = { simple: 'low', standard: 'medium', complex: 'high' }[s.complexity];
  } else {
    model = s.model || (models.some(m => m.id === caller.codexModel) ? caller.codexModel : models[0]?.id);
    const found = models.find(m => m.id === model);
    if (!found && (s.model || models.length)) return { error: `Unknown Codex model: ${model || '(none)'}. Use model_catalog.` };
    const desired = { simple: 'low', standard: 'medium', complex: 'high' }[s.complexity];
    effort = found?.efforts?.includes(desired) ? desired : found?.efforts?.[0] || undefined;
  }
  return { engine, model, effort, selection: s, reason: s.reason || `${s.complexity} task; ${engine === eng ? 'caller/provider preference' : `${eng} is not installed`}.` };
}

// Quota errors only. Auth, denied permissions and ordinary task errors must not trigger retries.
export const usageLimited = error => /(?:usage[_ -]?limit(?:[_ -]?(?:reached|exceeded))?|rate[_ -]?limit(?:[_ -]?(?:reached|exceeded))?|quota[_ -]?(?:exceeded|exhausted)|out of (?:usage|credits)|you(?:'ve| have) (?:hit|reached) your (?:[\w-]+\s+){0,4}limit|too many requests)/i.test(String(error || ''));

export function fallbackModel(pick, caller, catalog) {
  if (!pick.selection.fallback || pick.selection.requiredEngine) return null;
  const other = pick.engine === 'claude' ? 'codex' : 'claude';
  const next = selectModel({ ...pick.selection, engine: other, model: undefined, fallback: false }, caller, catalog);
  return next.error ? null : next;
}
