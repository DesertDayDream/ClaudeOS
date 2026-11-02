// Harmless real-model approval probe in a temporary lab. Never grants a request
// unless it is the expected marker-writing command in that lab.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { runCodexTurn } from '../codex.mjs';
const lab = fs.mkdtempSync(path.join(os.tmpdir(), 'claudeos-codex-approval-'));
const marker = 'claudeos-approval-probe.txt';
const command = `node -e "require('node:fs').writeFileSync('${marker}','approved')"`;
let approvalCount = 0, thread;
const events = [];
const run = runCodexTurn({ cwd: lab, prompt: `This is an integration test. Use your shell tool to run exactly this single command in the current working directory: ${command}\nDo not use other tools, read other files, or use another way to write the marker. If permission is denied, stop and report that. After success reply APPROVAL_OK.`,
  mode: '', onThread: id => { thread = id; }, onEvent: event => { events.push(event); },
  onApproval: async request => {
    approvalCount++;
    const allowed = request.method === 'item/commandExecution/requestApproval' && path.resolve(request.cwd || '') === lab && request.command?.includes(marker) && request.command?.includes('writeFileSync');
    console.log(`Approval ${approvalCount}: ${allowed ? 'Allow once (lab marker only)' : 'Deny unexpected request'}`);
    return allowed ? 'accept' : 'decline';
  },
});
const timeout = setTimeout(() => run.stop(), 90000);
try {
  const result = await run.done; clearTimeout(timeout);
  assert.equal(result.error, null, result.error);
  assert.ok(approvalCount > 0, 'Real App Server issued an approval request');
  assert.equal(fs.readFileSync(path.join(lab, marker), 'utf8'), 'approved');
  assert.ok(thread, 'Thread can be resumed');
  console.log(`PASS: real command approval and marker creation. Lab: ${lab}`);
  const resumed = runCodexTurn({ cwd: lab, thread, prompt: 'Reply RESUME_OK. Do not run any tools.', mode: 'plan', onEvent: event => events.push(event) });
  const resumedTimeout = setTimeout(() => resumed.stop(), 90000);
  const followup = await resumed.done; clearTimeout(resumedTimeout);
  assert.equal(followup.error, null, followup.error);
  assert.ok(events.some(event => event.type === 'item.completed' && event.item?.type === 'agent_message' && event.item.text?.includes('RESUME_OK')));
  console.log('PASS: existing thread resumed with read-only mode.');
} catch (error) {
  clearTimeout(timeout);
  for (const event of events) if (event.type === 'item.completed') console.error(JSON.stringify(event.item));
  console.error(error.stack); process.exitCode = 1;
}
