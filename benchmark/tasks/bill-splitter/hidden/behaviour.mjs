// Hidden behaviour tests for bill-splitter-v1. Never copied into a contestant's folder.
// Each test gets a freshly loaded page and the helpers from grader/web.mjs.
import { split } from './reference.mjs';

const CASES = [[84.20, 18, 3], [47.50, 20, 4], [10.01, 15, 1], [0.10, 15, 7], [123.45, 12.5, 5], [19.99, 0, 3]];

async function results(h) { return { tip: await h.text('tip-amount'), total: await h.text('total'), per: await h.text('per-person') }; }
async function expectResults(h, want) {
  await h.until(async () => { const r = await results(h); return r.tip === want.tip && r.total === want.total && r.per === want.per; },
    async () => `got ${JSON.stringify(await results(h))}, want ${JSON.stringify({ tip: want.tip, total: want.total, per: want.per })}`);
}

export const tests = [
  ['title says Split the Bill', async h => h.check((await h.text('title')).includes('Split the Bill'), 'title text')],
  ['defaults: tip 15, people 1', async h => {
    h.check(await h.value('tip') === '15', `tip default is "${await h.value('tip')}"`);
    h.check(await h.value('people') === '1', `people default is "${await h.value('people')}"`);
  }],
  ...CASES.map(c => [`calculates ${c.join(' / ')}`, async h => {
    await h.fill({ bill: c[0], tip: c[1], people: c[2] });
    await expectResults(h, split(...c));
  }]),
  ['updates live when only people changes', async h => {
    await h.fill({ bill: 60, tip: 10, people: 1 });
    await expectResults(h, split(60, 10, 1));
    await h.fill({ people: 4 });
    await expectResults(h, split(60, 10, 4));
  }],
  ['preset buttons set the tip', async h => {
    await h.fill({ bill: 50, people: 1 });
    for (const p of [10, 20, 15]) {
      await h.click(`tip-${p}`);
      await h.until(async () => Number(await h.value('tip')) === p, async () => `tip input is "${await h.value('tip')}" after tip-${p}`);
      await expectResults(h, split(50, p, 1));
    }
  }],
  ...['0', '-2', '2.5', ''].map(p => [`invalid people "${p}" shows an error`, async h => {
    await h.fill({ bill: 40, tip: 15, people: p });
    await h.until(() => h.visible('error'), 'error not shown');
    await expectResults(h, split(-1, 0, 1));
  }]),
  ['negative bill shows an error', async h => {
    await h.fill({ bill: -5, tip: 15, people: 2 });
    await h.until(() => h.visible('error'), 'error not shown');
    await expectResults(h, split(-1, 0, 1));
  }],
  ['empty bill shows an error', async h => {
    await h.fill({ bill: 10, tip: 15, people: 2 });
    await h.fill({ bill: '' });
    await h.until(() => h.visible('error'), 'error not shown');
    await expectResults(h, split(-1, 0, 1));
  }],
  ['recovers after an error', async h => {
    await h.fill({ bill: 40, tip: 15, people: 0 });
    await h.until(() => h.visible('error'), 'error not shown');
    await h.fill({ people: 2 });
    await h.until(async () => !(await h.visible('error')), 'error still shown after a valid value');
    await expectResults(h, split(40, 15, 2));
  }],
  ['no error shown for valid input', async h => {
    await h.fill({ bill: 25, tip: 15, people: 1 });
    await h.until(async () => !(await h.visible('error')), 'error visible for valid input');
  }],
  ['how it works has exactly 3 steps', async h => {
    const n = await h.page.locator('[data-testid="how"] li').count();
    h.check(n === 3, `${n} list items`);
  }],
  ['FAQ answers start hidden and toggle on click', async h => {
    for (const i of [1, 2, 3]) {
      h.check(!(await h.visible(`faq-a-${i}`)), `answer ${i} visible at start`);
      await h.click(`faq-q-${i}`);
      await h.until(() => h.visible(`faq-a-${i}`), `answer ${i} did not open`);
      await h.click(`faq-q-${i}`);
      await h.until(async () => !(await h.visible(`faq-a-${i}`)), `answer ${i} did not close`);
    }
  }],
  ['FAQ works with the keyboard', async h => {
    await h.id('faq-q-1').focus(); await h.page.keyboard.press('Enter');
    await h.until(() => h.visible('faq-a-1'), 'Enter did not open answer 1');
    await h.id('faq-q-2').focus(); await h.page.keyboard.press('Space');
    await h.until(() => h.visible('faq-a-2'), 'Space did not open answer 2');
    const tag = await h.id('faq-q-3').evaluate(e => e.tagName);
    h.check(tag === 'BUTTON', `faq-q-3 is a <${tag.toLowerCase()}>, not a button`);
  }],
  ['one h1, a header and a footer, no duplicate ids', async h => {
    const r = await h.page.evaluate(() => {
      const ids = [...document.querySelectorAll('[id]')].map(e => e.id);
      return { h1: document.querySelectorAll('h1').length, header: !!document.querySelector('header'), footer: !!document.querySelector('footer'), dup: ids.length - new Set(ids).size };
    });
    h.check(r.h1 === 1 && r.header && r.footer && r.dup === 0, JSON.stringify(r));
  }],
];
