// Turns checks + metrics + judge + your vote into one result per contestant and a round verdict.
// Gates first (fail any = FAIL, no ranking), then Quality 0..100 = behaviour (65) + robustness (10) + look (25),
// then efficiency (time, then fresh tokens) only decides between passing runs within `tieMargin` quality points.

// "reply with exactly: DONE", "then reply OK.", "reply with OK" -> the exact text expected
export function replyRule(prompt, checks) {
  if (checks?.reply) return checks.reply;
  const m = /\breply(?:\s+with)?(?:\s+exactly)?\s*[:\-]?\s*["“'`]?([^\s"”'`.,!]+(?:\s[^\s"”'`.,!]+){0,3}?)["”'`]?[.!]?\s*$/im.exec(String(prompt || ''));
  return m ? { kind: 'exact', value: m[1] } : null;
}
export function replyOk(rule, reply) {
  if (!rule) return null;
  const r = String(reply ?? '').trim();
  if (rule.kind === 'regex') return new RegExp(rule.pattern).test(r);
  if (rule.kind === 'contains') return r.includes(rule.value);
  return r === rule.value;
}

// look share for one side: your vote wins over the AI judge
export function lookScore(sideId, judge, vote) {
  const pick = vote?.pick || null; // a contestant id, 'tie' or 'bad' (both bad)
  if (pick) return { J: pick === 'tie' ? 0.5 : pick === 'bad' ? 0 : pick === sideId ? 1 : 0, by: 'you' };
  if (judge?.winner) return { J: judge.winner === 'tie' ? 0.5 : judge.winner === sideId ? 1 : 0, by: judge.engine + ' judge' };
  return { J: null, by: null };
}

// side: { id, metrics, web, grade }, round: { prompt, task (loaded or null), judge, vote }
export function scoreSide(side, round) {
  const checks = round.task?.checks;
  const rule = replyRule(round.prompt, checks);
  const gates = [
    {id: 'session log found', ok: !!side.metrics?.logFile},
    {id: 'run completed', ok: side.metrics?.status === 'done'},
    {id: 'correct working folder', ok: side.metrics?.cwdOk === true}
  ];
  const rOk = replyOk(rule, side.metrics?.reply);
  if (rOk !== null) gates.push({ id: `reply is exactly "${rule.value ?? rule.pattern}"`, ok: rOk, note: rOk ? '' : `replied: ${JSON.stringify(String(side.metrics?.reply ?? '').trim().slice(0, 80))}` });
  const outside = side.metrics?.outsideWrites || [];
  gates.push({ id: 'no outside writes observed in supported tool logs', ok: outside.length === 0, note: outside.slice(0, 3).join(', ') });
  if (side.web) gates.push(...side.web.gates);
  const pass = gates.every(g => g.ok);
  let quality = null, parts = null;
  if (side.web) {
    const w = checks, look = lookScore(side.id, round.judge, round.vote);
    const J = look.J ?? 0.5; // not judged yet: neutral
    parts = { behaviour: w.behaviour.weight * side.web.F, robust: w.robust.weight * side.web.R, look: w.judge.weight * J, lookBy: look.by || 'pending' };
    quality = Math.round(parts.behaviour + parts.robust + parts.look);
  } else if (side.grade?.correct != null) quality = side.grade.correct;
  return { pass, gates, quality, parts, failed: gates.filter(g => !g.ok).map(g => g.id) };
}

// sides: [{ id, name, metrics, score }]. Who did better, and why.
export function verdict(sides, tieMargin = 5) {
  const ok = sides.filter(s => s.score.pass);
  if (!ok.length) return { winner: null, why: 'Both failed a must-pass check.' };
  if (ok.length === 1) return { winner: ok[0].id, why: `${ok[0].name} is the only one that passed every must-pass check.` };
  const [a, b] = ok;
  if (a.metrics?.model !== b.metrics?.model || a.metrics?.effort !== b.metrics?.effort) return {winner:null, why:'Models or effort settings differ. Match both apps before comparing efficiency.'};
  if (a.score.quality == null || b.score.quality == null) return {winner:null, why:'Quality has not been measured for this custom prompt. Time and token usage are descriptive only.'};
  const qa = a.score.quality, qb = b.score.quality;
  if (qa != null && qb != null && Math.abs(qa - qb) > tieMargin) { const w = qa > qb ? a : b; return { winner: w.id, why: `${w.name} scored higher on quality (${Math.max(qa, qb)} vs ${Math.min(qa, qb)}).` }; }
  const t = s => s.metrics?.elapsedMs ?? Infinity, f = s => s.metrics?.tokens?.fresh ?? Infinity;
  const same = qa == null ? 'Both passed' : `Quality within ${tieMargin} points (${qa} vs ${qb})`;
  if (Math.abs(t(a) - t(b)) > 0.1 * Math.max(t(a), t(b))) { const w = t(a) < t(b) ? a : b; return { winner: w.id, why: `${same}; ${w.name} was faster.` }; }
  if (f(a) !== f(b)) { const w = f(a) < f(b) ? a : b; return { winner: w.id, why: `${same} and similar time; ${w.name} used fewer fresh tokens.` }; }
  return { winner: 'tie', why: `${same}, similar time and tokens.` };
}
