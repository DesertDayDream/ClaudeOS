// Turns an AI Bench task (tasks/<id>: prompt.md, checks.json, hidden/) into a Harbor task folder.
// One source of truth: the Harbor copy is generated for each job and never edited by hand.
import fs from 'node:fs';
import path from 'node:path';
// kit: the benchmark folder (benchmark/ in the source, its extracted copy in the packaged app)
export function buildHarborTask(task, outDir, kit) {
  const dir = path.join(outDir, task.id);
  fs.rmSync(dir, { recursive: true, force: true });
  for (const d of ['environment', 'tests', 'solution']) fs.mkdirSync(path.join(dir, d), { recursive: true });
  const write = (rel, text) => fs.writeFileSync(path.join(dir, rel), text.replace(/\r\n/g, '\n'));
  write('task.toml', `schema_version = "1.4"
artifacts = [{ source = "/app", destination = "app", exclude = ["node_modules"] }]

[task]
name = "claudeos/${task.id}"
version = "1.0.0"
description = "AI Bench task ${task.id}"

[verifier]
timeout_sec = 300.0
environment_mode = "shared"

[agent]
timeout_sec = 2400.0

[environment]
network_mode = "public"
build_timeout_sec = 900.0
os = "linux"
`);
  write('instruction.md', task.prompt + '\n');
  // node is what the verifier needs; Harbor's Claude Code agent installs its own dependencies
  write('environment/Dockerfile', 'FROM node:22-bookworm-slim\nWORKDIR /app\n');
  write('tests/test.sh', '#!/bin/bash\nnode /tests/check.mjs /app /logs/verifier\n');
  fs.copyFileSync(path.join(kit, 'harbor', 'verifier', 'check.mjs'), path.join(dir, 'tests', 'check.mjs'));
  fs.copyFileSync(path.join(task.dir, 'checks.json'), path.join(dir, 'tests', 'checks.json'));
  // the oracle (a known-good answer) proves the pipeline works without spending any model usage
  const ref = path.join(task.dir, 'hidden', 'reference-site');
  if (fs.existsSync(ref)) {
    fs.cpSync(ref, path.join(dir, 'solution', 'site'), { recursive: true });
    write('solution/solve.sh', '#!/bin/bash\ncp -r /solution/site/. /app/\n');
  }
  return dir;
}
