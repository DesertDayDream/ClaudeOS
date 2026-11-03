// Hidden robustness checks for bill-splitter-v1 (10 points). Each returns a score 0..1.
export const tests = [
  ['no sideways scrolling on phone and desktop', async h => {
    let worst = 0;
    for (const [w, ht] of [[375, 812], [1440, 900]]) {
      await h.page.setViewportSize({ width: w, height: ht });
      worst = Math.max(worst, await h.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth));
    }
    await h.page.setViewportSize({ width: 1280, height: 800 });
    return { score: worst <= 1 ? 1 : 0, note: worst > 1 ? `${worst}px overflow` : '' };
  }],
  ['inputs have labels', async h => {
    let ok = 0;
    for (const id of ['bill', 'tip', 'people']) if (await h.id(id).evaluate(e => !!(e.labels?.length || e.getAttribute('aria-label') || e.getAttribute('aria-labelledby')))) ok++;
    return { score: ok / 3, note: `${ok}/3 labelled` };
  }],
  ['accessibility scan (serious + critical)', async h => {
    const r = await h.axe();
    const n = r.violations.filter(v => v.impact === 'serious' || v.impact === 'critical').reduce((s, v) => s + v.nodes.length, 0);
    return { score: n === 0 ? 1 : n <= 2 ? 0.5 : 0, note: `${n} issues${n ? ': ' + r.violations.filter(v => v.impact === 'serious' || v.impact === 'critical').map(v => v.id).join(', ') : ''}` };
  }],
  ['HTML structure errors', async h => {
    const n = await h.htmlErrors();
    return { score: n === 0 ? 1 : n <= 3 ? 0.5 : 0, note: `${n} errors` };
  }],
  ['tap targets at least 24px on a phone', async h => {
    await h.page.setViewportSize({ width: 375, height: 812 });
    let small = [];
    for (const id of ['tip-10', 'tip-15', 'tip-20', 'faq-q-1', 'faq-q-2', 'faq-q-3']) {
      const b = await h.id(id).boundingBox();
      if (!b || b.width < 24 || b.height < 24) small.push(id);
    }
    await h.page.setViewportSize({ width: 1280, height: 800 });
    return { score: small.length === 0 ? 1 : small.length <= 2 ? 0.5 : 0, note: small.length ? 'small: ' + small.join(', ') : '' };
  }],
];
