/* eslint-disable */
// Duka Claude planner e2e (AC-CP-10): DUKA_PLANNER=claude DUKA_PLANNER_CLIENT=mock, fixtures only.
// The server gets ANTHROPIC_API_KEY='' and DUKA_ALLOW_LIVE='' (Next does not override set vars from
// .env), so the real key in .env is never loaded and the live gate stays closed.
// Panel renders from mocked model output at 1280 and 390, a hostile fixture gives the fallback card,
// and the server log proves zero live client constructions and transport calls.
// SPEC-LIVE: subtitle in claude mock mode, the mock bypasses the spend ledger (temp dir stays empty),
// and a second server (NODE_ENV=test, test-only DUKA_SPEND_TEST_PRICE_MOCK=1, temp ledger pre-filled to the $5 cap)
// shows the fixed spend-cap note with the regex answer.
// SPEC-LIVE AC-L13/L14: a follow-up flow at 1280 and 390 (show flour, only the cheaper one, add it, make it 3,
// under 200 bob, checkout please) proves updated cards replace the earlier card instead of stacking a duplicate.
// SPEC-LIVE AC-L19/L20: the old slot shows typed fixed copy (data-testid=card-slot-note, data-slot-note=<key>).
// SPEC-LIVE AC-L23 to AC-L29: cards render in the main-area canvas, the chat is conversation only (pointer line,
// slot notes). The follow flow checks canvas titles, pointers, Back to shop, the mobile sheet and overflow at 1280 and 390.
// Screenshots to evidence/claude-planner/ and evidence/main-area-20261126/. Stops only the servers it started.
const { chromium } = require(process.env.DUKA_PLAYWRIGHT_PATH || 'playwright');
const { spawn } = require('node:child_process');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'evidence', 'claude-planner');
// AC-L28 shots (viewport only): the canvas in the main area, chat sheet collapsed on mobile.
const MAIN_OUT = path.join(ROOT, 'evidence', 'main-area-20261126');
const SERVER_LOG = path.join(ROOT, 'logs', 'e2e-claude-server.txt');
const PORT = 3200;
const BASE = `http://localhost:${PORT}`;
const results = [];
let failures = 0;

function check(name, ok, detail = '') {
  results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
  console.log(results[results.length - 1]);
  if (!ok) failures++;
}

function portInUse(port) {
  return new Promise((resolve) => {
    const s = net.createConnection({ port, host: '127.0.0.1' });
    s.once('connect', () => (s.destroy(), resolve(true)));
    s.once('error', () => resolve(false));
  });
}

async function waitPortFree(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!(await portInUse(PORT))) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

async function waitUp(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if ((await fetch(BASE + '/')).ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

const serverLog = () => (fs.existsSync(SERVER_LOG) ? fs.readFileSync(SERVER_LOG, 'utf8') : '');
const plannerLines = () => serverLog().split('\n').filter((l) => l.startsWith('[claude-planner]'));
const stkCount = () => (serverLog().match(/\[daraja\] mock\.stk\.\w+/g) || []).length;

async function overflow(page, label) {
  const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  check(`no horizontal overflow: ${label}`, o.sw <= o.cw, `scrollWidth=${o.sw} clientWidth=${o.cw}`);
  const d = await page.evaluate(() => {
    const el = document.querySelector('[data-testid=assistant-log]');
    return el ? { sw: el.scrollWidth, cw: el.clientWidth } : null;
  });
  if (d) check(`no horizontal overflow inside the panel: ${label}`, d.sw <= d.cw, `scrollWidth=${d.sw} clientWidth=${d.cw}`);
}

async function shot(page, name, label) {
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid=assistant-log]');
    if (el) {
      el.style.scrollBehavior = 'auto';
      el.scrollTop = el.scrollHeight;
    }
  });
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid=assistant-log] img, [data-testid=assistant-canvas] img')].every((i) => i.complete), null, { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(200);
  if (name) await page.screenshot({ path: path.join(OUT, name) });
  await overflow(page, label);
}

const CANVAS = '[data-testid=assistant-canvas]';
const inputFocused = () => document.activeElement && document.activeElement.getAttribute('data-testid') === 'assistant-input';
const isOpen = (page) => page.getAttribute('[data-testid=assistant-drawer]', 'data-open');

/** Reopen the chat when it is closed: the mobile sheet handle if there is one, else the header button. */
async function openChat(page) {
  if ((await isOpen(page)) === 'true') return;
  const handle = page.locator('[data-testid=assistant-sheet-handle]');
  if (await handle.count()) await handle.click();
  else await page.click('[data-testid=assistant-open]');
  await page.waitForFunction(inputFocused, null, { timeout: 10000 });
}

async function ask(page, text) {
  await openChat(page);
  const before = await page.locator('[data-testid=turn-assistant]').count();
  await page.fill('[data-testid=assistant-input]', text);
  await page.press('[data-testid=assistant-input]', 'Enter');
  await page.waitForFunction((n) => document.querySelectorAll('[data-testid=turn-assistant]').length > n, before, { timeout: 15000 });
  await page.waitForFunction(() => !document.querySelector('[data-testid=assistant-typing]'), null, { timeout: 15000 });
  // AC-L27: on a narrow screen the sheet collapses (a short timer after the answer) when cards were shown.
  if ((page.viewportSize() || { width: 1280 }).width < 1024) await page.waitForFunction(() => document.querySelector('[data-testid=assistant-drawer]').getAttribute('data-open') === 'false', null, { timeout: 1500 }).catch(() => {});
}

/** Viewport-only screenshot for evidence/main-area-20261126 (desktop-<step>.png / mobile-<step>.png). */
async function mainShot(page, name, mobile) {
  fs.mkdirSync(MAIN_OUT, { recursive: true });
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid=assistant-canvas] img')].every((i) => i.complete), null, { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(900);
  await page.screenshot({ path: path.join(MAIN_OUT, `${mobile ? 'mobile' : 'desktop'}-${name}.png`), fullPage: false });
}

/** AC-L28 checks after one step: cards inside the canvas, none in the chat, canvas title, pointer line, no overflow. */
async function stepChecks(page, tag, step, { cards, title, pointer }) {
  const n = await page.locator(`${CANVAS} ${cards}`).count();
  check(`[${tag}] AC-L28 ${step}: cards are inside the canvas`, n >= 1, `count=${n}`);
  const chat = await page.locator('[data-testid=assistant-log] [data-a2ui]').count();
  check(`[${tag}] AC-L28 ${step}: no [data-a2ui] element in the chat log`, chat === 0, `count=${chat}`);
  const t = ((await page.textContent(`${CANVAS} [data-testid=canvas-title]`).catch(() => '')) || '').trim();
  check(`[${tag}] AC-L28 ${step}: canvas title is "${title}"`, t === title, JSON.stringify(t));
  const ptr = page.locator('[data-testid=assistant-log] [data-testid=canvas-pointer]');
  const pt = (await ptr.count()) === 1 ? ((await ptr.textContent()) || '').trim() : `count=${await ptr.count()}`;
  check(`[${tag}] AC-L28 ${step}: pointer line is "${pointer}"`, pt === pointer, JSON.stringify(pt));
  const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  check(`[${tag}] AC-L28 ${step}: no horizontal overflow (scrollWidth <= innerWidth)`, o.sw <= o.iw, `scrollWidth=${o.sw} innerWidth=${o.iw}`);
}

/** Back to shop: the canvas leaves the DOM and the catalogue (#products) is in view. */
async function backToShop(page, tag, step) {
  await page.click(`${CANVAS} [data-testid=canvas-back]`);
  await page.waitForTimeout(1200);
  const r = await page.evaluate(() => {
    const el = document.getElementById('products');
    const b = el && el.getBoundingClientRect();
    return { canvas: document.querySelectorAll('[data-testid=assistant-canvas]').length, inView: Boolean(b) && b.top < window.innerHeight && b.bottom > 0, top: b ? Math.round(b.top) : null };
  });
  check(`[${tag}] AC-L28 ${step}: Back to shop hides the canvas`, r.canvas === 0, `canvas=${r.canvas}`);
  check(`[${tag}] AC-L28 ${step}: Back to shop brings the catalogue (#products) into view`, r.inView, `top=${r.top}`);
}

/** The shopper taps the pointer line: on a narrow screen that means reopening the sheet first (the tap then collapses it again). */
async function tapPointer(page) {
  if ((page.viewportSize() || { width: 1280 }).width < 1024) await openChat(page);
  await page.locator('[data-testid=assistant-log] [data-testid=canvas-pointer]').last().click();
  if ((page.viewportSize() || { width: 1280 }).width < 1024) await page.waitForFunction(() => document.querySelector('[data-testid=assistant-drawer]').getAttribute('data-open') === 'false', null, { timeout: 3000 });
}

/** AC-L15 (now AC-L28): click the pointer line (scrolls and focuses the canvas), then the element's box must be inside the viewport. */
async function insideViewport(page, sel) {
  await tapPointer(page);
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid=assistant-canvas] img')].every((i) => i.complete), null, { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(1200);
  return page.evaluate((s) => {
    const all = document.querySelectorAll(`[data-testid=assistant-canvas] ${s}`);
    const el = all[all.length - 1];
    if (!el) return { ok: false, detail: 'missing' };
    const b = el.getBoundingClientRect();
    const ok = b.height > 0 && b.top >= -0.5 && b.bottom <= window.innerHeight + 0.5 && b.left >= -0.5 && b.right <= window.innerWidth + 0.5;
    return { ok, detail: `el ${Math.round(b.top)}-${Math.round(b.bottom)} of ${window.innerHeight}, x ${Math.round(b.left)}-${Math.round(b.right)} of ${window.innerWidth}` };
  }, sel);
}

// AC-L16: chips must equal the categories of the cards shown in the same turn, with those counts.
async function chipsMatchCards(page) {
  return page.evaluate(() => {
    const t = document.querySelector('[data-testid=assistant-canvas] [data-testid=canvas-body]');
    const want = {};
    for (const c of t.querySelectorAll('[data-a2ui=ProductCard]')) want[c.getAttribute('data-category')] = (want[c.getAttribute('data-category')] || 0) + 1;
    const got = {};
    let dupes = 0;
    for (const b of t.querySelectorAll('[data-a2ui=FilterChips] [data-chip-category]')) {
      const k = b.getAttribute('data-chip-category');
      if (k in got) dupes++;
      got[k] = Number(b.getAttribute('data-chip-count'));
    }
    const ok = dupes === 0 && Object.keys(want).length > 0 && Object.keys(want).length === Object.keys(got).length && Object.keys(want).every((k) => got[k] === want[k]);
    return { ok, detail: `cards ${JSON.stringify(want)} chips ${JSON.stringify(got)} dupes ${dupes}` };
  });
}

const lastIn = (page, sel) => page.locator(`[data-testid=assistant-log] ${sel}`).last();
/** Cards live in the main-area canvas (AC-L23). */
const cin = (page, sel) => page.locator(`${CANVAS} ${sel}`).last();

// Codex live review 8: a true follow-up must update the card in place, not remount it. Tag the live DOM nodes
// (surface wrapper and card) with a JS property before the follow-up and read it back after: a remount loses it.
async function markNodes(page, cardSel) {
  await page.evaluate(({ c, card }) => {
    const wrap = document.querySelector(`${c} [data-surface-id]`);
    const node = wrap && wrap.querySelector(card);
    if (wrap) wrap.__dukaMark = 'wrap';
    if (node) node.__dukaMark = 'card';
  }, { c: CANVAS, card: cardSel });
}
async function identityCheck(page, tag, step, cardSel, sameNodes = true) {
  const r = await page.evaluate(({ c, card }) => {
    const wrap = document.querySelector(`${c} [data-surface-id]`);
    const node = wrap && wrap.querySelector(card);
    return { wrap: wrap ? wrap.__dukaMark || null : 'missing', card: node ? node.__dukaMark || null : 'missing', pulse: wrap ? wrap.getAttribute('data-pulse') : null, overlay: wrap ? wrap.querySelectorAll('[data-testid=canvas-pulse]').length : -1 };
  }, { c: CANVAS, card: cardSel });
  if (sameNodes) check(`[${tag}] "${step}": the surface wrapper and the card stay the same DOM nodes (updated in place, not remounted)`, r.wrap === 'wrap' && r.card === 'card', JSON.stringify(r));
  check(`[${tag}] "${step}": the highlight runs on its own overlay (pulse >= 1, one overlay)`, Number(r.pulse) >= 1 && r.overlay === 1, JSON.stringify(r));
}
const lastReply = async (page) => ((await lastIn(page, '[data-testid=turn-assistant] > p').textContent()) || '').trim();
const lastTurnHasFallback = (page) => page.evaluate(() => {
  const turns = document.querySelectorAll('[data-testid=assistant-log] [data-testid=turn-assistant]');
  const t = turns[turns.length - 1];
  return Boolean(t && t.querySelector('[data-testid=a2ui-fallback]')) && !t.querySelector('[data-surface-id], [data-a2ui]');
});

async function flow(browser, vp, mobile) {
  const tag = `${vp.width}`;
  const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  let serverActions = 0;
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.headers()['next-action']) serverActions++;
  });
  const stk0 = stkCount();
  const lines0 = plannerLines().length;
  const desk = (n) => (mobile ? null : n);

  await page.goto(BASE + '/');
  await page.click('[data-testid=assistant-open]');
  await page.waitForFunction(() => document.activeElement && document.activeElement.getAttribute('data-testid') === 'assistant-input', null, { timeout: 10000 });

  // SPEC-LIVE AC-L1: subtitle from the server mode (claude planner, mock client); the old scripted text never shows.
  const sub = ((await page.textContent('[data-testid=assistant-subtitle]')) || '').trim();
  check(`[${tag}] subtitle in claude mock mode is the test-mode text`, sub === 'Claude planner, test mode. It never pays for you.', sub);
  check(`[${tag}] the old scripted subtitle is not shown in claude mode`, !((await page.textContent('[data-testid=assistant-drawer]')) || '').includes('Scripted helper.'));

  // Grid from the search fixture (search_products then render_ui).
  await ask(page, 'search tea');
  check(`[${tag}] claude mock: "search tea" renders a ProductGrid from render_ui (in the canvas)`, (await cin(page, '[data-a2ui=ProductGrid]').count()) === 1);
  check(`[${tag}] claude mock: grid has the two fixture products`, (await cin(page, '[data-a2ui=ProductCard][data-product-id=ketepa-100]').count()) === 1 && (await cin(page, '[data-a2ui=ProductCard][data-product-id=kericho-gold-50]').count()) === 1);
  const price = ((await cin(page, '[data-testid=a2ui-price-ketepa-100]').textContent()) || '').trim();
  check(`[${tag}] claude mock: card price comes from the catalog`, price === 'KES 240', price);
  check(`[${tag}] claude mock: reply bubble is the trusted search_found text`, (await lastReply(page)) === 'Here is what I found.');
  await shot(page, desk('grid.png'), `${tag} grid`);

  // Compare (two parallel get_product calls, then CompareTable).
  await ask(page, 'compare ketepa and kericho gold');
  check(`[${tag}] claude mock: compare renders a CompareTable`, (await cin(page, '[data-a2ui=CompareTable]').count()) === 1);
  const cp = ((await cin(page, '[data-testid=a2ui-compare-price-kericho-gold-50]').textContent()) || '').trim();
  check(`[${tag}] claude mock: compare prices come from the catalog`, cp === 'KES 135', cp);
  await shot(page, desk('compare.png'), `${tag} compare`);

  // Add to cart (add_to_cart, view_cart, render CartSummary).
  await ask(page, 'add 2 unga');
  check(`[${tag}] claude mock: "add 2 unga" renders CartSummary`, (await cin(page, '[data-a2ui=CartSummary]').count()) === 1);
  await page.waitForFunction(() => document.querySelector('[data-testid=cart-count]')?.textContent?.trim() === '2', null, { timeout: 10000 }).catch(() => {});
  check(`[${tag}] claude mock: add_to_cart tool changed the server cart (header count 2)`, ((await page.textContent('[data-testid=cart-count]')) || '').trim() === '2');
  const total = ((await cin(page, '[data-testid=a2ui-cart-total]').textContent()) || '').trim();
  check(`[${tag}] claude mock: cart total from the server (2 x 175)`, total === 'KES 350', total);
  check(`[${tag}] claude mock: reply is the trusted added text`, /^Added Jogoo Maize Flour \(Unga\) to your basket\.$/.test(await lastReply(page)));
  await shot(page, desk('cart.png'), `${tag} cart`);

  // Hostile fixture: fake price heading/title -> fallback card, nothing from it on screen.
  await ask(page, 'show me a deal');
  check(`[${tag}] hostile fixture (fake price) gives the fallback card and no surface`, await lastTurnHasFallback(page));
  check(`[${tag}] hostile fixture: reply is the trusted could_not_show text`, (await lastReply(page)) === 'I could not show that.');
  const logText = (await page.textContent('[data-testid=assistant-log]')) || '';
  const canvasText = (await page.locator(CANVAS).textContent().catch(() => '')) || '';
  check(`[${tag}] hostile fixture: "1/-" and "KES 1 only" are not on screen (chat or canvas)`, !(logText + canvasText).includes('1/-') && !(logText + canvasText).includes('KES 1 only'));
  check(`[${tag}] hostile fixture: the canvas still shows the earlier cart, the fallback card is in the chat only`, (await cin(page, '[data-a2ui=CartSummary]').count()) === 1 && (await page.locator(`${CANVAS} [data-testid=a2ui-fallback]`).count()) === 0 && (await page.locator('[data-testid=assistant-log] [data-a2ui]').count()) === 0);
  await shot(page, mobile ? 'hostile-fallback-mobile.png' : 'hostile-fallback.png', `${tag} hostile fallback`);

  // More hostile output and plain text: fallback, never rendered.
  for (const t of ['hostile pay', 'hostile link', 'hostile html', 'tell me a joke']) {
    await ask(page, t);
    check(`[${tag}] "${t}" gives the fallback card`, await lastTurnHasFallback(page));
  }
  const after = (await page.textContent('[data-testid=assistant-log]')) || '';
  check(`[${tag}] no hostile or plain model text on screen`, !/evil\.example|chicken|onerror|KES 1 today/.test(after));
  check(`[${tag}] hostile output did not change the cart`, ((await page.textContent('[data-testid=cart-count]')) || '').trim() === '2');

  // Text with no fixture: regex planner fallback still answers.
  await ask(page, 'show household');
  check(`[${tag}] no-fixture text falls back to the regex planner (category grid)`, (await cin(page, '[data-a2ui=ProductGrid]').count()) === 1 && (await lastReply(page)) === 'Here is Household.');

  // Checkout handoff from place_mock_order: no payment, no order, no STK.
  await ask(page, 'checkout please');
  const vis0 = await insideViewport(page, '[data-testid=a2ui-go-checkout]');
  check(`[${tag}] AC-L15/L28 go-checkout button inside the viewport after the canvas is focused (pointer click)`, vis0.ok, vis0.detail);
  const ht = ((await cin(page, '[data-testid=a2ui-handoff-total]').textContent()) || '').trim();
  check(`[${tag}] place_mock_order renders CheckoutHandoff with the server total`, ht === 'KES 350', ht);
  check(`[${tag}] panel use made no server action (Pay) and no STK push`, serverActions === 0 && stkCount() === stk0, `actions=${serverActions} stk=${stkCount() - stk0}`);
  check(`[${tag}] still on the home page (planner never navigates)`, new URL(page.url()).pathname === '/');

  // Live-call counters from the server log, for this viewport's requests.
  await page.waitForTimeout(300);
  const mine = plannerLines().slice(lines0);
  check(`[${tag}] server logged one planner line per message`, mine.length === 10, `lines=${mine.length}`);
  check(`[${tag}] every planner line: client=mock live_constructions=0 live_transport_calls=0`, mine.length > 0 && mine.every((l) => / client=mock live_constructions=0 live_transport_calls=0$/.test(l)));
  check(`[${tag}] outcomes seen: rendered, rejected, fallback`, ['rendered', 'rejected', 'fallback'].every((o) => mine.some((l) => l.includes(`outcome=${o}`))));

  check(`[${tag}] no page errors`, errors.length === 0, errors.join(' | ').slice(0, 300));
  await ctx.close();
}

// SPEC-LIVE AC-L13/L14: follow-ups update the previous card, budget ask, checkout handoff. Fresh context = fresh session and cart.
const priceOf = async (page, id) => Number((((await cin(page, `[data-testid=a2ui-price-${id}]`).textContent()) || '').replace(/[^0-9]/g, '')));

async function followFlow(browser, vp, mobile) {
  const tag = `follow ${vp.width}`;
  const sfx = mobile ? '-mobile' : '';
  const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  let serverActions = 0;
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.headers()['next-action']) serverActions++;
  });
  const stk0 = stkCount();
  const lines0 = plannerLines().length;
  await page.goto(BASE + '/');
  await page.click('[data-testid=assistant-open]');
  await page.waitForFunction(() => document.activeElement && document.activeElement.getAttribute('data-testid') === 'assistant-input', null, { timeout: 10000 });
  const log = (sel) => page.locator(`[data-testid=assistant-log] ${sel}`);
  const cards = (sel) => page.locator(`${CANVAS} ${sel}`);

  // 1. "show flour" -> grid of two flour products. AC-L17: the request is held 900 ms by the test so the in-flight
  // skeleton card can be seen; it is fixed markup (no text) and it leaves with the typing dots.
  await page.route('**/api/assistant', async (route) => {
    await new Promise((r) => setTimeout(r, 900));
    await route.continue();
  });
  await page.fill('[data-testid=assistant-input]', 'show flour');
  await page.press('[data-testid=assistant-input]', 'Enter');
  const sk = await page.waitForSelector(`${CANVAS} [data-testid=assistant-skeleton]`, { timeout: 5000 }).then(() => true, () => false);
  const skText = sk ? ((await page.textContent('[data-testid=assistant-skeleton]')) || '').trim() : 'missing';
  const dots = (await page.locator('[data-testid=assistant-log] [data-testid=assistant-typing]').count()) === 1;
  const skTitle = sk ? ((await page.textContent(`${CANVAS} [data-testid=canvas-title]`)) || '').trim() : 'missing';
  check(`[${tag}] AC-L17/L23 skeleton card shown in the canvas while the request is in flight (typing dots stay in the chat, canvas title "Loading"), no text`, sk && dots && skText === '' && skTitle === 'Loading' && (await page.locator('[data-testid=assistant-log] [data-testid=assistant-skeleton]').count()) === 0, `skeleton=${sk} dots=${dots} text=${JSON.stringify(skText)} title=${skTitle}`);
  await page.waitForFunction(() => !document.querySelector('[data-testid=assistant-typing]') && document.querySelectorAll('[data-testid=turn-assistant]').length > 0, null, { timeout: 15000 });
  check(`[${tag}] skeleton removed when the answer arrives`, (await page.locator('[data-testid=assistant-skeleton]').count()) === 0);
  await page.unroute('**/api/assistant');
  check(`[${tag}] "show flour" renders a ProductGrid with unga and mandazi mix`, (await cin(page, '[data-a2ui=ProductGrid]').count()) === 1 && (await page.locator(CANVAS).locator('[data-a2ui=ProductCard]').count()) === 2);
  const gridSurface = await page.locator(CANVAS).locator('[data-surface-id]').first().getAttribute('data-surface-id');
  const pu = await priceOf(page, 'unga-2kg');
  const pm = await priceOf(page, 'mandazi-mix-1kg');
  await stepChecks(page, tag, 'show flour', { cards: '[data-a2ui=ProductGrid]', title: 'Results', pointer: 'Showing 2 results in the main view' });
  check(`[${tag}] AC-L27 ${mobile ? 'mobile: the chat sheet collapsed after the answer, the Chat handle shows' : 'desktop: the drawer stays docked open next to the canvas'}`, (await isOpen(page)) === (mobile ? 'false' : 'true') && (await page.locator(CANVAS).isVisible()) && (await page.locator('[data-testid=assistant-sheet-handle]').count()) === (mobile ? 1 : 0));
  if (mobile) {
    await page.locator('[data-testid=assistant-sheet-handle]').click();
    await page.waitForFunction(inputFocused, null, { timeout: 10000 });
    check(`[${tag}] AC-L27 mobile: the handle reopens the sheet with the conversation still there`, (await isOpen(page)) === 'true' && ((await page.textContent('[data-testid=assistant-log]')) || '').includes('show flour') && (await lastReply(page)) === 'Here is what I found.');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.querySelector('[data-testid=assistant-drawer]').getAttribute('data-open') === 'false');
  }
  await tapPointer(page);
  await shot(page, `follow-grid${sfx}.png`, `${tag} grid`);
  await mainShot(page, 'search', mobile);

  // 2. "only the cheaper one" -> the grid updates in place: one grid on screen, same surface id, one card, old spot marked.
  // Codex live review 9: narrowing is an in-place update too. The canvas stays shown (no Back to shop first): mark the
  // surface wrapper and the surviving (cheaper) card node, then both must be the same DOM nodes after the follow-up.
  const cheaper = pu <= pm ? 'unga-2kg' : 'mandazi-mix-1kg';
  const cheaperCard = `[data-a2ui=ProductCard][data-product-id=${cheaper}]`;
  check(`[${tag}] "only the cheaper one": the canvas is shown before the follow-up (identity is checked on live nodes)`, (await page.locator(CANVAS).count()) === 1 && (await page.locator(CANVAS).locator(cheaperCard).count()) === 1);
  await markNodes(page, cheaperCard);
  await ask(page, 'only the cheaper one');
  await identityCheck(page, tag, 'only the cheaper one', cheaperCard);
  check(`[${tag}] "only the cheaper one": exactly one ProductGrid left on screen (canvas), none in the chat (no duplicate)`, (await cards('[data-a2ui=ProductGrid]').count()) === 1 && (await log('[data-a2ui]').count()) === 0);
  check(`[${tag}] the grid kept its surface id and now sits in the canvas`, (await page.locator(CANVAS).locator(`[data-surface-id="${gridSurface}"]`).count()) === 1, String(gridSurface));
  check(`[${tag}] the updated grid shows only the cheaper product (${cheaper}, catalog prices ${pu} vs ${pm})`, (await page.locator(CANVAS).locator('[data-a2ui=ProductCard]').count()) === 1 && (await page.locator(CANVAS).locator(`[data-a2ui=ProductCard][data-product-id=${cheaper}]`).count()) === 1);
  const notes = () => log('[data-testid=card-slot-note]');
  const noteText = async (k) => ((await notes().nth(k).textContent()) || '').trim();
  check(`[${tag}] AC-L19 the old spot shows one slot note, key updated, text "Updated in the main view"`, (await notes().count()) === 1 && (await notes().nth(0).getAttribute('data-slot-note')) === 'updated' && (await noteText(0)) === 'Updated in the main view', `${await notes().count()} notes, ${JSON.stringify(await noteText(0).catch(() => ''))}`);
  check(`[${tag}] AC-L19/L26 the old "Updated below." and "Card updated below." copy is gone`, (await page.getByText('Updated below').count()) === 0 && (await page.getByText('Card updated below.').count()) === 0 && (await log('[data-testid=card-updated]').count()) === 0);
  await stepChecks(page, tag, 'only the cheaper one', { cards: '[data-a2ui=ProductGrid]', title: 'Results', pointer: 'Showing 1 result in the main view' });
  await shot(page, `follow-cheaper${sfx}.png`, `${tag} cheaper`);
  // AC-L24/L28: Back to shop hides the canvas and shows the catalogue; the next prompt brings the canvas back.
  await backToShop(page, tag, 'after only the cheaper one');
  const kept = (await page.textContent('[data-testid=assistant-log]')) || '';
  check(`[${tag}] AC-L24 the conversation is kept after Back to shop`, kept.includes('show flour') && kept.includes('only the cheaper one'));

  // 3. "add it" -> cart view with that product.
  await ask(page, 'add it');
  check(`[${tag}] AC-L28 the next prompt after Back to shop shows the canvas again`, (await page.locator(CANVAS).count()) === 1 && (await page.locator(CANVAS).isVisible()));
  check(`[${tag}] "add it" renders CartSummary`, (await page.locator(CANVAS).locator('[data-a2ui=CartSummary]').count()) === 1);
  await page.waitForFunction(() => document.querySelector('[data-testid=cart-count]')?.textContent?.trim() === '1', null, { timeout: 10000 }).catch(() => {});
  check(`[${tag}] "add it" added the cheaper product (header count 1)`, ((await page.textContent('[data-testid=cart-count]')) || '').trim() === '1');
  check(`[${tag}] "add it" reply is the trusted added text`, /^Added Jogoo Maize Flour \(Unga\) to your basket\.$/.test(await lastReply(page)));
  await stepChecks(page, tag, 'add it', { cards: '[data-a2ui=CartSummary]', title: 'Your basket', pointer: 'Showing your basket in the main view' });
  const cartSurface = await page.locator(CANVAS).locator('[data-surface-id]').first().getAttribute('data-surface-id');

  // 4. "make it 3" -> the cart card updates in place to qty 3.
  await markNodes(page, '[data-a2ui=CartSummary]');
  await ask(page, 'make it 3');
  await identityCheck(page, tag, 'make it 3', '[data-a2ui=CartSummary]');
  await page.waitForFunction(() => document.querySelector('[data-testid=cart-count]')?.textContent?.trim() === '3', null, { timeout: 10000 }).catch(() => {});
  check(`[${tag}] "make it 3": exactly one CartSummary on screen (canvas), same surface id`, (await cards('[data-a2ui=CartSummary]').count()) === 1 && (await page.locator(CANVAS).locator(`[data-surface-id="${cartSurface}"] [data-a2ui=CartSummary]`).count()) === 1, String(cartSurface));
  check(`[${tag}] cart shows qty 3 (stepper) and header count 3`, ((await cin(page, '[data-testid=a2ui-qty-unga-2kg]').textContent()) || '').trim() === '3' && ((await page.textContent('[data-testid=cart-count]')) || '').trim() === '3');
  const total = ((await cin(page, '[data-testid=a2ui-cart-total]').textContent()) || '').trim();
  check(`[${tag}] cart total from the server (3 x ${pu})`, total === `KES ${3 * pu}`, total);
  const stepperSplit = await page.evaluate(() => ({ outside: document.querySelectorAll('[data-testid=assistant-canvas] [data-a2ui=QuantityStepper]:not([data-a2ui=CartSummary] [data-a2ui=QuantityStepper])').length, inside: document.querySelectorAll('[data-testid=assistant-canvas] [data-a2ui=CartSummary] [data-a2ui=QuantityStepper][data-product-id=unga-2kg]').length }));
  check(`[${tag}] AC-L26 no stray QuantityStepper next to the cart card (dropped server side); the cart card's own unga stepper is there`, stepperSplit.outside === 0 && stepperSplit.inside === 1, JSON.stringify(stepperSplit));
  const keysOf = () => notes().evaluateAll((els) => els.map((e) => e.getAttribute('data-slot-note') + (e.getAttribute('data-superseded') ? '(sup)' : '')));
  const noteKeys = await keysOf();
  check(`[${tag}] AC-L19/L26 slot notes after make it 3: flour turn updated, cheaper turn replaced (superseded by the unrelated cart render), cart turn "Updated in the main view"`, noteKeys.join(',') === 'updated,replaced(sup),updated' && (await noteText(2)) === 'Updated in the main view', noteKeys.join(','));
  check(`[${tag}] AC-L26 the superseded note reads "Replaced in the main view"`, (await noteText(1)) === 'Replaced in the main view');
  await stepChecks(page, tag, 'make it 3', { cards: '[data-a2ui=CartSummary]', title: 'Your basket', pointer: 'Showing your basket in the main view' });
  await tapPointer(page);
  await shot(page, `follow-qty3${sfx}.png`, `${tag} qty 3`);
  await mainShot(page, 'basket-qty3', mobile);
  // 5. Budget ask -> only products at or under 200 by catalog price, plus FilterChips.
  await ask(page, 'under 200 bob');
  const ids = await page.locator(CANVAS).locator('[data-a2ui=ProductCard]').evaluateAll((els) => els.map((e) => e.getAttribute('data-product-id')));
  const prices = [];
  for (const id of ids) prices.push(await priceOf(page, id));
  check(`[${tag}] "under 200 bob": a grid of only products at or under KES 200`, ids.length === 7 && prices.every((p) => p > 0 && p <= 200), `${ids.length} cards, prices ${prices.join(',')}`);
  const chips = await chipsMatchCards(page);
  check(`[${tag}] AC-L16 FilterChips = categories of the shown cards, with their counts, no duplicates`, chips.ok, chips.detail);
  await stepChecks(page, tag, 'under 200 bob', { cards: '[data-a2ui=ProductGrid]', title: 'Results: under KES 200', pointer: 'Showing 7 results in the main view' });
  // 7 cards plus the chips are taller than the viewport: after the pointer tap the canvas top (title row) is in view and the chips are reachable by scrolling.
  const chipVis = await insideViewport(page, '[data-testid=canvas-title]');
  check(`[${tag}] AC-L28 canvas title row inside the viewport after the pointer tap on the long budget answer`, chipVis.ok, chipVis.detail);
  check(`[${tag}] budget answer has FilterChips and the trusted price_filtered reply`, (await page.locator(CANVAS).locator('[data-a2ui=FilterChips]').count()) === 1 && (await lastReply(page)) === 'Here is what fits your budget. Prices come from the shop catalog.');
  // AC-L19/L20: a new search after the basket took the cart's slot, so that slot says where it went.
  const cartTurnNote = log(`[data-testid=turn-assistant]:has([data-slot-note=moved_search]) [data-testid=card-slot-note]`);
  check(`[${tag}] AC-L19 "under 200 bob" after the basket: four slot notes, the newest key moved_search, text "Moved to your search results"`, (await notes().count()) === 4 && (await notes().nth(3).getAttribute('data-slot-note')) === 'moved_search' && (await noteText(3)) === 'Moved to your search results', `${(await keysOf()).join(',')}, ${JSON.stringify(await noteText(3).catch(() => ''))}`);
  check(`[${tag}] AC-L19 the basket card left the screen (moved, not duplicated); the grid holds the cart's old surface id`, (await cards('[data-a2ui=CartSummary]').count()) === 0 && (await page.locator(CANVAS).locator(`[data-surface-id="${cartSurface}"] [data-a2ui=ProductGrid]`).count()) === 1 && (await cartTurnNote.count()) >= 1, String(cartSurface));
  await shot(page, `budget${sfx}.png`, `${tag} budget`);
  await tapPointer(page);
  await mainShot(page, 'new-search', mobile);

  // 6. Checkout handoff (mock, no pay).
  await ask(page, 'checkout please');
  await stepChecks(page, tag, 'checkout please', { cards: '[data-a2ui=CheckoutHandoff]', title: 'Checkout', pointer: 'Checkout is ready in the main view' });
  const vis = await insideViewport(page, '[data-testid=a2ui-go-checkout]');
  check(`[${tag}] AC-L15/L28 go-checkout button inside the viewport after the canvas is focused (pointer click)`, vis.ok, vis.detail);
  await mainShot(page, 'checkout', mobile);
  // Review 4 note, adapted: a late image growing the CHAT above must not move the canvas button out of the viewport.
  await openChat(page);
  const grew = await page.evaluate(() => new Promise((res) => {
    const turns = document.querySelectorAll('[data-testid=assistant-log] [data-testid=turn-assistant]');
    const t = turns[turns.length - 1];
    if (!t) return res(false);
    const img = document.createElement('img');
    img.alt = '';
    img.style.display = 'block';
    img.setAttribute('data-e2e-late-image', '1');
    img.addEventListener('load', () => res(true), { once: true });
    img.addEventListener('error', () => res(false), { once: true });
    t.insertBefore(img, t.firstChild);
    setTimeout(() => { img.src = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="260"/>'); }, 150);
  }));
  await page.evaluate(() => document.querySelectorAll('[data-e2e-late-image]').forEach((e) => e.remove()));
  if (mobile) await page.keyboard.press('Escape');
  if (mobile) await page.waitForFunction(() => document.querySelector('[data-testid=assistant-drawer]').getAttribute('data-open') === 'false', null, { timeout: 2000 }).catch(() => {});
  const visLate = await insideViewport(page, '[data-testid=a2ui-go-checkout]');
  check(`[${tag}] AC-L15/L28 go-checkout button still inside the viewport after a late 260px image grew the chat`, grew === true && visLate.ok, `loaded=${grew} ${visLate.detail}`);
  const ht = ((await cin(page, '[data-testid=a2ui-handoff-total]').textContent()) || '').trim();
  check(`[${tag}] checkout renders CheckoutHandoff with the server total`, ht === `KES ${3 * pu}`, ht);
  check(`[${tag}] no server action (Pay) and no STK push; still on the home page`, serverActions === 0 && stkCount() === stk0 && new URL(page.url()).pathname === '/', `actions=${serverActions} stk=${stkCount() - stk0}`);
  await shot(page, `follow-checkout${sfx}.png`, `${tag} checkout`);

  await page.waitForTimeout(300);
  const mine = plannerLines().slice(lines0);
  check(`[${tag}] six planner lines, all rendered by the mock, live counters 0`, mine.length === 6 && mine.every((l) => l.includes('outcome=rendered') && / client=mock live_constructions=0 live_transport_calls=0$/.test(l)), mine.map((l) => l.split(' ')[1]).join(','));
  check(`[${tag}] three answers replaced a card (replaced=1 in the server log): cheaper, make it 3, under 200 bob`, mine.filter((l) => / replaced=1 /.test(l)).length === 3);
  check(`[${tag}] no page errors`, errors.length === 0, errors.join(' | ').slice(0, 300));
  await ctx.close();
}

const BASE_ENV = {
  NODE_ENV: 'production',
  DUKA_PLANNER: 'claude',
  DUKA_PLANNER_CLIENT: 'mock',
  DUKA_ALLOW_LIVE: '',
  ANTHROPIC_API_KEY: '',
  DUKA_ASSISTANT_MODE: 'mock',
  DUKA_ASSISTANT_TEST_HOOKS: '',
  DUKA_DARAJA_MODE: 'mock',
  DUKA_MOCK_DELAY_MS: '600000',
  DUKA_INSECURE_COOKIES: '1',
  DUKA_SPEND_TEST_PRICE_MOCK: '',
  DUKA_SPEND_CAP_USD: '',
  DUKA_LIVE_TRACE: '',
};

function startServer(extraEnv, append) {
  const server = spawn('pnpm', ['start'], { cwd: ROOT, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...BASE_ENV, ...extraEnv } });
  const log = fs.createWriteStream(SERVER_LOG, { flags: append ? 'a' : 'w' });
  server.stdout.pipe(log);
  server.stderr.pipe(log);
  const stop = () => {
    try {
      process.kill(-server.pid, 'SIGTERM');
    } catch {}
  };
  process.on('exit', stop);
  return { server, stop };
}

// Phase 2 (SPEC-LIVE AC-L5): cap reached -> fixed note plus the regex answer, never a model render.
async function capFlow(browser, spendDir) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const lines0 = plannerLines().length;
  await page.goto(BASE + '/');
  await page.click('[data-testid=assistant-open]');
  await page.waitForFunction(() => document.activeElement && document.activeElement.getAttribute('data-testid') === 'assistant-input', null, { timeout: 10000 });
  await ask(page, 'search tea');
  const note = ((await lastIn(page, '[data-testid=turn-assistant]').locator('[data-testid=assistant-note]').textContent().catch(() => '')) || '').trim();
  check('[cap] spend cap reached: the fixed note is shown', note === 'Live Claude is paused (spend cap reached). Using the scripted helper.', note);
  check('[cap] the regex answer is still rendered (search grid and trusted reply)', (await cin(page, '[data-a2ui=ProductGrid]').count()) === 1 && (await lastReply(page)) === 'Here is what I found.');
  check('[cap] no fallback card (the regex answer is a normal answer)', !(await lastTurnHasFallback(page)));
  await shot(page, 'spend-cap-note.png', 'cap note');
  await page.waitForTimeout(300);
  const mine = plannerLines().slice(lines0);
  check('[cap] server line: outcome=fallback reason=spend_cap, live counters 0', mine.length === 1 && /outcome=fallback reason=spend_cap .* client=mock live_constructions=0 live_transport_calls=0$/.test(mine[0]), mine.join(' | '));
  const l = JSON.parse(fs.readFileSync(path.join(spendDir, 'ledger.json'), 'utf8'));
  check('[cap] the refused call charged nothing (ledger still spent 5, reserved 0, calls 0)', l.spentUSD === 5 && l.reservedUSD === 0 && l.calls === 0, JSON.stringify({ s: l.spentUSD, r: l.reservedUSD, c: l.calls }));
  // A message with no fixture never reaches the guard: no note on it.
  await ask(page, 'show household');
  check('[cap] a no-fixture message (no model call) shows no note', (await lastIn(page, '[data-testid=turn-assistant]').locator('[data-testid=assistant-note]').count()) === 0);
  check('[cap] no page errors', errors.length === 0, errors.join(' | ').slice(0, 300));
  await ctx.close();
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  if (!fs.existsSync(path.join(ROOT, '.next', 'BUILD_ID'))) {
    console.error('No production build found. Run `pnpm build` first.');
    process.exit(2);
  }
  if (!(await waitPortFree(15000))) {
    console.error(`Port ${PORT} is already in use; refusing to start a second server.`);
    process.exit(2);
  }
  // Temp ledger dirs only: the real .duka-spend/ is never touched by e2e.
  const spendMain = fs.mkdtempSync(path.join(os.tmpdir(), 'duka-e2e-spend-'));
  const spendCap = fs.mkdtempSync(path.join(os.tmpdir(), 'duka-e2e-spendcap-'));

  // NODE_ENV=production with the test-only pricing hook flag set on purpose: it must stay off (ledger stays empty).
  let { server, stop } = startServer({ DUKA_SPEND_DIR: spendMain, DUKA_SPEND_TEST_PRICE_MOCK: '1' }, false);
  console.log(`started server pid=${server.pid} (DUKA_PLANNER=claude DUKA_PLANNER_CLIENT=mock, key blank, live not allowed)`);

  let browser;
  try {
    check('server up on 3200 (claude planner, mock client)', await waitUp(30000));
    const mode = await (await fetch(BASE + '/api/assistant/mode')).json();
    check('GET /api/assistant/mode returns only {planner: claude, client: mock}', JSON.stringify(mode) === '{"planner":"claude","client":"mock"}', JSON.stringify(mode));
    browser = await chromium.launch({ executablePath: process.env.DUKA_CHROME_PATH || '/usr/bin/google-chrome', args: ['--headless=new'] });
    await flow(browser, { width: 1280, height: 860 }, false);
    await flow(browser, { width: 390, height: 844 }, true);
    await followFlow(browser, { width: 1280, height: 860 }, false);
    await followFlow(browser, { width: 390, height: 844 }, true);
    check('NODE_ENV=production + DUKA_SPEND_TEST_PRICE_MOCK=1: the pricing hook is off, the mock bypasses the ledger (temp spend dir still empty)', fs.readdirSync(spendMain).length === 0, fs.readdirSync(spendMain).join(','));
  } catch (e) {
    check('claude e2e completed without exceptions', false, String(e && e.stack ? e.stack.split('\n').slice(0, 3).join(' ') : e));
  } finally {
    stop();
    console.log(`stopped server pid=${server.pid}`);
  }

  // Phase 2: a fresh server with the test-only pricing hook and a ledger already at the $5 cap.
  try {
    fs.writeFileSync(path.join(spendCap, 'ledger.json'), JSON.stringify({ version: 1, capUSD: 5, spentUSD: 5, reservedUSD: 0, calls: 0, origins: {}, updatedAt: new Date().toISOString() }));
    check('port 3200 free again before the cap-phase server', await waitPortFree(15000));
    // The pricing hook only exists under NODE_ENV test or development, so this phase runs the build with NODE_ENV=test.
    ({ server, stop } = startServer({ NODE_ENV: 'test', DUKA_SPEND_DIR: spendCap, DUKA_SPEND_TEST_PRICE_MOCK: '1' }, true));
    console.log(`started cap-phase server pid=${server.pid} (mock priced as live, temp ledger at the cap)`);
    check('cap-phase server up on 3200', await waitUp(30000));
    await capFlow(browser, spendCap);
  } catch (e) {
    check('cap phase completed without exceptions', false, String(e && e.stack ? e.stack.split('\n').slice(0, 3).join(' ') : e));
  } finally {
    if (browser) await browser.close();
    stop();
    console.log(`stopped server pid=${server.pid}`);
  }
  await new Promise((r) => setTimeout(r, 500));
  for (const d of [spendMain, spendCap]) fs.rmSync(d, { recursive: true, force: true });
  const all = plannerLines();
  const live = all.filter((l) => !/ live_constructions=0 live_transport_calls=0$/.test(l));
  check('whole run: live client constructions and transport calls stay 0', all.length >= 20 && live.length === 0, `planner_lines=${all.length} nonzero=${live.length}`);
  console.log(`LIVE-CALL COUNTER: planner_lines=${all.length} lines_with_live_activity=${live.length}`);
  const passed = results.filter((r) => r.startsWith('PASS')).length;
  console.log(`\nCLAUDE E2E SUMMARY: ${passed} passed, ${failures} failed, ${results.length} checks`);
  process.exit(failures ? 1 : 0);
})();
