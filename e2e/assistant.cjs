/* eslint-disable */
// Duka week 2 e2e: the A2UI assistant panel at 1280 and 390.
// Uses the vendored Playwright (no global install) and system Chrome. Needs `pnpm build`.
// Starts `pnpm start` on 3200 in mock mode with the test hook flag, runs the panel flows,
// writes screenshots to evidence/week2/, then stops only the server it started.
const { chromium } = require(process.env.DUKA_PLAYWRIGHT_PATH || 'playwright');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'evidence', 'week2');
const OUT_2B = path.join(ROOT, 'evidence', 'week2b');
// evidence/week2 is frozen after review (week 2b brief): its shots are only rewritten with E2E_WRITE_WEEK2=1.
// Otherwise the week 2 flow still runs all its checks but writes its screenshots to a scratch folder.
const WEEK2_DIR = process.env.E2E_WRITE_WEEK2 === '1' ? OUT : fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'duka-week2-shots-'));
// SPEC-LIVE AC-L28 screenshots (viewport only): main-area canvas with the chat sheet collapsed on mobile.
const MAIN_OUT = path.join(ROOT, 'evidence', 'main-area-20261126');
const SERVER_LOG = path.join(ROOT, 'logs', 'e2e-assistant-server.txt');
const PORT = 3200;
const BASE = `http://localhost:${PORT}`;
const CATALOG_ID = 'https://duka.local/a2ui/catalog/v2';
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

// The mock adapter logs exactly one `mock.stk.*` line per STK push (see the mock Daraja adapter); nothing else uses that prefix.
const stkCount = () => (fs.existsSync(SERVER_LOG) ? (fs.readFileSync(SERVER_LOG, 'utf8').match(/\[daraja\] mock\.stk\.\w+/g) || []).length : 0);

async function overflow(page, label) {
  const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  check(`no horizontal overflow: ${label}`, o.sw <= o.cw, `scrollWidth=${o.sw} clientWidth=${o.cw}`);
  const d = await page.evaluate(() => {
    const el = document.querySelector('[data-testid=assistant-log]');
    return el ? { sw: el.scrollWidth, cw: el.clientWidth } : null;
  });
  if (d) check(`no horizontal overflow inside the panel: ${label}`, d.sw <= d.cw, `scrollWidth=${d.sw} clientWidth=${d.cw}`);
}

async function shot(page, name, label, opts = {}) {
  await page.waitForTimeout(400); // drawer transition settles
  // Show the newest turn: jump past any smooth scroll still in flight.
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid=assistant-log]');
    if (el) {
      el.style.scrollBehavior = 'auto';
      el.scrollTop = el.scrollHeight;
    }
  });
  await page.waitForTimeout(150);
  if (opts.fullPage) {
    // Chrome only paints (and decodes) images that have been on screen; scroll through once before a full-page capture.
    await page.evaluate(async () => {
      for (let y = 0; y < document.documentElement.scrollHeight; y += 400) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 60));
      }
      window.scrollTo(0, 0);
      await Promise.all([...document.images].map((i) => (i.decode ? i.decode().catch(() => {}) : null)));
    });
    await page.waitForTimeout(200);
  }
  await page.screenshot({ path: path.join(opts.dir || WEEK2_DIR, name), fullPage: Boolean(opts.fullPage) });
  await overflow(page, label || name);
}

const activeTestId = (page) => page.evaluate(() => document.activeElement && document.activeElement.getAttribute('data-testid'));
const isOpen = (page) => page.getAttribute('[data-testid=assistant-drawer]', 'data-open');

async function waitIdle(page) {
  await page.waitForFunction(() => !document.querySelector('[data-testid=assistant-typing]'), null, { timeout: 10000 });
}

const CANVAS = '[data-testid=assistant-canvas]';
const inputFocused = () => document.activeElement && document.activeElement.getAttribute('data-testid') === 'assistant-input';

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
  await page.waitForFunction((n) => document.querySelectorAll('[data-testid=turn-assistant]').length > n, before, { timeout: 10000 });
  await waitIdle(page);
  // AC-L27: on a narrow screen the sheet collapses (a short timer after the answer) when cards were shown.
  if ((page.viewportSize() || { width: 1280 }).width < 1024) await page.waitForFunction(() => document.querySelector('[data-testid=assistant-drawer]').getAttribute('data-open') === 'false', null, { timeout: 1500 }).catch(() => {});
}

const lastIn = (page, sel) => page.locator(`[data-testid=assistant-log] ${sel}`).last();
/** Cards live in the main-area canvas (AC-L23). */
const cin = (page, sel) => page.locator(`${CANVAS} ${sel}`).last();

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

/** The shopper taps the pointer line: on a narrow screen that means reopening the sheet first (the tap then collapses it again). */
async function tapPointer(page) {
  if ((page.viewportSize() || { width: 1280 }).width < 1024) await openChat(page);
  await page.locator('[data-testid=assistant-log] [data-testid=canvas-pointer]').last().click();
  if ((page.viewportSize() || { width: 1280 }).width < 1024) await page.waitForFunction(() => document.querySelector('[data-testid=assistant-drawer]').getAttribute('data-open') === 'false', null, { timeout: 3000 });
}

/** After clicking the pointer line the canvas is scrolled and focused: the element must be inside the viewport (replaces the AC-L15 log-rect check). */
async function insideViewport(page, sel) {
  await tapPointer(page);
  await page.waitForFunction((s) => [...document.querySelectorAll(`[data-testid=assistant-canvas] img`)].every((i) => i.complete), null, { timeout: 10000 }).catch(() => {});
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

/** Viewport-only screenshot for evidence/main-area-20261126. Waits for the smooth scroll and the canvas images. */
async function mainShot(page, name, mobile) {
  fs.mkdirSync(MAIN_OUT, { recursive: true });
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid=assistant-canvas] img')].every((i) => i.complete), null, { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(900);
  await page.screenshot({ path: path.join(MAIN_OUT, `${mobile ? 'mobile' : 'desktop'}-${name}.png`), fullPage: false });
}

async function flow(browser, vp, suffix) {
  const tag = `${vp.width}`;
  const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = [];
  const mobile = suffix === '-mobile';
  page.on('pageerror', (e) => errors.push(String(e)));
  // Server action calls (the Pay tap is the only one in the app) carry a next-action header.
  let serverActions = 0;
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.headers()['next-action']) serverActions++;
  });
  const stk0 = stkCount();

  await page.goto(BASE + '/');

  // AC-W2-1: open by button, focus moves in, Escape closes, focus returns.
  const opener = page.locator('[data-testid=assistant-open]');
  check(`[${tag}] header has a labelled assistant button`, (await opener.count()) === 1 && /Assistant/.test((await opener.textContent()) || ''));
  await opener.click();
  await page.waitForFunction(() => document.activeElement && document.activeElement.getAttribute('data-testid') === 'assistant-input', null, { timeout: 10000 });
  check(`[${tag}] button opens the panel and focuses the input`, (await isOpen(page)) === 'true' && (await activeTestId(page)) === 'assistant-input');
  check(`[${tag}] panel is a labelled dialog`, (await page.getAttribute('[data-testid=assistant-drawer]', 'role')) === 'dialog' && (await page.textContent('#assistant-title')) === 'Duka assistant');
  // SPEC-LIVE AC-L1: subtitle from the server mode (regex planner here).
  check(`[${tag}] subtitle in regex mode is the scripted-helper text`, ((await page.textContent('[data-testid=assistant-subtitle]')) || '').trim() === 'Scripted helper. It never pays for you.');
  check(`[${tag}] opener reports aria-expanded=true`, (await opener.getAttribute('aria-expanded')) === 'true');
  await shot(page, `panel-open${suffix}.png`, `${tag} panel open`);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.querySelector('[data-testid=assistant-drawer]').getAttribute('data-open') === 'false');
  check(`[${tag}] Escape closes the panel and focus returns to the opener`, (await activeTestId(page)) === 'assistant-open');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.activeElement && document.activeElement.getAttribute('data-testid') === 'assistant-input', null, { timeout: 10000 });
  check(`[${tag}] keyboard (Enter on the focused opener) opens the panel`, (await isOpen(page)) === 'true');

  // Products
  await ask(page, 'search tea');
  const ketepa = cin(page, '[data-a2ui=ProductCard][data-product-id=ketepa-100]');
  check(`[${tag}] "search tea" renders ProductCards from the trusted catalog (in the canvas)`, (await ketepa.count()) === 1);
  check(`[${tag}] ProductCard price comes from the catalog`, ((await cin(page, '[data-testid=a2ui-price-ketepa-100]').textContent()) || '').trim() === 'KES 240');
  await stepChecks(page, tag, 'search tea', { cards: '[data-a2ui=ProductGrid]', title: 'Results', pointer: 'Showing 2 results in the main view' });
  check(`[${tag}] AC-L27 ${mobile ? 'mobile: the chat sheet collapsed after the answer' : 'desktop: the drawer stays docked open with the canvas visible'}`, (await isOpen(page)) === (mobile ? 'false' : 'true') && (await page.locator(CANVAS).isVisible()));
  if (mobile) {
    const handle = page.locator('[data-testid=assistant-sheet-handle]');
    check(`[${tag}] AC-L27 mobile: the "Chat" handle shows`, (await handle.count()) === 1 && ((await handle.textContent()) || '').trim() === 'Chat');
    await handle.click();
    await page.waitForFunction(inputFocused, null, { timeout: 10000 });
    check(`[${tag}] AC-L27 mobile: the handle reopens the sheet with the conversation still there`, (await isOpen(page)) === 'true' && (await page.locator('[data-testid=turn-user]').count()) >= 1 && ((await page.textContent('[data-testid=assistant-log]')) || '').includes('search tea'));
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.querySelector('[data-testid=assistant-drawer]').getAttribute('data-open') === 'false');
  }
  await shot(page, `components-products${suffix}.png`, `${tag} products`);

  // Agent-wired add_to_cart from a ProductCard updates the server cart and the header.
  await cin(page, '[data-testid=a2ui-add-ketepa-100]').click();
  await page.waitForFunction(() => document.querySelector('[data-testid=cart-count]')?.textContent?.trim() === '1', null, { timeout: 10000 });
  check(`[${tag}] ProductCard Add (add_to_cart) updates the server cart count`, true);

  // Compare
  await ask(page, 'compare ketepa and kericho gold');
  check(`[${tag}] compare renders a CompareTable`, (await cin(page, '[data-a2ui=CompareTable]').count()) === 1);
  const cp = ((await cin(page, '[data-testid=a2ui-compare-price-kericho-gold-50]').textContent()) || '').trim();
  check(`[${tag}] compare prices come from the catalog`, cp === 'KES 135', cp);
  await stepChecks(page, tag, 'compare', { cards: '[data-a2ui=CompareTable]', title: 'Compare: 2 products', pointer: 'Showing the comparison in the main view' });
  await shot(page, `components-compare${suffix}.png`, `${tag} compare`);
  await insideViewport(page, '[data-a2ui=CompareTable]');
  await mainShot(page, 'compare', mobile);


  // AC-L24: Back to shop hides the canvas and shows the catalogue; the next prompt brings the canvas back.
  await backToShop(page, tag, 'after compare');
  check(`[${tag}] AC-L24 the conversation is kept after Back to shop`, (await page.locator('[data-testid=turn-user]').count()) >= 2);

  // Cart, change quantity via text and via the stepper.
  await ask(page, 'add 2 unga');
  check(`[${tag}] AC-L24 the next prompt after Back to shop shows the canvas again`, (await page.locator(CANVAS).count()) === 1);
  await ask(page, 'show cart');
  check(`[${tag}] "show cart" renders CartSummary`, (await cin(page, '[data-a2ui=CartSummary]').count()) === 1);
  await stepChecks(page, tag, 'show cart', { cards: '[data-a2ui=CartSummary]', title: 'Your basket', pointer: 'Showing your basket in the main view' });
  await cin(page, '[data-testid=a2ui-inc-unga-2kg]').click();
  await page.waitForFunction(() => {
    const q = [...document.querySelectorAll('[data-testid=assistant-canvas] [data-testid=a2ui-qty-unga-2kg]')].pop();
    return q && q.textContent.trim() === '3';
  }, null, { timeout: 10000 });
  const total = ((await cin(page, '[data-testid=a2ui-cart-total]').textContent()) || '').trim();
  check(`[${tag}] stepper set_quantity: server subtotal 240 + 3 x 175`, total === 'KES 765', total);
  await page.waitForFunction(() => document.querySelector('[data-testid=cart-count]')?.textContent?.trim() === '4', null, { timeout: 10000 });
  check(`[${tag}] header cart count follows the assistant (4)`, true);
  await shot(page, `components-cart${suffix}.png`, `${tag} cart`);

  // Handoff
  await ask(page, 'checkout');
  const ht = ((await cin(page, '[data-testid=a2ui-handoff-total]').textContent()) || '').trim();
  check(`[${tag}] "checkout" renders CheckoutHandoff with the server total`, ht === 'KES 765', ht);
  await stepChecks(page, tag, 'checkout', { cards: '[data-a2ui=CheckoutHandoff]', title: 'Checkout', pointer: 'Checkout is ready in the main view' });
  const vis = await insideViewport(page, '[data-testid=a2ui-go-checkout]');
  check(`[${tag}] AC-L15/L28 go-checkout button inside the viewport after the canvas is focused (pointer click)`, vis.ok, vis.detail);
  await mainShot(page, 'checkout-regex', mobile);
  await shot(page, `handoff${suffix}.png`, `${tag} handoff`);
  await ask(page, 'pay now');
  const payReply = ((await lastIn(page, '[data-testid=turn-assistant] > p').textContent()) || '').trim();
  check(`[${tag}] "pay now" is refused in words; only a handoff is offered`, /cannot pay/.test(payReply), payReply.slice(0, 50));

  // Fallback for bad messages, through the mock-mode test hook (same client gate as real replies).
  check(`[${tag}] test hook present (NODE_ENV=test + regex planner + DUKA_ASSISTANT_TEST_HOOKS=1)`, await page.evaluate(() => typeof window.__dukaAssistantTest?.inject === 'function'));
  const fb0 = await page.locator('[data-testid=a2ui-fallback]').count();
  const injected = await page.evaluate((CAT) => {
    const cs = (id) => ({ version: '1.0', createSurface: { surfaceId: id, catalogId: CAT } });
    const uc = (id, components) => ({ version: '1.0', updateComponents: { surfaceId: id, components } });
    const cases = {
      unknownComponent: [cs('x1'), uc('x1', [{ id: 'root', component: 'EvilIframe', title: 'x' }])],
      payAction: [cs('x2'), uc('x2', [{ id: 'root', component: 'ProductCard', productId: 'unga-2kg', onAdd: { event: { name: 'pay', context: {} } } }])],
      scriptText: [cs('x3'), uc('x3', [{ id: 'root', component: 'CartSummary', title: '<img src=x onerror="window.__pwned=1">' }])],
      fakePrice: [cs('x4'), uc('x4', [{ id: 'root', component: 'ProductCard', productId: 'unga-2kg', priceKES: 1 }])],
      fakePriceTitle: [cs('x8'), uc('x8', [{ id: 'root', component: 'ProductGrid', title: 'Unga now 1/- only', children: ['c'] }, { id: 'c', component: 'ProductCard', productId: 'unga-2kg' }])],
      offSite: [cs('x5'), uc('x5', [{ id: 'root', component: 'CartSummary', title: 'https://evil.example' }])],
      oversize: [cs('x6'), { version: '1.0', updateDataModel: { surfaceId: 'x6', path: '/', value: { pad: 'y'.repeat(20000) } } }],
      deepTree: [cs('x7'), uc('x7', [
        { id: 'root', component: 'ProductGrid', children: ['g2'] },
        { id: 'g2', component: 'ProductGrid', children: ['g3'] },
        { id: 'g3', component: 'ProductGrid', children: ['c'] },
        { id: 'c', component: 'ProductCard', productId: 'unga-2kg' },
      ])],
    };
    const out = {};
    for (const [k, v] of Object.entries(cases)) out[k] = window.__dukaAssistantTest.inject(v);
    return out;
  }, CATALOG_ID);
  for (const [k, r] of Object.entries(injected)) check(`[${tag}] bad message "${k}" rejected`, r.ok === false, r.codes.join(','));
  await page.waitForTimeout(300);
  const fb1 = await page.locator('[data-testid=a2ui-fallback]').count();
  check(`[${tag}] each rejected message shows the fallback card "I could not show that"`, fb1 - fb0 === Object.keys(injected).length && /I could not show that/.test((await lastIn(page, '[data-testid=a2ui-fallback]').textContent()) || ''), `new=${fb1 - fb0}`);
  check(`[${tag}] fake-price title "Unga now 1/- only" is not on screen (chat or canvas)`, !(await page.locator('[data-testid=assistant-log]').textContent()).includes('1/-') && !((await page.locator(CANVAS).textContent().catch(() => '')) || '').includes('1/-'));
  check(`[${tag}] rejected messages leave a fallback card in the chat only, still no [data-a2ui] in the chat`, (await page.locator(`[data-testid=assistant-log] [data-testid=a2ui-fallback]`).count()) > 0 && (await page.locator(`${CANVAS} [data-testid=a2ui-fallback]`).count()) === 0 && (await page.locator('[data-testid=assistant-log] [data-a2ui]').count()) === 0);
  check(`[${tag}] nothing from the bad messages rendered or ran`, (await page.locator('[data-a2ui=EvilIframe], [data-surface-id^=x]').count()) === 0 && (await page.evaluate(() => window.__pwned === undefined)));
  await shot(page, `fallback-rejected${suffix}.png`, `${tag} fallback`);
  const good = await page.evaluate((CAT) => window.__dukaAssistantTest.inject([{ version: '1.0', createSurface: { surfaceId: 'ok1', catalogId: CAT } }, { version: '1.0', updateComponents: { surfaceId: 'ok1', components: [{ id: 'root', component: 'QuantityStepper', productId: 'unga-2kg' }] } }]), CATALOG_ID);
  check(`[${tag}] a valid injected message still renders (the gate is not just closed)`, good.ok === true && (await page.locator('[data-testid=assistant-canvas] [data-surface-id=ok1] [data-a2ui=QuantityStepper]').count()) === 1, 'accepted injected surface renders in the canvas');

  // AC-W2-6: panel use, including go_to_checkout, creates no order and no STK until Pay.
  check(`[${tag}] no server action (Pay) call during panel use`, serverActions === 0, `count=${serverActions}`);
  check(`[${tag}] no STK push during panel use (server log)`, stkCount() === stk0, `before=${stk0} now=${stkCount()}`);
  // The injected surface took the canvas; ask again so the handoff card is the one on screen.
  await ask(page, 'checkout');
  await cin(page, '[data-testid=a2ui-go-checkout]').click();
  await page.waitForURL(/\/checkout$/, { timeout: 10000 });
  await page.waitForFunction(() => document.querySelector('[data-testid=assistant-drawer]')?.getAttribute('data-open') === 'false');
  check(`[${tag}] go_to_checkout navigates to /checkout and closes the panel`, true);
  check(`[${tag}] AC-L23 go_to_checkout hides the canvas on /checkout`, (await page.locator(CANVAS).count()) === 0);
  const ct = ((await page.textContent('[data-testid=checkout-total]')) || '').trim();
  check(`[${tag}] checkout shows the same server total, nothing paid yet`, ct === 'KES 765', ct);
  await page.waitForTimeout(500);
  check(`[${tag}] after go_to_checkout: still no server action and no STK`, serverActions === 0 && stkCount() === stk0, `actions=${serverActions} stk=${stkCount() - stk0}`);
  check(`[${tag}] after go_to_checkout: cart intact (no order took it)`, ((await page.textContent('[data-testid=cart-count]')) || '').trim() === '4');

  // The panel is on /checkout too, and asking it to pay there still does nothing.
  await page.click('[data-testid=assistant-open]');
  await page.waitForFunction(() => document.activeElement && document.activeElement.getAttribute('data-testid') === 'assistant-input', null, { timeout: 10000 });
  await ask(page, 'pay now');
  check(`[${tag}] "pay now" on /checkout: no server action, no STK`, serverActions === 0 && stkCount() === stk0);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.querySelector('[data-testid=assistant-drawer]').getAttribute('data-open') === 'false');

  // Only the shopper's Pay tap creates the order and the (mock) STK push.
  await page.fill('[data-testid=phone-input]', '0712 345 000');
  await Promise.all([page.waitForURL(/\/orders\/ord_/, { timeout: 15000 }), page.click('[data-testid=pay-button]')]);
  await page.waitForTimeout(500);
  check(`[${tag}] Pay tap: exactly one server action and one STK push`, serverActions === 1 && stkCount() === stk0 + 1, `actions=${serverActions} stk=${stkCount() - stk0}`);

  // Order status card from the panel.
  await page.click('[data-testid=assistant-open]');
  await page.waitForFunction(() => document.activeElement && document.activeElement.getAttribute('data-testid') === 'assistant-input', null, { timeout: 10000 });
  await ask(page, 'order status');
  const os = await cin(page, '[data-a2ui=OrderStatusCard]').getAttribute('data-state');
  check(`[${tag}] "order status" renders OrderStatusCard (pending) in the canvas`, os === 'pending', os);
  await stepChecks(page, tag, 'order status', { cards: '[data-a2ui=OrderStatusCard]', title: 'Your order', pointer: 'Showing your order in the main view' });
  await page.waitForTimeout(600);
  if (suffix === '') await shot(page, 'order-status.png', `${tag} order status`);
  await insideViewport(page, '[data-a2ui=OrderStatusCard]');
  await mainShot(page, 'order', mobile);

  check(`[${tag}] no page errors`, errors.length === 0, errors.join(' | ').slice(0, 300));
  await ctx.close();
}

// ---------- week 2b: product images ----------

/** Every <img> under `scope` has loaded (complete, naturalWidth > 0), uses a catalog path, and has alt text. */
async function imagesLoaded(page, scope, min) {
  await page.waitForFunction(
    ({ scope, min }) => {
      const imgs = [...document.querySelectorAll(`${scope} img`)];
      return imgs.length >= min && imgs.every((i) => i.complete && i.naturalWidth > 0);
    },
    { scope, min },
    { timeout: 15000 },
  ).catch(() => {});
  return page.evaluate((scope) => {
    const imgs = [...document.querySelectorAll(`${scope} img`)];
    return {
      n: imgs.length,
      loaded: imgs.filter((i) => i.complete && i.naturalWidth > 0).length,
      paths: imgs.every((i) => /^\/products\/[a-z0-9-]+\.webp$/.test(new URL(i.src).pathname) && new URL(i.src).origin === location.origin),
      alts: imgs.every((i) => (i.getAttribute('alt') || '').length > 0),
    };
  }, scope);
}

function checkImages(tag, label, r, min) {
  check(`[${tag}] 2b images load in ${label}`, r.n >= min && r.loaded === r.n, `loaded=${r.loaded}/${r.n}`);
  check(`[${tag}] 2b images in ${label} use catalog paths on this origin and have alt text`, r.paths && r.alts);
}

async function imagesFlow(browser, vp, suffix) {
  const tag = `${vp.width}`;
  const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const o = { dir: OUT_2B };

  // Catalog grid
  await page.goto(BASE + '/');
  checkImages(tag, 'the catalog grid', await imagesLoaded(page, '[data-testid=product-card]', 12), 12);
  const alt = await page.getAttribute('[data-testid=product-card][data-product-id=unga-2kg] img', 'alt');
  check(`[${tag}] 2b catalog image alt is the product name`, alt === 'Jogoo Maize Flour (Unga)', alt);
  await shot(page, `catalog-grid${suffix}.png`, `${tag} 2b catalog grid`, { ...o, fullPage: true });

  // Product detail
  await page.goto(BASE + '/p/ketepa-100');
  checkImages(tag, 'the product detail page', await imagesLoaded(page, '[data-testid=product-detail]', 1), 1);
  await shot(page, `product-card${suffix}.png`, `${tag} 2b product detail`, o);

  // Panel components
  await page.click('[data-testid=assistant-open]');
  await page.waitForFunction(() => document.activeElement && document.activeElement.getAttribute('data-testid') === 'assistant-input', null, { timeout: 10000 });
  await ask(page, 'search tea');
  checkImages(tag, 'the panel ProductGrid', await imagesLoaded(page, '[data-testid=assistant-canvas] [data-a2ui=ProductGrid]', 2), 2);
  await shot(page, `panel-products${suffix}.png`, `${tag} 2b panel products`, o);
  await ask(page, 'compare ketepa and kericho gold');
  checkImages(tag, 'the panel CompareTable', await imagesLoaded(page, '[data-testid=assistant-canvas] [data-a2ui=CompareTable]', 2), 2);
  await shot(page, `panel-compare${suffix}.png`, `${tag} 2b panel compare`, o);
  await ask(page, 'add 2 unga');
  await ask(page, 'add omo');
  await ask(page, 'show cart');
  const cartScope = '[data-testid=assistant-canvas] [data-a2ui=CartSummary]';
  checkImages(tag, 'the panel CartSummary', await imagesLoaded(page, cartScope, 2), 2);
  await shot(page, `panel-cart${suffix}.png`, `${tag} 2b panel cart`, o);
  await page.keyboard.press('Escape');

  // Cart page uses the same component.
  await page.goto(BASE + '/cart');
  checkImages(tag, 'the cart page', await imagesLoaded(page, '[data-testid=cart-lines]', 2), 2);

  // A failed image falls back to the emoji tile (onError or pre-hydration failure).
  const p2 = await ctx.newPage();
  await p2.route('**/products/omo-1kg.webp', (r) => r.fulfill({ status: 404, body: '' }));
  await p2.goto(BASE + '/');
  await p2.waitForFunction(() => !document.querySelector('[data-testid=product-card][data-product-id=omo-1kg] img'), null, { timeout: 10000 }).catch(() => {});
  const fb = await p2.evaluate(() => {
    const c = document.querySelector('[data-testid=product-card][data-product-id=omo-1kg]');
    return { img: Boolean(c && c.querySelector('img')), emoji: Boolean(c && c.textContent.includes('\u{1F9FC}')) };
  });
  check(`[${tag}] 2b a failing image shows the emoji placeholder instead`, !fb.img && fb.emoji, JSON.stringify(fb));
  const others = await imagesLoaded(p2, '[data-testid=product-card]:not([data-product-id=omo-1kg])', 11);
  check(`[${tag}] 2b the other 11 catalog images still load`, others.n === 11 && others.loaded === 11, `loaded=${others.loaded}/${others.n}`);
  await p2.close();

  check(`[${tag}] 2b no page errors`, errors.length === 0, errors.join(' | ').slice(0, 300));
  await ctx.close();
}

async function waitPortFree(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!(await portInUse(PORT))) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

(async () => {
  fs.mkdirSync(OUT_2B, { recursive: true });
  if (!fs.existsSync(path.join(ROOT, '.next', 'BUILD_ID'))) {
    console.error('No production build found. Run `pnpm build` first.');
    process.exit(2);
  }
  if (!(await waitPortFree(15000))) {
    console.error(`Port ${PORT} is already in use; refusing to start a second server.`);
    process.exit(2);
  }
  const server = spawn('pnpm', ['start'], {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    // The raw-message test hook only exists when NODE_ENV is test or development (never production), so this
    // run starts the production build with NODE_ENV=test. e2e/run.cjs checks the hook is absent under production.
    env: { ...process.env, NODE_ENV: 'test', DUKA_PLANNER: 'regex', DUKA_PLANNER_CLIENT: '', DUKA_ALLOW_LIVE: '', ANTHROPIC_API_KEY: '', DUKA_DARAJA_MODE: 'mock', DUKA_ASSISTANT_MODE: 'mock', DUKA_ASSISTANT_TEST_HOOKS: '1', DUKA_MOCK_DELAY_MS: '600000', DUKA_INSECURE_COOKIES: '1' },
  });
  const serverLog = fs.createWriteStream(SERVER_LOG);
  server.stdout.pipe(serverLog);
  server.stderr.pipe(serverLog);
  console.log(`started server pid=${server.pid}`);
  console.log(`week 2 screenshots -> ${path.relative(ROOT, WEEK2_DIR) || WEEK2_DIR}; week 2b screenshots -> evidence/week2b`);
  const stop = () => {
    try {
      process.kill(-server.pid, 'SIGTERM');
    } catch {}
  };
  process.on('exit', stop);

  let browser;
  try {
    check('server up on 3200 (mock, assistant test hooks on)', await waitUp(30000));
    const html = await (await fetch(BASE + '/')).text();
    check('raw HTML of / still has products (week 1 SSR) and the assistant button', html.includes('Ketepa Pride Tea') && html.includes('data-testid="assistant-open"'));
    const mode = await (await fetch(BASE + '/api/assistant/mode')).json();
    check('GET /api/assistant/mode returns only {planner: regex, client: none}', JSON.stringify(mode) === '{"planner":"regex","client":"none"}', JSON.stringify(mode));
    browser = await chromium.launch({ executablePath: process.env.DUKA_CHROME_PATH || '/usr/bin/google-chrome', args: ['--headless=new'] });
    await flow(browser, { width: 1280, height: 860 }, '');
    await flow(browser, { width: 390, height: 844 }, '-mobile');
    await imagesFlow(browser, { width: 1280, height: 860 }, '');
    await imagesFlow(browser, { width: 390, height: 844 }, '-mobile');
  } catch (e) {
    check('assistant e2e completed without exceptions', false, String(e && e.stack ? e.stack.split('\n').slice(0, 3).join(' ') : e));
  } finally {
    if (browser) await browser.close();
    stop();
    console.log(`stopped server pid=${server.pid}`);
  }
  const passed = results.filter((r) => r.startsWith('PASS')).length;
  console.log(`\nASSISTANT E2E SUMMARY: ${passed} passed, ${failures} failed, ${results.length} checks`);
  process.exit(failures ? 1 : 0);
})();
