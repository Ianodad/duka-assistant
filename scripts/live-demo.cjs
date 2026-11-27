/**
 * Supervised live demo recorder (Playwright). Types each prompt into the panel
 * chat box character by character, waits for the generated UI, logs which A2UI
 * components each prompt produced, records video. Needs the server on :3200 in
 * live mode; every prompt is a live Claude call counted by the spend ledger.
 * Env: PW_DIR (dir with playwright-core), OUT (output dir), BASE (default http://localhost:3200).
 * Prints no secrets. The script itself taps Pay on /checkout as the shopper (mock checkout only).
 */
const path = require('path');
const { chromium } = require(path.join(process.env.PW_DIR || '.', 'node_modules/playwright-core'));
const OUT = process.env.OUT || '.';
const BASE = process.env.BASE || 'http://localhost:3200';
const PROMPTS = (process.env.PROMPTS_JSON ? JSON.parse(process.env.PROMPTS_JSON) : [
  'Show me tea',
  'Compare the two',
  'Only the cheaper one, add it to my basket',
  'Make it 3',
  'Anything under 100 bob?',
  'I am ready to check out',
  'Where is my order?',
]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const b = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const ctx = await b.newContext({ viewport: { width: 1280, height: 800 }, recordVideo: { dir: OUT + '/raw', size: { width: 1280, height: 800 } } });
  const t0 = Date.now();
  const page = await ctx.newPage();
  const log = [];
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e).slice(0, 100)));
  await page.goto(BASE + '/');
  await sleep(1500);

  async function openPanel() {
    if (await page.locator('[data-testid=assistant-input]').isVisible().catch(() => false)) return;
    await page.click('[data-testid=assistant-open]');
    await page.waitForSelector('[data-testid=assistant-input]');
    await sleep(800);
  }
  await openPanel();
  log.push({ step: 'subtitle', text: ((await page.textContent('[data-testid=assistant-subtitle]')) || '').trim() });
  await sleep(1200);

  async function ask(text) {
    await openPanel();
    const before = await page.locator('[data-testid=turn-assistant]').count();
    await page.click('[data-testid=assistant-input]');
    await page.type('[data-testid=assistant-input]', text, { delay: Number(process.env.TYPE_DELAY || 45) });
    await sleep(500);
    const tSend = Date.now() - t0;
    await page.press('[data-testid=assistant-input]', 'Enter');
    await page.waitForFunction((n) => document.querySelectorAll('[data-testid=turn-assistant]').length > n, before, { timeout: 60000 });
    await page.waitForFunction(() => !document.querySelector('[data-testid=assistant-typing]'), null, { timeout: 60000 }).catch(() => {});
    const tDone = Date.now() - t0;
    await sleep(500);
    const info = await page.evaluate(() => {
      const turns = document.querySelectorAll('[data-testid=turn-assistant]');
      const t = turns[turns.length - 1];
      const canvas = document.querySelector('[data-testid=assistant-canvas]');
      const comps = canvas ? [...canvas.querySelectorAll('[data-a2ui]')].map((e) => e.getAttribute('data-a2ui')) : [];
      const roots = [...new Set(comps)];
      return {
        components: comps.reduce((m, c) => ((m[c] = (m[c] || 0) + 1), m), {}),
        roots,
        chatCards: document.querySelectorAll('[data-testid=assistant-log] [data-a2ui]').length,
        title: (document.querySelector('[data-testid=canvas-title]')?.textContent || '').trim(),
        pointer: (t.querySelector('[data-testid=canvas-pointer]')?.textContent || '').trim(),
        text: (t.querySelector('p')?.textContent || '').slice(0, 120),
        note: t.querySelector('[data-testid=assistant-note]')?.textContent || '',
        total: turns.length,
      };
    });
    const vis = await page.evaluate(() => {
      const b = document.querySelector('[data-testid=assistant-canvas] [data-testid=a2ui-go-checkout]');
      const log = document.documentElement;
      if (!log || !b) return null;
      const r = b.getBoundingClientRect();
      return r.top >= 0 && r.bottom <= window.innerHeight;
    });
    log.push({ prompt: text, sendMs: tSend, doneMs: tDone, latencyMs: tDone - tSend, checkoutButtonVisible: vis, ...info });
    console.log(JSON.stringify(log[log.length - 1]));
    await sleep(Number(process.env.READ_MS || 2800)); // let a viewer read the card
  }

  const checkoutIdx = PROMPTS.findIndex((p) => /check ?out/i.test(p));
  for (let i = 0; i < PROMPTS.length; i++) {
    const p = PROMPTS[i];
    await ask(p);
    if (i === checkoutIdx) {
      // The shopper uses the card's handoff, then taps Pay on /checkout (mock).
      await page.click('[data-testid=a2ui-go-checkout]');
      await page.waitForURL(/\/checkout$/, { timeout: 15000 });
      await sleep(2500);
      await page.fill('[data-testid=phone-input]', '0712 345 000');
      await sleep(1200);
      await Promise.all([page.waitForURL(/\/orders\/ord_/, { timeout: 20000 }), page.click('[data-testid=pay-button]')]);
      log.push({ step: 'mock-pay-by-shopper', url: new URL(page.url()).pathname.replace(/ord_[A-Za-z0-9_-]+/, 'ord_*') });
      await sleep(3000);
      await page.goto(BASE + '/');
      await sleep(1500);
    }
  }
  const total = Date.now() - t0;
  await sleep(1000);
  await ctx.close();
  const vid = await page.video().path();
  await b.close();
  require('fs').writeFileSync(OUT + '/run-log.json', JSON.stringify({ totalMs: total, pageErrors: errs.length, log, video: vid }, null, 2));
  console.log('DONE', total, 'ms', vid, 'pageerrors', errs.length);
})().catch((e) => { console.error('FAIL', String(e).slice(0, 400)); process.exit(1); });
