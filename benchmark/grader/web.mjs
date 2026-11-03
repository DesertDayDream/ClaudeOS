// Grades a webpage task in a contestant's folder: gates, hidden behaviour tests, robustness checks
// and screenshots for the judge. Uses the installed Microsoft Edge through playwright-core (no browser download).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { HtmlValidate } from 'html-validate';

const require = createRequire(import.meta.url);
const AXE = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const HTML_RULES = ['parser-error', 'close-order', 'close-attr', 'no-dup-id', 'void-content', 'element-permitted-content',
  'element-permitted-parent', 'element-required-content', 'element-required-attributes', 'attribute-allowed-values', 'no-missing-references', 'wcag/h37'];
const LOCAL = /^(file|data|blob|about):/;

export function launch() { return chromium.launch({ channel: process.env.BENCH_BROWSER || 'msedge', headless: true }); }

async function openPage(browser, url, viewport = { width: 1280, height: 800 }) {
  const ctx = await browser.newContext({ viewport, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  const problems = { errors: [], external: [] };
  page.on('pageerror', e => problems.errors.push('page error: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/favicon/i.test(m.text())) problems.errors.push('console: ' + m.text()); });
  await page.route('**/*', r => { const u = r.request().url(); if (LOCAL.test(u)) return r.continue(); problems.external.push(u); return r.abort(); });
  let loaded = true, loadError = '';
  try { await page.goto(url, { waitUntil: 'load', timeout: 15e3 }); } catch (e) { loaded = false; loadError = e.message.split('\n')[0]; }
  return { ctx, page, problems, loaded, loadError };
}

function helpers(page, file) {
  const id = t => page.getByTestId(t).first();
  const h = {
    page, id,
    text: async t => ((await id(t).textContent({ timeout: 2e3 })) || '').trim(),
    value: t => id(t).inputValue({ timeout: 2e3 }),
    visible: async t => (await page.getByTestId(t).count()) > 0 && id(t).isVisible(),
    click: t => id(t).click({ timeout: 2e3 }),
    fill: async o => { for (const [k, v] of Object.entries(o)) await id(k).fill(String(v), { timeout: 2e3 }); },
    check: (ok, why) => { if (!ok) throw new Error(why); },
    until: async (fn, why, ms = 1500) => {
      const end = Date.now() + ms;
      for (;;) { if (await fn().catch(() => false)) return; if (Date.now() > end) throw new Error(typeof why === 'function' ? await why() : why); await page.waitForTimeout(100); }
    },
    axe: async () => { await page.addScriptTag({ content: AXE }); return page.evaluate(() => window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] }, resultTypes: ['violations'] })); },
    htmlErrors: async () => {
      const report = await new HtmlValidate({ extends: ['html-validate:recommended'] }).validateFile(file);
      return report.results.flatMap(r => r.messages).filter(m => m.severity === 2 && HTML_RULES.includes(m.ruleId)).length;
    },
  };
  return h;
}

async function shoot(browser, url, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const shots = {};
  for (const [name, vp] of [['desktop', { width: 1440, height: 900 }], ['phone', { width: 375, height: 812 }]]) {
    const { ctx, page } = await openPage(browser, url, vp);
    await page.waitForTimeout(300);
    shots[name] = path.join(outDir, name + '.png');
    await page.screenshot({ path: shots[name], fullPage: true }).catch(() => delete shots[name]);
    await ctx.close();
  }
  // after interaction: error state + first FAQ answer open
  const { ctx, page } = await openPage(browser, url, { width: 1440, height: 900 });
  const h = helpers(page);
  await h.fill({ bill: 40, people: 0 }).catch(() => {});
  await h.click('faq-q-1').catch(() => {});
  await page.waitForTimeout(300);
  shots.states = path.join(outDir, 'states.png');
  await page.screenshot({ path: shots.states, fullPage: true }).catch(() => delete shots.states);
  await ctx.close();
  return shots;
}

// task: { dir (task folder), checks (parsed checks.json) }. Returns everything the score needs.
export async function gradeWeb(siteDir, task, shotsDir) {
  const { checks } = task;
  const file = path.join(siteDir, checks.entry || 'index.html');
  const out = { gates: [], behaviour: [], robust: [], F: 0, R: 0, shots: {} };
  const gate = (id, ok, note = '') => out.gates.push({ id, ok, note });
  if (!fs.existsSync(file)) { gate('entry file exists', false, `${checks.entry} missing`); return out; }
  gate('entry file exists', true);
  const url = pathToFileURL(file).href;
  const browser = await launch();
  try {
    const first = await openPage(browser, url);
    await first.page.waitForTimeout(500);
    gate('page loads', first.loaded && (await first.page.locator('body *').count()) > 0, first.loadError);
    const missing = [];
    for (const t of checks.requiredTestids || []) if (!(await first.page.getByTestId(t).count())) missing.push(t);
    gate('required data-testid hooks', missing.length === 0, missing.length ? 'missing: ' + missing.join(', ') : '');
    await first.ctx.close();

    const { tests: behaviour } = require(path.join(task.dir, checks.behaviour.file.replace(/\.mjs$/, '.cjs')));
    const allProblems = { errors: new Set(first.problems.errors), external: new Set(first.problems.external) };
    for (const [name, fn] of behaviour) {
      const { ctx, page, problems } = await openPage(browser, url);
      let ok = true, note = '';
      try { await fn(helpers(page, file)); } catch (e) { ok = false; note = e.message.split('\n')[0].slice(0, 200); }
      problems.errors.forEach(e => allProblems.errors.add(e)); problems.external.forEach(e => allProblems.external.add(e));
      out.behaviour.push({ name, ok, note });
      await ctx.close();
    }
    out.F = out.behaviour.filter(t => t.ok).length / (out.behaviour.length || 1);
    gate('no console errors', allProblems.errors.size === 0, [...allProblems.errors].slice(0, 3).join(' | '));
    gate('no external requests', allProblems.external.size === 0, [...allProblems.external].slice(0, 3).join(' | '));

    const { tests: robust } = require(path.join(task.dir, checks.robust.file.replace(/\.mjs$/, '.cjs')));
    for (const [name, fn] of robust) {
      const { ctx, page } = await openPage(browser, url);
      let score = 0, note = '';
      try { ({ score, note = '' } = await fn(helpers(page, file))); } catch (e) { note = 'failed: ' + e.message.split('\n')[0].slice(0, 160); }
      out.robust.push({ name, score, note });
      await ctx.close();
    }
    out.R = out.robust.reduce((s, t) => s + t.score, 0) / (out.robust.length || 1);
    if (shotsDir) out.shots = await shoot(browser, url, shotsDir);
  } finally { await browser.close(); }
  return out;
}
