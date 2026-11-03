// Browser grading runs from real files so Playwright can find its own resources in the desktop package.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const kit = path.join(root, 'benchmark');
if (!fs.existsSync(path.join(kit, 'node_modules', 'playwright-core'))) {
  const cli = process.env.npm_execpath;
  if (!cli) throw new Error('Run npm run desktop:finish to install benchmark dependencies.');
  execFileSync(process.execPath, [cli, 'ci', '--omit=dev', '--prefix', kit], {stdio:'inherit'});
}
for (const file of ['grader/web.mjs', 'tasks/bill-splitter/hidden/behaviour.mjs', 'tasks/bill-splitter/hidden/robust.mjs']) {
  await build({entryPoints:[path.join(kit,file)], outfile:path.join(kit,file.replace(/\.mjs$/,'.cjs')),
    bundle:true, packages:'external', platform:'node', format:'cjs', target:'node24',
    define:{'import.meta.url':'__benchmarkUrl'}, banner:{js:'const __benchmarkUrl = require("node:url").pathToFileURL(__filename).href;'}});
}
