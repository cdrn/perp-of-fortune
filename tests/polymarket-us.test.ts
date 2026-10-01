import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBuyOrder, createAuthHeaders, normalizeOrder, normalizePosition,
  PolymarketUSClient, quoteFromBook, selectHourlyBitcoin,
} from '../src/polymarket-us.js';

const START = Date.parse('2026-10-01T20:00:00Z');
const END = START + 3_600_000;
const SLUG = 'cpc-btc-updown-1h-2026-10-01-2000z';
function event() {
  return {
    slug: 'btc-updown-1h-2026-10-01-2000z', title: 'BTC Up or Down: 60 min',
    startDate: new Date(START).toISOString(), endDate: new Date(END).toISOString(), active: true, closed: false,
    markets: [{
      slug: SLUG, question: 'BTC Up or Down: 60 min', active: true, closed: false,
      status: 'MARKET_STATUS_OPEN', description: 'Up if Bitcoin closes at or above its opening reference price; otherwise Down.',
      startDate: '2026-09-30T20:00:14Z', endDate: '2026-10-01T21:30:00Z',
      orderPriceMinTickSize: 0.01, minimumTradeQty: 0.01, feeCoefficient: 0.0695,
      assetPriceTerms: {
        marketType: 'ASSET_PRICE_MARKET_TYPE_UP_DOWN', asset: { symbol: 'btc', assetClass: 'ASSET_CLASS_CRYPTO' },
        horizon: '1h', windowStart: new Date(START).toISOString(), windowEnd: new Date(END).toISOString(),
        priceToBeat: { value: '84000.00', currency: 'USD' },
      },
    }],
  };
}
function book(state = 'MARKET_STATE_OPEN') {
  return { marketData: {
    marketSlug: SLUG, state, transactTime: new Date(START).toISOString(),
    bids: [{ px: { value: '0.42', currency: 'USD' }, qty: '12' }, { px: { value: '0.40', currency: 'USD' }, qty: '100' }],
    offers: [{ px: { value: '0.45', currency: 'USD' }, qty: '7' }, { px: { value: '0.47', currency: 'USD' }, qty: '100' }],
  } };
}
const options = { episodeStart: START, now: START, targetEnd: END };

test('selects typed BTC hourly terms, preserving actual window rather than delayed expiry', () => {
  const selected = selectHourlyBitcoin([event()], options);
  assert.equal(selected.startsAt, START);
  assert.equal(selected.endsAt, END);
  assert.equal(selected.settlementAt, END + 1_800_000);
  assert.equal(selected.priceToBeat, 84000);
});
test('rejects other assets, other families, nonhourly windows, closed and malformed candidates', () => {
  const variants = [
    (e: ReturnType<typeof event>) => { e.markets[0]!.assetPriceTerms.asset.symbol = 'eth'; },
    (e: ReturnType<typeof event>) => { e.markets[0]!.assetPriceTerms.marketType = 'ASSET_PRICE_MARKET_TYPE_RANGE'; },
    (e: ReturnType<typeof event>) => { e.markets[0]!.assetPriceTerms.horizon = '15m'; },
    (e: ReturnType<typeof event>) => { e.markets[0]!.assetPriceTerms.windowEnd = new Date(START + 900_000).toISOString(); },
    (e: ReturnType<typeof event>) => { e.endDate = new Date(END + 1_800_000).toISOString(); },
    (e: ReturnType<typeof event>) => { e.markets[0]!.status = 'MARKET_STATUS_RESOLVING'; },
    (e: ReturnType<typeof event>) => { e.closed = true; },
    (e: ReturnType<typeof event>) => { e.markets[0]!.closed = true; },
    (e: ReturnType<typeof event>) => { e.markets[0]!.active = false; },
  ];
  for (const mutate of variants) { const e = event(); mutate(e); assert.throws(() => selectHourlyBitcoin([e], options), /No eligible/); }
  assert.throws(() => selectHourlyBitcoin([event()], { ...options, now: END }), /No eligible/);
  assert.throws(() => selectHourlyBitcoin([event()], { ...options, episodeStart: START + 50 * 60_000, now: START + 50 * 60_000 }), /No eligible/);
  assert.throws(() => selectHourlyBitcoin([event()], { ...options, targetEnd: END + 1 }), /No eligible/);
});
test('explicit upcoming planning allows preopen markets without opening trading', () => {
  const e = event(); e.closed = true; e.markets[0]!.closed = true; e.markets[0]!.status = 'MARKET_STATUS_CLOSED';
  assert.throws(() => selectHourlyBitcoin([e], { ...options, now: START - 60_000 }), /No eligible/);
  assert.equal(selectHourlyBitcoin([e], { ...options, now: START - 60_000, allowUpcoming: true }).slug, SLUG);
  assert.throws(() => selectHourlyBitcoin([e], { ...options, allowUpcoming: true }), /No eligible/);
});
test('ambiguous matching markets are rejected while duplicated search rows are harmless', () => {
  assert.equal(selectHourlyBitcoin([event(), event()], options).slug, SLUG);
  const e = event(); e.markets[0]!.slug += '-duplicate';
  assert.throws(() => selectHourlyBitcoin([event(), e], options), /Multiple/);
});
test('NO buy uses complement of best YES bid; NO exit uses complement of YES ask', () => {
  assert.deepEqual(quoteFromBook(book(), 'down'), {
    buyPrice: 0.58, sellPrice: 0.55, availableShares: 12, sellAvailableShares: 7, updatedAt: START, status: 'MARKET_STATE_OPEN',
  });
  assert.deepEqual(quoteFromBook(book(), 'up'), {
    buyPrice: 0.45, sellPrice: 0.42, availableShares: 7, sellAvailableShares: 12, updatedAt: START, status: 'MARKET_STATE_OPEN',
  });
});
test('closed, empty, malformed or crossed books never masquerade as executable quotes', () => {
  assert.equal(quoteFromBook(book('MARKET_STATE_EXPIRED'), 'up').buyPrice, null);
  const empty = book(); empty.marketData.bids = []; empty.marketData.offers = [];
  assert.equal(quoteFromBook(empty, 'up').sellPrice, null);
  const crossed = book(); crossed.marketData.bids[0]!.px.value = '0.50';
  assert.throws(() => quoteFromBook(crossed, 'up'), /crossed/);
  const invalid = book(); invalid.marketData.transactTime = '';
  assert.throws(() => quoteFromBook(invalid, 'up'), /timestamp/);
});
test('DOWN buy limit is denominated in YES price and uses IOC, with strict tick/size limits', () => {
  const order = buildBuyOrder({ marketSlug: SLUG, side: 'down', shares: 50, maxPrice: 0.60 });
  assert.equal(order.price.value, '0.4');
  assert.equal(order.intent, 'ORDER_INTENT_BUY_SHORT');
  assert.equal(order.tif, 'TIME_IN_FORCE_IMMEDIATE_OR_CANCEL');
  assert.throws(() => buildBuyOrder({ marketSlug: SLUG, side: 'up', shares: 50, maxPrice: 0.601 }), /tick/);
  assert.throws(() => buildBuyOrder({ marketSlug: SLUG, side: 'up', shares: 0, maxPrice: 0.50 }), /Shares/);
  assert.throws(() => buildBuyOrder({ marketSlug: SLUG, side: 'up', shares: 0.001, minimumShares: 0.01, maxPrice: 0.5 }), /Shares/);
});
test('normalizes only cumulative confirmed fills, complements DOWN fill price, preserves unknown fees', () => {
  const raw = { id: 'order-id', marketSlug: SLUG, intent: 'ORDER_INTENT_BUY_SHORT', state: 'ORDER_STATE_CANCELED', quantity: 50,
    cumQuantity: 30, leavesQuantity: 0, avgPx: { value: '0.43', currency: 'USD' }, insertTime: new Date(START).toISOString() };
  const receipt = normalizeOrder({ order: raw }, 'down');
  assert.equal(receipt.filledShares, 30);
  assert.equal(receipt.averagePrice, 0.57);
  assert.equal(receipt.feesUsd, null);
  assert.equal(receipt.totalCostUsd, 17.1);
  assert.equal(normalizeOrder({ order: { ...raw, commissionNotionalTotalCollected: { value: '0.52', currency: 'USD' } } }).totalCostUsd, 17.1);
  assert.throws(() => normalizeOrder({ id: 'accepted-only' }), /does not yet confirm/);
  assert.throws(() => normalizeOrder(raw, 'up'), /does not yet confirm/);
  assert.throws(() => normalizeOrder({ ...raw, outcomeSide: 'OUTCOME_SIDE_YES' }), /conflicting/);
});
test('current holdings reveal external close and refuse unrelated opposite inventory', () => {
  assert.equal(normalizePosition({ positions: { [SLUG]: { netPositionDecimal: '-12.5' } } }, SLUG, 'down').shares, 12.5);
  assert.equal(normalizePosition({ positions: {} }, SLUG, 'down').shares, 0);
  assert.throws(() => normalizePosition({ positions: { [SLUG]: { netPositionDecimal: '1' } } }, SLUG, 'down'), /opposite/);
  assert.throws(() => normalizePosition({ positions: { [SLUG]: {} } }, SLUG, 'down'), /quantity/);
});

// RFC 8032 public test seed. Signature independently calculated using Python cryptography.
const TEST_SEED = 'nWGxne/9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A=';
test('Ed25519 request signature matches independent vector and excludes query strings', () => {
  const headers = createAuthHeaders('test-key-id', TEST_SEED, 'GET', '/v1/portfolio/positions?market=example', 1790870400000);
  assert.equal(headers['X-PM-Signature'], 'BucNLzD3eQwD9ldjr4+3q+6J00ra7AntQyQ2GAwEaCBLs4/TvNhi9XjeXQ8DR0Sy9g6th2aiSReZeQbjmRMhAA==');
  const longKey = Buffer.concat([Buffer.from(TEST_SEED, 'base64'), Buffer.alloc(32)]).toString('base64');
  assert.deepEqual(createAuthHeaders('test-key-id', longKey, 'GET', '/v1/portfolio/positions', 1790870400000), headers);
  assert.throws(() => createAuthHeaders('test', 'short', 'GET', '/'), /key|credentials/);
});
test('public discovery/book never uses authentication; private clients must opt in', async () => {
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const client = new PolymarketUSClient({ now: () => START, fetch: (async (input, init) => {
    const url = new URL(String(input)); calls.push({ url, init: init! });
    return Response.json(url.pathname === '/v1/search' ? { events: [event()] } : book());
  }) as typeof fetch });
  await client.discoverHourlyBitcoin(options);
  await client.getQuote(SLUG, 'down');
  for (const call of calls) {
    assert.equal(call.url.hostname, 'gateway.polymarket.us');
    assert.equal((call.init.headers as Record<string, string>)['X-PM-Access-Key'], undefined);
  }
  await assert.rejects(client.getOrder('order-id'), /requires PM_US/);
  assert.equal(calls.length, 2);
});
test('upcoming discovery explicitly includes preopen listings hidden by default search', async () => {
  const e = event(); e.closed = true; e.markets[0]!.closed = true; e.markets[0]!.status = 'MARKET_STATUS_CLOSED';
  const client = new PolymarketUSClient({ now: () => START - 3_600_000, fetch: (async (input) => {
    const url = new URL(String(input));
    assert.equal(url.searchParams.get('status'), 'all');
    assert.equal(url.searchParams.get('startTimeMin'), new Date(START).toISOString());
    assert.equal(url.searchParams.get('startTimeMax'), new Date(START).toISOString());
    return Response.json({ events: [e] });
  }) as typeof fetch });
  assert.equal((await client.discoverHourlyBitcoin({ episodeStart: START, targetEnd: END, allowUpcoming: true })).slug, SLUG);
});
test('private order paths wrap preview correctly and never retry ambiguous submissions', async () => {
  const bodies: Array<{ url: URL; init: RequestInit }> = [];
  const client = new PolymarketUSClient({ keyId: 'test-key', secretKey: TEST_SEED, now: () => START, fetch: (async (input, init) => {
    bodies.push({ url: new URL(String(input)), init: init! });
    return new Response('{}', { status: 503 });
  }) as typeof fetch });
  const order = buildBuyOrder({ marketSlug: SLUG, side: 'down', shares: 10, maxPrice: 0.5 });
  await assert.rejects(client.previewOrder(order), /HTTP 503/);
  assert.equal(bodies[0]!.url.pathname, '/v1/order/preview');
  assert.deepEqual(JSON.parse(String(bodies[0]!.init.body)), { request: order });
  await assert.rejects(client.createOrder(order), /HTTP 503/);
  assert.equal(bodies.length, 2);
  assert.equal(bodies[1]!.url.hostname, 'api.polymarket.us');
  assert.equal(bodies[1]!.url.pathname, '/v1/orders');
  assert.deepEqual(JSON.parse(String(bodies[1]!.init.body)), order);
  assert.equal(bodies[1]!.init.redirect, 'error');
  await assert.rejects(client.getOrder('example-order'), /HTTP 503/);
  assert.equal(bodies[2]!.url.pathname, '/v1/order/example-order');
});
test('only final resolved markets yield settlement, and zero is a legitimate confirmed loss', async () => {
  for (const status of ['MARKET_STATUS_OPEN', 'MARKET_STATUS_RESOLVING', 'MARKET_STATUS_RESOLVED']) {
    let requests = 0;
    const client = new PolymarketUSClient({ fetch: (async (input) => {
      requests++;
      return Response.json(String(input).endsWith('/settlement') ? { slug: SLUG, settlement: 0 } : { market: { slug: SLUG, status } });
    }) as typeof fetch });
    assert.equal(await client.getSettlement(SLUG), status === 'MARKET_STATUS_RESOLVED' ? 0 : null);
    assert.equal(requests, status === 'MARKET_STATUS_RESOLVED' ? 2 : 1);
  }
});
