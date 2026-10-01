// Explicit browser check: node --import tsx --test tests/dashboard.smoke.ts
// Requires the Playwright Chromium browser; no network or trading credentials.
// DASHBOARD_CHROMIUM_PATH can select an existing compatible Chromium executable.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { test } from 'node:test';
import { chromium, type Page } from 'playwright';
import { binaryView, type EpisodeQuote } from '../src/episode-tracker.js';
import type { Episode } from '../src/episode.js';

function episode(now = Date.now()): Episode {
  const startsAt = now - 60_000, endsAt = startsAt + 3_600_000;
  return {
    version: 1, id: 'browser-fixture', createdAt: now,
    theme: 'The AI infrastructure gold rush', startsAt, endsAt, perpNetwork: 'mainnet',
    perp: { coin: 'TAO', side: 'long', leverage: 10, marginUsd: 50,
      thesis: 'A thematic bet on demand for decentralized AI infrastructure.' },
    binary: {
      side: 'down', budgetUsd: 50, limitPrice: 0.55,
      market: {
        venue: 'polymarket-us', slug: 'fixture-btc-hour', eventSlug: 'fixture-btc-hour',
        title: 'BTC Up or Down: 60 min', startsAt, endsAt,
        settlementAt: endsAt + 300_000, rules: 'UP wins at or above the reference price; otherwise DOWN wins.',
        priceTick: 0.01, minimumShares: 1, feeCoefficient: 0.0695, priceToBeat: 84000, status: 'OPEN',
      },
    },
  };
}

function quote(now = Date.now()): EpisodeQuote {
  return { buyPrice: .54, sellPrice: .52, availableShares: 1000, sellAvailableShares: 1000,
    updatedAt: now, status: 'MARKET_STATE_OPEN' };
}

function fill(e: Episode, now = Date.now()): Episode {
  e.binary.order = {
    id: 'filled-fixture', marketSlug: e.binary.market.slug, side: e.binary.side,
    filledShares: 90, averagePrice: .5, totalCostUsd: 45, feesUsd: 1.56,
    status: 'ORDER_STATE_FILLED', updatedAt: now,
  };
  e.binary.positionCheckedAt = now;
  return e;
}

const livePerp = {
  wallet: 'fixture-wallet', stale: false, accountValue: 100,
  position: {
    coin: 'TAO', dex: '', side: 'LONG', size: 1, entryPx: 500, markPx: 505,
    leverage: 10, notional: 505, unrealizedPnl: 5, roiPct: 10, marginUsed: 50,
    liqPx: 460, distToLiqPct: 8.9, drownPct: 0, fundingPaid: .02,
    fundingHourly: -.01, openedTs: Date.now() - 60_000, ageMs: 60_000,
  },
};

test('paired dashboard browser smoke checks', { timeout: 90_000 }, async (t) => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  let state: unknown = { wallet: null };
  let episodeResponse: unknown = { episode: null, binary: null };
  let episodeStatus = 200;
  const server = createServer((req, res) => {
    if (req.url === '/' || req.url?.startsWith('/?')) {
      res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(html); return;
    }
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/state') { res.end(JSON.stringify(state)); return; }
    if (req.url === '/api/episode') { res.statusCode = episodeStatus; res.end(JSON.stringify(episodeResponse)); return; }
    if (req.url?.startsWith('/api/history')) { res.end(JSON.stringify([{ ts: Date.now() - 60_000, mark: 500 }])); return; }
    if (req.url?.startsWith('/api/replay')) { res.end(JSON.stringify({ error: 'No archived fixture' })); return; }
    res.statusCode = 404; res.end('{}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const browser = await chromium.launch({ headless: true, executablePath: process.env.DASHBOARD_CHROMIUM_PATH })
    .catch(error => { server.close(); throw error; });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1050 }, timezoneId: 'America/Los_Angeles' });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
  const text = (selector: string) => page.locator(selector).innerText();
  async function load() {
    await page.goto(origin);
    await page.locator('#episode-feed').filter({ hasText: /No episode prepared|Paired episode selected|Binary data is stale|Episode feed unavailable/ }).waitFor();
  }
  async function noOverflow(p: Page) {
    const bounds = await p.evaluate(() => ({ width: innerWidth, documentWidth: document.documentElement.scrollWidth,
      cards: [...document.querySelectorAll('.episode-card')].map(el => ({ left: el.getBoundingClientRect().left, right: el.getBoundingClientRect().right })) }));
    assert.ok(bounds.documentWidth <= bounds.width, `document overflow: ${JSON.stringify(bounds)}`);
    for (const card of bounds.cards) assert.ok(card.left >= 0 && card.right <= bounds.width, `card overflow: ${JSON.stringify(card)}`);
  }
  try {
    await t.test('standby explains the two planned roles without fabricated holdings', async () => {
      await load();
      assert.equal(await page.locator('#episode').isVisible(), true);
      assert.match(await text('#episode-description'), /hourly Bitcoin binary and a perp/);
      assert.equal(await text('#binary-pnl'), 'Awaiting execution');
      assert.equal(await text('#perp-live-pnl'), 'Awaiting live position');
      assert.equal(await text('#binary-shares'), '—');
      assert.equal(await text('#binary-payout'), '—');
      assert.equal(await page.locator('button').count(), 0);
    });
    await t.test('planned paired episode displays quotes and distinct cutoff/settlement timing', async () => {
      const e = episode();
      episodeResponse = { episode: e, binary: binaryView(e, quote(), null) };
      await load();
      assert.equal(await text('#episode-theme'), e.theme);
      assert.equal(await text('#binary-title'), 'Bitcoin · DOWN');
      assert.equal(await text('#binary-buy'), '54¢');
      assert.equal(await text('#binary-pnl'), 'Awaiting execution');
      assert.match(await text('#binary-window'), /Market:.*Settlement:.*expected/);
      assert.match(await text('#binary-countdown'), /\d+m \d+s/);
      assert.equal(await text('#perp-plan-title'), 'LONG TAO');
      assert.equal(await text('#perp-plan-margin'), '$50.00');
    });
    await t.test('confirmed fills display entry-fee-inclusive P&L beside a live perp chart', async () => {
      const e = fill(episode());
      episodeResponse = { episode: e, binary: binaryView(e, quote(), null) };
      state = livePerp;
      await load();
      await page.locator('#pnl').waitFor();
      assert.equal(await text('#binary-shares'), '90');
      assert.equal(await text('#binary-average'), '50¢');
      assert.equal(await text('#binary-cost'), '$46.56');
      assert.equal(await text('#binary-fees'), '$1.56');
      assert.equal(await text('#binary-exit'), '$46.80');
      assert.equal(await text('#binary-pnl'), '+$0.24');
      assert.match(await text('#binary-note'), /before exit fees/);
      assert.match(await text('#binary-note'), /Holdings last checked/);
      assert.equal(await text('#pnl'), '+$5.00');
      assert.equal(await text('#perp-live-pnl'), '+$5.00');
      assert.equal(await text('#perp-live-entry'), '$500.00');
      assert.equal(await text('#perp-live-mark'), '$505.00');
      await page.locator('#spark path').first().waitFor({ state: 'attached' });
      await noOverflow(page);
      if (process.env.DASHBOARD_SCREENSHOT) await page.screenshot({ path: process.env.DASHBOARD_SCREENSHOT, fullPage: true, animations: 'disabled' });
    });
    await t.test('confirmed settlement displays the recorded payout and final P&L', async () => {
      const e = fill(episode());
      e.binary.finalSettlement = { shares: 90, yesValue: 0, payoutUsd: 90, verifiedAt: Date.now() };
      episodeResponse = { episode: e, binary: binaryView(e, null, 0) };
      await load();
      assert.equal(await text('#binary-countdown'), 'Settled');
      assert.equal((await text('#binary-pnl-label')).toLowerCase(), 'final fortune');
      assert.equal(await text('#binary-pnl'), '+$43.44');
      assert.equal(await text('#binary-exit-label'), 'Settlement value');
      assert.equal(await text('#binary-exit'), '$90.00');
    });
    await t.test('a different live perp is not presented as the episode selection', async () => {
      const e = episode();
      e.perp.coin = 'SOL';
      episodeResponse = { episode: e, binary: binaryView(e, quote(), null) };
      await load();
      assert.equal(await text('#perp-plan-title'), 'LONG SOL');
      assert.equal(await text('#perp-live-pnl'), 'Awaiting live position');
      assert.equal(await text('#perp-live-entry'), '—');
      assert.equal(await text('#pnl'), '+$5.00');
    });
    await t.test('stale reconciliation suppresses valuation without hiding the perp', async () => {
      const e = fill(episode());
      e.binary.positionCheckedAt = Date.now() - 120_000;
      episodeResponse = { episode: e, binary: binaryView(e, quote(), null) };
      await load();
      assert.equal(await text('#episode-feed'), 'Binary data is stale');
      assert.equal(await text('#binary-exit'), '—');
      assert.equal(await text('#binary-pnl'), 'Value unavailable');
      assert.equal(await text('#pnl'), '+$5.00');
      assert.equal(await page.locator('#binary-error').isVisible(), true);
    });
    await t.test('unavailable binary feed leaves the live perp operating', async () => {
      episodeStatus = 503;
      await load();
      assert.equal(await text('#episode-feed'), 'Episode feed unavailable');
      assert.equal(await text('#pnl'), '+$5.00');
      assert.match(await text('#binary-error'), /temporarily unavailable/);
      episodeStatus = 200;
    });
    await t.test('hostile text and unsafe links stay inert, including at mobile width', async () => {
      const e = episode();
      e.theme = '<img src=x onerror="window.injection=true">';
      e.perp.thesis = 'VeryLongThemeWithoutSpaces'.repeat(12);
      const binary = binaryView(e, quote(), null);
      binary.marketUrl = 'javascript:window.injection=true';
      episodeResponse = { episode: e, binary };
      await page.setViewportSize({ width: 390, height: 844 });
      await load();
      assert.equal(await text('#episode-theme'), e.theme);
      assert.equal(await page.locator('#episode-theme img').count(), 0);
      assert.equal(await page.locator('#binary-market-link').isVisible(), false);
      assert.equal(await page.evaluate('window.injection'), undefined);
      await noOverflow(page);
    });
    await t.test('replay hides the paired live cards and does not request live APIs', async () => {
      const liveRequests: string[] = [];
      const record = (request: { url(): string }) => { if (/\/api\/(episode|state)$/.test(request.url())) liveRequests.push(request.url()); };
      page.on('request', record);
      await page.goto(`${origin}/?replay=TAO`);
      await page.waitForFunction(() => document.title === 'replay-error');
      assert.equal(await page.locator('#episode').isVisible(), false);
      assert.deepEqual(liveRequests, []);
      page.off('request', record);
    });
    assert.deepEqual(errors, [], 'unexpected browser script errors');
  } finally {
    await browser.close();
    server.close();
    await once(server, 'close');
  }
});
