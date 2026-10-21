import { test } from 'node:test';
import assert from 'node:assert/strict';
import { constants, generateKeyPairSync, verify } from 'node:crypto';
import {
  buildOrderRequest, createAuthHeaders, feeCoefficient, hourlyEventTicker, loadPrivateKey, normalizeOrder,
  normalizePosition, normalizeSettlement, quoteFromBook, selectHourlyStrike, settlementFromMarket,
} from '../src/kalshi.js';
import { maximumEntryCost, sizeBinaryOrder } from '../src/binary-order.js';

const END = Date.parse('2026-10-22T21:00:00Z'); // 5pm EDT
const START = END - 3_600_000;
const EVENT = 'KXBTCD-26OCT2217';
const strike = (floor: number, yesBid: string, yesAsk: string, extra: Record<string, unknown> = {}) => ({
  ticker: `${EVENT}-T${floor}`, event_ticker: EVENT, market_type: 'binary', strike_type: 'greater', floor_strike: floor, status: 'active',
  open_time: '2026-10-21T20:00:00Z', close_time: new Date(END).toISOString(), expected_expiration_time: new Date(END + 300_000).toISOString(),
  yes_sub_title: `$${(floor + 0.01).toLocaleString('en-US')} or above`, rules_primary: 'If the BRTI average before 5 PM EDT is above the strike, Yes.',
  price_ranges: [{ start: '0.0000', end: '1.0000', step: '0.0100' }], yes_bid_dollars: yesBid, yes_ask_dollars: yesAsk,
  no_bid_dollars: (1 - Number(yesAsk)).toFixed(4), no_ask_dollars: (1 - Number(yesBid)).toFixed(4), ...extra,
});
function event() {
  return {
    event: { event_ticker: EVENT, series_ticker: 'KXBTCD', title: 'BTC price on Oct 22, 2026 at 5pm EDT?', strike_date: new Date(END).toISOString() },
    markets: [strike(84249.99, '0.6100', '0.6200'), strike(84499.99, '0.5200', '0.5300'), strike(84749.99, '0.4700', '0.4800')],
  };
}
const options = { episodeStart: START, targetEnd: END, now: START, venue: 'kalshi' as const, feeCoefficient: 0.07 };
const TICKER = `${EVENT}-T84499.99`;

test('hourly event tickers follow the New York close hour across DST and midnight', () => {
  assert.equal(hourlyEventTicker(END), 'KXBTCD-26OCT2217');
  assert.equal(hourlyEventTicker(Date.parse('2026-01-15T22:00:00Z')), 'KXBTCD-26JAN1517');
  assert.equal(hourlyEventTicker(Date.parse('2026-10-23T04:00:00Z')), 'KXBTCD-26OCT2300');
  assert.throws(() => hourlyEventTicker(END + 60_000), /full-hour/);
});

test('selects the strike quoted nearest 50 cents for the chosen side and keeps the episode hour', () => {
  const up = selectHourlyStrike(event(), { ...options, side: 'up' });
  assert.equal(up.slug, `${EVENT}-T84749.99`); // YES ask 0.48 beats 0.53
  const down = selectHourlyStrike(event(), { ...options, side: 'down' });
  assert.equal(down.slug, TICKER); // NO ask 0.48 beats 0.53
  assert.equal(down.venue, 'kalshi');
  assert.equal(down.eventSlug, EVENT);
  assert.equal(down.startsAt, START);
  assert.equal(down.endsAt, END);
  assert.equal(down.settlementAt, END + 300_000);
  assert.equal(down.priceToBeat, 84499.99);
  assert.equal(down.priceTick, 0.01);
  assert.equal(down.minimumShares, 1);
  assert.equal(down.feeCoefficient, 0.07);
  assert.match(down.title, /\$84,500 or above · BTC price on Oct 22/);
  // with_nested_markets=true nests the ladder under event.markets instead of the top level.
  const nested = event() as { event: Record<string, unknown>; markets?: unknown[] };
  nested.event.markets = nested.markets; delete nested.markets;
  assert.equal(selectHourlyStrike(nested, { ...options, side: 'down' }).slug, TICKER);
});

test('rejects other events, brackets, other hours, little time remaining and unquoted ladders unless planning', () => {
  const other = event(); other.event.event_ticker = 'KXBTCD-26OCT2218';
  assert.throws(() => selectHourlyStrike(other, options), /different hourly/);
  const bracket = event(); for (const m of bracket.markets) m.strike_type = 'between';
  assert.throws(() => selectHourlyStrike(bracket, options), /No eligible/);
  const late = event(); for (const m of late.markets) m.close_time = new Date(END + 3_600_000).toISOString();
  assert.throws(() => selectHourlyStrike(late, options), /No eligible/);
  assert.throws(() => selectHourlyStrike(event(), { ...options, now: END - 10 * 60_000 }), /too little time/);
  assert.throws(() => selectHourlyStrike(event(), { ...options, targetEnd: END + 1 }), /Invalid episode window/);
  const unquoted = event(); for (const m of unquoted.markets) { m.yes_bid_dollars = '0.0000'; m.yes_ask_dollars = '1.0000'; }
  assert.throws(() => selectHourlyStrike(unquoted, options), /chosen from the live book/);
  const provisional = selectHourlyStrike(unquoted, { ...options, allowUpcoming: true });
  assert.equal(provisional.slug, TICKER);
  assert.match(provisional.title, /provisional/);
  const preopen = event(); for (const m of preopen.markets) m.open_time = new Date(START + 60_000).toISOString();
  assert.throws(() => selectHourlyStrike(preopen, options), /No eligible/);
  assert.equal(selectHourlyStrike(preopen, { ...options, allowUpcoming: true }).eventSlug, EVENT);
});

test('quotes derive each side from the complementary bid and never trade a closed or crossed book', () => {
  const book = { orderbook_fp: { yes_dollars: [['0.0100', '200.00'], ['0.5100', '13.00']], no_dollars: [['0.0100', '100.00'], ['0.4600', '17.00']] } };
  assert.deepEqual(quoteFromBook(book, 'up', 'active', START), { open: true, buyPrice: 0.54, sellPrice: 0.51, availableShares: 17, sellAvailableShares: 13, updatedAt: START, status: 'active' });
  assert.deepEqual(quoteFromBook(book, 'down', 'active', START), { open: true, buyPrice: 0.49, sellPrice: 0.46, availableShares: 13, sellAvailableShares: 17, updatedAt: START, status: 'active' });
  const closed = quoteFromBook(book, 'up', 'closed', START);
  assert.equal(closed.open, false); assert.equal(closed.buyPrice, null); assert.equal(closed.availableShares, 0);
  assert.equal(quoteFromBook({ orderbook_fp: { yes_dollars: [], no_dollars: [] } }, 'up', 'active', START).buyPrice, null);
  assert.throws(() => quoteFromBook({ orderbook_fp: { yes_dollars: [['0.5500', '1.00']], no_dollars: [['0.4600', '1.00']] } }, 'up', 'active', START), /crossed/);
});

test('the fee bound covers the quadratic taker fee and sizes a double-or-nothing stake inside the budget', () => {
  assert.equal(feeCoefficient({ series: { fee_type: 'quadratic', fee_multiplier: 1 } }), 0.07);
  assert.throws(() => feeCoefficient({ series: { fee_type: 'flat', fee_multiplier: 1 } }), /quadratic/);
  const market = selectHourlyStrike(event(), { ...options, side: 'down' });
  const quote = quoteFromBook({ orderbook_fp: { yes_dollars: [['0.5200', '500.00']], no_dollars: [['0.4700', '500.00']] } }, 'down', 'active', START);
  const shares = sizeBinaryOrder(market, quote, 50, 0.6, START);
  assert.ok(Number.isInteger(shares) && shares > 0);
  assert.ok(maximumEntryCost(shares, 0.6, 0.07) <= 50);
  // Actual Kalshi fee at the limit: ceil(0.07 × C × P × (1 − P)) ≤ the reserved C × 0.07 / 4.
  assert.ok(Math.ceil(0.07 * shares * 0.6 * 0.4 * 100) / 100 <= Math.ceil(shares * 0.07 * 0.25 * 100) / 100);
});

test('DOWN orders sell YES at the complementary price as IOC with whole contracts', () => {
  const order = buildOrderRequest({ ticker: TICKER, side: 'down', shares: 80, maxPrice: 0.6, clientOrderId: 'episode-1' });
  assert.deepEqual(order, { ticker: TICKER, side: 'ask', count: '80.00', price: '0.4000', time_in_force: 'immediate_or_cancel', self_trade_prevention_type: 'taker_at_cross', client_order_id: 'episode-1' });
  assert.equal(buildOrderRequest({ ticker: TICKER, side: 'up', shares: 1, maxPrice: 0.55, clientOrderId: 'x' }).side, 'bid');
  assert.throws(() => buildOrderRequest({ ticker: TICKER, side: 'up', shares: 10, maxPrice: 0.601, clientOrderId: 'x' }), /tick/);
  assert.throws(() => buildOrderRequest({ ticker: TICKER, side: 'up', shares: 2.5, maxPrice: 0.6, clientOrderId: 'x' }), /whole number/);
  assert.throws(() => buildOrderRequest({ ticker: 'bad ticker', side: 'up', shares: 1, maxPrice: 0.6, clientOrderId: 'x' }), /identifier/);
});

test('receipts use the paid cost and fees, and refuse orders that differ from the prepared request', () => {
  const expected = { ticker: TICKER, side: 'down' as const, shares: 80, limitPrice: 0.6 };
  const order = {
    order_id: 'k-1', ticker: TICKER, book_side: 'ask', outcome_side: 'no', status: 'executed', fill_count_fp: '80.00', initial_count_fp: '80.00', remaining_count_fp: '0.00',
    yes_price_dollars: '0.4000', no_price_dollars: '0.6000', taker_fill_cost_dollars: '40.0000', maker_fill_cost_dollars: '0.0000',
    taker_fees_dollars: '1.4000', maker_fees_dollars: '0.0000', created_time: new Date(START).toISOString(), last_update_time: new Date(START + 1000).toISOString(),
  };
  assert.deepEqual(normalizeOrder({ order }, expected), { id: 'k-1', marketSlug: TICKER, side: 'down', filledShares: 80, averagePrice: 0.5, totalCostUsd: 40, feesUsd: 1.4, status: 'executed', updatedAt: START + 1000 });
  const unfilled = normalizeOrder({ order: { ...order, status: 'canceled', fill_count_fp: '0.00', taker_fill_cost_dollars: '0.0000', taker_fees_dollars: '0.0000' } }, expected);
  assert.equal(unfilled.filledShares, 0); assert.equal(unfilled.averagePrice, null); assert.equal(unfilled.totalCostUsd, 0);
  assert.throws(() => normalizeOrder({ order: { ...order, book_side: 'bid', outcome_side: 'yes' } }, expected), /different market or side/);
  assert.throws(() => normalizeOrder({ order: { ...order, initial_count_fp: '81.00' } }, expected), /differs from the prepared/);
  assert.throws(() => normalizeOrder({ order: { ...order, yes_price_dollars: '0.4100' } }, expected), /differs from the prepared/);
  assert.throws(() => normalizeOrder({ order: { ...order, taker_fill_cost_dollars: '52.0000' } }, expected), /cost does not fit/);
  assert.throws(() => normalizeOrder({ order: { ...order, fill_count_fp: undefined } }, expected), /reconcile using its order ID/);
});

test('positions and settlements attribute only this side of this contract', () => {
  assert.equal(normalizePosition({ market_positions: [{ ticker: TICKER, position_fp: '-80.00' }] }, TICKER, 'down').shares, 80);
  assert.equal(normalizePosition({ market_positions: [] }, TICKER, 'up').shares, 0);
  assert.throws(() => normalizePosition({ market_positions: [{ ticker: TICKER, position_fp: '-80.00' }] }, TICKER, 'up'), /opposite side/);
  assert.throws(() => normalizePosition({ market_positions: [], cursor: 'more' }, TICKER, 'up'), /incomplete/);
  assert.deepEqual(normalizeSettlement({ settlements: [{ ticker: TICKER, market_result: 'no', yes_count_fp: '0.00', no_count_fp: '80.00', revenue: 8000 }] }, TICKER, 'down'), { shares: 80, result: 0 });
  assert.equal(normalizeSettlement({ settlements: [] }, TICKER, 'down'), null);
  assert.throws(() => normalizeSettlement({ settlements: [{ ticker: TICKER, market_result: 'no', yes_count_fp: '5.00', no_count_fp: '80.00' }] }, TICKER, 'down'), /opposite side/);
  assert.equal(settlementFromMarket({ market: { status: 'finalized', result: 'no', settlement_value_dollars: '0.0000' } }), 0);
  assert.equal(settlementFromMarket({ market: { status: 'finalized', result: 'yes' } }), 1);
  assert.equal(settlementFromMarket({ market: { status: 'active', result: '' } }), null);
  assert.equal(settlementFromMarket({ market: { status: 'closed', result: '' } }), null);
  assert.throws(() => settlementFromMarket({ market: { status: 'finalized', result: 'no', settlement_value_dollars: '1.0000' } }), /Unexpected/);
});

test('request signatures are RSA-PSS over timestamp, method and the prefixed path without the query', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  const headers = createAuthHeaders('key-id-1234', loadPrivateKey(pem.replace(/\n/g, '\\n')), 'get', '/trade-api/v2/portfolio/positions?ticker=X', 1_700_000_000_000);
  assert.equal(headers['KALSHI-ACCESS-KEY'], 'key-id-1234');
  assert.equal(headers['KALSHI-ACCESS-TIMESTAMP'], '1700000000000');
  const message = Buffer.from('1700000000000GET/trade-api/v2/portfolio/positions');
  assert.ok(verify('sha256', message, { key: publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST }, Buffer.from(headers['KALSHI-ACCESS-SIGNATURE']!, 'base64')));
  const ed = generateKeyPairSync('ed25519');
  const edHeaders = createAuthHeaders('key-id-1234', ed.privateKey, 'POST', '/trade-api/v2/portfolio/events/orders', 1);
  assert.ok(verify(null, Buffer.from('1POST/trade-api/v2/portfolio/events/orders'), ed.publicKey, Buffer.from(edHeaders['KALSHI-ACCESS-SIGNATURE']!, 'base64')));
  assert.throws(() => loadPrivateKey('not a key'), /PEM/);
  assert.throws(() => createAuthHeaders('', privateKey, 'GET', '/x'), /key ID/);
});
