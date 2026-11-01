// ClaudeOS.exe entry point. The one file runs the app, and also the pieces Claude Code starts on
// its own: the activity hook, the approval server and the memory server (by first argument).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sub = process.argv[2];

async function run() {
  if (sub === 'claude-os-hook') {
    process.argv.splice(2, 1); // the hook reads the data folder from argv[2]
    await import('./hooks/claude-os-hook.mjs');
  } else if (sub === 'approval-mcp') {
    await import('./approval-mcp.mjs');
  } else if (sub === 'computer-mcp') {
    await import('./computer-mcp.mjs');
  } else if (sub === 'memory-server') {
    // inside the exe its own "am I the program?" check always says yes; make it say no, and start it here once
    process.argv[1] = '';
    const { main } = await import('@modelcontextprotocol/server-memory/dist/index.js');
    await main();
  } else {
    // the app: no console window, so keep a log next to the user's data
    const data = path.resolve(process.env.CLAUDEOS_HOME || path.join(os.homedir(), '.claudeos'));
    fs.mkdirSync(data, { recursive: true });
    const log = fs.createWriteStream(path.join(data, 'claudeos.log'), { flags: 'w' });
    const write = (...a) => log.write(a.map(x => (x instanceof Error ? x.stack : typeof x === 'string' ? x : JSON.stringify(x))).join(' ') + '\n');
    console.log = console.error = write;
    process.on('uncaughtException', err => { write('crash:', err); setTimeout(() => process.exit(1), 100); });
    process.argv.push('--tray');
    // tests set CLAUDEOS_NO_OPEN; Windows starting us at sign-in passes --background (tray only)
    if (!process.env.CLAUDEOS_NO_OPEN && !process.argv.includes('--background')) process.argv.push('--open');
    await import('./server.mjs');
  }
}
run().catch(err => { console.error(err); process.exit(1); });
