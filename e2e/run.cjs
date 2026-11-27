/* eslint-disable */
// Duka week 1 e2e. Uses the vendored Playwright (no global install) and system Chrome.
// Needs `pnpm build` first. Starts `pnpm start` (port 3200, mock mode), runs the flows,
// writes screenshots to evidence/week1/, then stops only the server it started.
const { chromium } = require(process.env.DUKA_PLAYWRIGHT_PATH || 'playwright');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'evidence', 'week1');
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

async function waitUp(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(BASE + '/');
      if (r.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

async function overflow(page, label) {
  const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  check(`no horizontal overflow: ${label}`, o.sw <= o.cw, `scrollWidth=${o.sw} clientWidth=${o.cw}`);
}

async function shot(page, name, label) {
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(OUT, name), fullPage: true });
  await overflow(page, label || name);
}

async function waitState(page, state, timeout = 15000) {
  try {
    await page.waitForSelector(`[data-testid=order-status][data-state=${state}]`, { timeout });
    return true;
  } catch {
    return false;
  }
}

async function addViaUi(page, id) {
  await page.click(`[data-testid=add-${id}]`);
  await page.waitForSelector(`[data-testid=add-${id}]:has-text("Added")`, { timeout: 5000 });
}

async function cartCount(page) {
  return Number((await page.textContent('[data-testid=cart-count]')).trim());
}

async function payWith(page, phone) {
  await page.goto(BASE + '/checkout');
  await page.fill('[data-testid=phone-input]', phone);
  await Promise.all([page.waitForURL(/\/orders\/ord_/, { timeout: 15000 }), page.click('[data-testid=pay-button]')]);
  return page.url().split('/orders/')[1];
}

async function flow(browser, vp, suffix) {
  const tag = `${vp.width}`;
  const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  // Catalog
  await page.goto(BASE + '/');
  const cards = await page.locator('[data-testid=product-card]').count();
  check(`[${tag}] catalog shows >= 8 products`, cards >= 8, `count=${cards}`);
  await shot(page, `catalog${suffix}.png`, `${tag} catalog`);

  // Product detail
  await page.click('[data-testid=product-link-unga-2kg]');
  await page.waitForURL(/\/p\/unga-2kg/);
  const price = (await page.textContent('[data-testid=product-price]')).trim();
  check(`[${tag}] product page /p/unga-2kg shows KES price`, price === 'KES 175', price);
  await addViaUi(page, 'unga-2kg');
  await page.waitForFunction(() => document.querySelector('[data-testid=cart-count]')?.textContent?.trim() === '1');
  check(`[${tag}] cart count 1 after add`, (await cartCount(page)) === 1);
  if (suffix === '') await shot(page, 'product.png', `${tag} product`);

  // Add two more from the catalog
  await page.goto(BASE + '/');
  await addViaUi(page, 'ketepa-100');
  await addViaUi(page, 'sukuma-bunch');

  // Cart: change qty, remove
  await page.goto(BASE + '/cart');
  const sub0 = (await page.textContent('[data-testid=cart-subtotal]')).trim();
  check(`[${tag}] cart subtotal 175+240+30`, sub0 === 'KES 445', sub0);
  await page.click('[data-testid=inc-unga-2kg]');
  await page.waitForFunction(() => document.querySelector('[data-testid=qty-unga-2kg]')?.textContent?.trim() === '2');
  await page.waitForFunction(() => document.querySelector('[data-testid=cart-subtotal]')?.textContent?.trim() === 'KES 620');
  check(`[${tag}] qty change updates server subtotal`, (await page.textContent('[data-testid=cart-subtotal]')).trim() === 'KES 620');
  await page.click('[data-testid=remove-sukuma-bunch]');
  await page.waitForSelector('[data-testid=line-sukuma-bunch]', { state: 'detached' });
  const sub1 = (await page.textContent('[data-testid=cart-subtotal]')).trim();
  check(`[${tag}] remove updates subtotal`, sub1 === 'KES 590', sub1);
  await shot(page, `cart${suffix}.png`, `${tag} cart`);

  // Checkout: invalid phone
  await page.click('[data-testid=go-checkout]');
  await page.waitForURL(/\/checkout/);
  const total = (await page.textContent('[data-testid=checkout-total]')).trim();
  check(`[${tag}] checkout total matches cart`, total === 'KES 590', total);
  await shot(page, `checkout${suffix}.png`, `${tag} checkout`);
  await page.fill('[data-testid=phone-input]', '0812 34');
  await page.click('[data-testid=pay-button]');
  await page.waitForFunction(() => (document.querySelector('[data-testid=phone-error]')?.textContent || '').includes('Safaricom'));
  check(`[${tag}] invalid phone shows a clear error`, true, (await page.textContent('[data-testid=phone-error]')).trim());
  check(`[${tag}] invalid phone keeps shopper on /checkout`, /\/checkout$/.test(page.url()));
  check(`[${tag}] typed phone kept after error`, (await page.inputValue('[data-testid=phone-input]')) === '0812 34');
  await shot(page, `checkout-invalid${suffix}.png`, `${tag} checkout invalid`);

  // Pay tap -> pending (000 suffix stays pending) -> paid via mock control
  await page.fill('[data-testid=phone-input]', '0712 345 000');
  await Promise.all([page.waitForURL(/\/orders\/ord_/, { timeout: 15000 }), page.click('[data-testid=pay-button]')]);
  const orderId = page.url().split('/orders/')[1];
  check(`[${tag}] pay tap creates order and shows pending`, await waitState(page, 'pending'));
  await page.waitForTimeout(2500); // a few polls, still pending
  check(`[${tag}] still pending after polling`, await waitState(page, 'pending', 1000));
  await shot(page, `pending${suffix}.png`, `${tag} pending`);
  const total2 = (await page.textContent('[data-testid=order-total]')).trim();
  check(`[${tag}] order amount computed server side`, total2 === 'KES 590', total2);
  const r = await page.evaluate(async (id) => (await fetch('/api/mock/daraja/resolve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ orderId: id, outcome: 'paid' }) })).status, orderId);
  check(`[${tag}] mock control resolves (mock mode)`, r === 200, `status=${r}`);
  check(`[${tag}] page moves to paid by polling`, await waitState(page, 'paid'));
  await shot(page, `paid${suffix}.png`, `${tag} paid`);
  check(`[${tag}] cart emptied after pay`, (await cartCount(page)) === 0);
  // terminal state does not change on a later conflicting control call
  await page.evaluate(async (id) => fetch('/api/mock/daraja/resolve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ orderId: id, outcome: 'failed' }) }), orderId);
  const st = await page.evaluate(async (id) => (await (await fetch(`/api/orders/${id}/status`)).json()).state, orderId);
  check(`[${tag}] paid order stays paid after a conflicting result`, st === 'paid', st);

  // Failed path (111 suffix, auto after delay)
  await page.goto(BASE + '/');
  await addViaUi(page, 'royco-200g');
  await payWith(page, '0712345111');
  check(`[${tag}] failed path: 111 suffix -> failed`, await waitState(page, 'failed'));
  await shot(page, `failed${suffix}.png`, `${tag} failed`);

  // Cancelled path (222 suffix)
  await page.goto(BASE + '/');
  await addViaUi(page, 'omo-1kg');
  await payWith(page, '+254 712 345 222');
  check(`[${tag}] cancelled path: 222 suffix -> cancelled`, await waitState(page, 'cancelled'));
  await shot(page, `cancelled${suffix}.png`, `${tag} cancelled`);

  // Definitive rejection (888): order failed, items back in the cart
  await page.goto(BASE + '/');
  await addViaUi(page, 'kimbo-1kg');
  await payWith(page, '0712345888');
  check(`[${tag}] rejected push (888): failed and cart restored`, (await waitState(page, 'failed')) && (await cartCount(page)) === 1);
  // Unknown outcome (999): stays pending, marked unconfirmed, cart not restored, no polling
  let statusCalls = 0;
  const onReq = (r) => {
    if (r.url().includes('/status')) statusCalls++;
  };
  page.on('request', onReq);
  await payWith(page, '0712345999');
  await page.waitForTimeout(2500);
  page.off('request', onReq);
  check(`[${tag}] unknown outcome: heading "Payment not confirmed" and no status polling`, (await page.textContent('[data-testid=order-status]')).includes('Payment not confirmed') && statusCalls === 0, `statusCalls=${statusCalls}`);
  const unconf = await page.getAttribute('[data-testid=order-status]', 'data-unconfirmed');
  const reason = ((await page.textContent('[data-testid=order-reason]')) || '').trim();
  check(`[${tag}] unknown outcome (999): pending + unconfirmed, says do not pay again`, unconf === 'true' && /do not pay again/.test(reason), reason.slice(0, 60));
  check(`[${tag}] unknown outcome keeps the cart reserved`, (await cartCount(page)) === 0);
  await shot(page, `unconfirmed${suffix}.png`, `${tag} unconfirmed`);

  // Paid by delay (no control call), any other suffix
  await page.goto(BASE + '/');
  await addViaUi(page, 'brookside-milk-500ml');
  await payWith(page, '0110123456');
  check(`[${tag}] default suffix -> paid after delay via status query`, await waitState(page, 'paid'));

  check(`[${tag}] no page errors`, errors.length === 0, errors.join(' | '));
  await ctx.close();
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  if (!fs.existsSync(path.join(ROOT, '.next', 'BUILD_ID'))) {
    console.error('No production build found. Run `pnpm build` first.');
    process.exit(2);
  }
  if (await portInUse(PORT)) {
    console.error(`Port ${PORT} is already in use; refusing to start a second server.`);
    process.exit(2);
  }
  const server = spawn('pnpm', ['start'], {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    // DUKA_ASSISTANT_TEST_HOOKS=1 is set on purpose: under NODE_ENV=production the raw-message hook must stay off.
    env: { ...process.env, NODE_ENV: 'production', DUKA_PLANNER: 'regex', DUKA_PLANNER_CLIENT: '', DUKA_ALLOW_LIVE: '', ANTHROPIC_API_KEY: '', DUKA_DARAJA_MODE: 'mock', DUKA_MOCK_DELAY_MS: '2500', DUKA_INSECURE_COOKIES: '1', DUKA_ASSISTANT_TEST_HOOKS: '1' },
  });
  const serverLog = fs.createWriteStream(path.join(ROOT, 'logs', 'e2e-server.txt'));
  server.stdout.pipe(serverLog);
  server.stderr.pipe(serverLog);
  console.log(`started server pid=${server.pid}`);
  const stop = () => {
    try {
      process.kill(-server.pid, 'SIGTERM');
    } catch {}
  };
  process.on('exit', stop);

  let browser;
  try {
    check('server up on 3200 in mock mode', await waitUp(30000));
    // AC-2: product HTML in the raw server response
    const html = await (await fetch(BASE + '/')).text();
    check('raw HTML of / contains product names and KES prices', html.includes('Jogoo Maize Flour (Unga)') && html.includes('Ketepa Pride Tea') && html.includes('KES 1,650'));
    const detail = await (await fetch(BASE + '/p/ketepa-100')).text();
    check('raw HTML of /p/ketepa-100 contains product and price', detail.includes('Ketepa Pride Tea') && detail.includes('KES 240'));
    const nf = await fetch(BASE + '/p/does-not-exist');
    check('unknown product slug is 404', nf.status === 404, `status=${nf.status}`);
    const st = await fetch(BASE + '/api/orders/ord_nope/status');
    check('status of unknown order is 404', st.status === 404);

    browser = await chromium.launch({ executablePath: process.env.DUKA_CHROME_PATH || '/usr/bin/google-chrome', args: ['--headless=new'] });
    {
      const page = await browser.newPage();
      await page.goto(BASE + '/');
      await page.click('[data-testid=assistant-open]');
      await page.waitForSelector('[data-testid=assistant-input]', { timeout: 10000 });
      await page.waitForTimeout(500);
      check('NODE_ENV=production with DUKA_ASSISTANT_TEST_HOOKS=1: the raw-message test hook is absent', await page.evaluate(() => typeof window.__dukaAssistantTest === 'undefined'));
      await page.close();
    }
    await flow(browser, { width: 1280, height: 860 }, '');
    await flow(browser, { width: 390, height: 844 }, '-mobile');
  } catch (e) {
    check('e2e run completed without exceptions', false, String(e && e.stack ? e.stack.split('\n').slice(0, 3).join(' ') : e));
  } finally {
    if (browser) await browser.close();
    stop();
    console.log(`stopped server pid=${server.pid}`);
  }
  const passed = results.filter((r) => r.startsWith('PASS')).length;
  console.log(`\nE2E SUMMARY: ${passed} passed, ${failures} failed, ${results.length} checks`);
  process.exit(failures ? 1 : 0);
})();
