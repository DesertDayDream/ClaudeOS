// Where ClaudeOS runs from: the app folder (`node server.mjs`), or ClaudeOS.exe, one file with
// Node, the page, the templates, the hook and the memory server inside (see scripts/build-exe.mjs).
// Everything that differs between the two lives here.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

let sea = null;
try { sea = createRequire(import.meta.url)('node:sea'); } catch { /* Node without single-executable support */ }
export const IS_EXE = !!sea?.isSea?.();
const EXE = process.execPath;
export const ROOT = IS_EXE ? path.dirname(EXE) : path.dirname(fileURLToPath(import.meta.url));
const q = p => `"${p.replace(/\\/g, '/')}"`;

// A file the exe carries inside it, or null.
export function asset(name) {
  if (!IS_EXE) return null;
  try { return Buffer.from(sea.getAsset(name)); } catch { return null; }
}

// How to start a helper: the exe runs it by name, the app folder runs its .mjs file.
export function helper(name) {
  return IS_EXE ? { command: EXE, args: [name] } : { command: process.execPath, args: [path.join(ROOT, `${name}.mjs`)] };
}

// The official memory MCP server for one brain file. The exe has it built in, so no Node is needed.
export function memoryServer(file) {
  const env = { MEMORY_FILE_PATH: file.replace(/\\/g, '/') };
  return IS_EXE ? { command: EXE, args: ['memory-server'], env } : { command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'], env };
}
export const isOurMemoryServer = cfg => cfg?.args?.[0] === 'memory-server' && /claudeos[^\\/]*\.exe$/i.test(cfg.command || '');

// The command each brain's hooks run. It names the data folder so the log lands in the right place,
// and always contains "claude-os-hook" so ClaudeOS can find and re-point its own hooks.
export function hookCommand(dataDir) {
  return IS_EXE ? `${q(EXE)} claude-os-hook ${q(dataDir)}` : `node ${q(path.join(ROOT, 'hooks', 'claude-os-hook.mjs'))} ${q(dataDir)}`;
}

// Brain templates. The exe unpacks its copy into the data folder once per build.
export function templatesDir(dataDir) {
  if (!IS_EXE) return path.join(ROOT, 'templates');
  const manifest = JSON.parse(asset('manifest.json').toString('utf8'));
  const dir = path.join(dataDir, 'app', `templates-${manifest.build}`);
  if (!fs.existsSync(path.join(dir, '.complete'))) {
    for (const rel of manifest.templates) {
      const to = path.join(dir, rel);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.writeFileSync(to, asset(`templates/${rel}`));
    }
    fs.writeFileSync(path.join(dir, '.complete'), '');
  }
  return dir;
}

// node-pty, the real console behind the Terminal tab. It has native parts (ConPTY), so the exe
// carries its files and unpacks them into the data folder once per build; the app folder loads it
// from node_modules. Loaded through createRequire so the exe's bundler leaves it alone.
export function loadNodePty(dataDir) {
  if (!IS_EXE) return createRequire(import.meta.url)('node-pty');
  const manifest = JSON.parse(asset('manifest.json').toString('utf8'));
  const dir = path.join(dataDir, 'app', `node-pty-${manifest.build}`);
  if (!fs.existsSync(path.join(dir, '.complete'))) {
    for (const rel of manifest.nodePty || []) {
      const to = path.join(dir, rel);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.writeFileSync(to, asset(`node-pty/${rel}`));
    }
    fs.writeFileSync(path.join(dir, '.complete'), '');
  }
  return createRequire(path.join(dir, 'package.json'))('./lib/index.js');
}

// A file of the page (index.html, app.js, …), or null if there is none.
export function pageFile(rel) {
  if (IS_EXE) return asset(`www${rel}`);
  let base = path.join(ROOT, 'public');
  if (rel.startsWith('/vendor/three/')) { base = path.join(ROOT, 'node_modules', 'three'); rel = rel.slice('/vendor/three'.length); }
  else if (rel.startsWith('/vendor/xterm/')) { base = path.join(ROOT, 'node_modules', '@xterm'); rel = rel.slice('/vendor/xterm'.length); }
  const file = path.normalize(path.join(base, decodeURIComponent(rel)));
  if (!file.startsWith(base + path.sep)) return null;
  try { return fs.readFileSync(file); } catch { return null; }
}

// the app's version (package.json), for the corner of the page
export const appVersion = () => { try { return JSON.parse(IS_EXE ? asset('manifest.json').toString('utf8') : fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || null; } catch { return null; } };
export const buildId = () => IS_EXE ? JSON.parse(asset('manifest.json').toString('utf8')).build : crypto.createHash('sha1').update(ROOT).digest('hex').slice(0, 8);
