// Linked-brain work uses that brain's existing chat queue and native session.
// Keep the target brain's context and permissions; never inject it into the caller.
export function runHandoff({ task, runner, onExit = () => {} }) {
  if (!runner) return { done: Promise.resolve({ error: 'The warm chat runner is unavailable.' }).finally(onExit), stop() {} };
  const run = runner({ prompt: `${task}\n\nThis is a linked-brain handoff. Do not call ask_brain recursively. End with a short report.` });
  return { done: run.done.finally(onExit), stop: () => run.stop() };
}
