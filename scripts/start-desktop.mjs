import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'desktop', 'package.json'));
let cli;
try { cli = require.resolve('electron/cli.js'); }
catch { console.error('Desktop dependencies are missing. Run npm run desktop:setup first.'); process.exit(1); }
const child = spawn(process.execPath, [cli, path.join(root, 'desktop', 'main.cjs'), ...process.argv.slice(2)], {
  stdio: 'inherit', env: { ...process.env, CLAUDEOS_NODE: process.execPath },
});
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
