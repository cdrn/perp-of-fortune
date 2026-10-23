import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Episode } from '../src/episode.js';
import { hourlyEventTicker, type KalshiOrder } from '../src/kalshi.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const START = Date.parse('2026-10-01T20:00:00Z');
const NOW = START + 120_000;
const END = START + 3_600_000;
const EVENT = hourlyEventTicker(END);
const ORDER_ID = 'kalshi-order-1';
const strike = (floor: number, yesBid: string, yesAsk: string) => ({
  ticker: `${EVENT}-T${floor}`, event_ticker: EVENT, market_type: 'binary', strike_type: 'greater', floor_strike: floor, status: 'active',
  open_time: new Date(START - 86_400_000).toISOString(), close_time: new Date(END).toISOString(), expected_expiration_time: new Date(END + 300_000).toISOString(),
  yes_sub_title: `$${floor + 0.01} or above`, rules_primary: 'If the BRTI average before the close hour is above the strike, Yes.',
  price_ranges: [{ start: '0.0000', end: '1.0000', step: '0.0100' }], yes_bid_dollars: yesBid, yes_ask_dollars: yesAsk,
  no_bid_dollars: (1 - Number(yesAsk)).toFixed(4), no_ask_dollars: (1 - Number(yesBid)).toFixed(4), result: '',
});
const fixtureEvent = {
  event: { event_ticker: EVENT, series_ticker: 'KXBTCD', title: 'BTC price at the top of the hour?' },
  markets: [strike(83999.99, '0.6100', '0.6200'), strike(84249.99, '0.5000', '0.5100'), strike(84499.99, '0.4300', '0.4400')],
};
const TICKER = `${EVENT}-T84249.99`; // NO ask 0.50: the double-or-nothing strike for a DOWN pick

interface RequestLog { method: string; host: string; path: string; authenticated: boolean; body: Record<string, unknown> | null }
interface ExchangeState {
  event: typeof fixtureEvent;
  requests: RequestLog[];
  mutationCount: number;
  holdings: number;
  loseResponse: boolean;
  publicResult: '' | 'yes' | 'no';
  settlementRecord: { yes: number; no: number; result: 'yes' | 'no' } | null;
  rejectStatus?: number;
  fillNothing?: boolean;
  orders?: KalshiOrder[];
  fills?: Record<string, string>[];
  order?: KalshiOrder;
}

// Replaces networking inside each CLI subprocess. The fake exchange verifies every
// private request's RSA-PSS signature against the test key pair's public half.
const PRELOAD = String.raw`
import { readFileSync, writeFileSync } from 'node:fs';
import { constants, createPublicKey, verify } from 'node:crypto';
const statePath = process.env.MOCK_EXCHANGE_FILE;
const publicKey = createPublicKey(process.env.MOCK_KALSHI_PUBLIC_KEY);
const read = () => JSON.parse(readFileSync(statePath, 'utf8'));
const write = state => writeFileSync(statePath, JSON.stringify(state));
Date.now = () => Number(process.env.MOCK_NOW);
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  const method = init.method ?? 'GET';
  const body = init.body === undefined ? null : JSON.parse(String(init.body));
  const headers = new Headers(init.headers);
  const state = read();
  const authenticated = headers.has('KALSHI-ACCESS-KEY') && headers.has('KALSHI-ACCESS-SIGNATURE');
  state.requests.push({method,host:url.hostname,path:url.pathname,authenticated,body});
  write(state);
  const response = value => Response.json(value);
  if (url.hostname === 'api.hyperliquid-testnet.xyz' && url.pathname === '/info'
      && method === 'POST' && body.type === 'metaAndAssetCtxs') {
    return response([{universe:[{name:'SOL',szDecimals:2,maxLeverage:20}]},[{markPx:'150.00'}]]);
  }
  if (url.hostname !== 'external-api.demo.kalshi.co') throw new Error('Unexpected test network request: '+method+' '+url.origin+url.pathname);
  const api = '/trade-api/v2';
  const path = url.pathname.slice(api.length);
  const ticker = ${JSON.stringify(TICKER)};
  const market = () => ({...state.event.markets.find(m => m.ticker === ticker),
    status: state.publicResult ? 'finalized' : 'active', result: state.publicResult,
    settlement_value_dollars: state.publicResult ? (state.publicResult === 'yes' ? '1.0000' : '0.0000') : undefined});
  if (path.startsWith('/portfolio/')) {
    if (!authenticated) throw new Error('Private request is missing authentication');
    if (headers.get('KALSHI-ACCESS-KEY') !== 'test-key-id-0001') throw new Error('Wrong API key ID');
    const message = Buffer.from(headers.get('KALSHI-ACCESS-TIMESTAMP') + method + url.pathname);
    const ok = verify('sha256', message, {key: publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST}, Buffer.from(headers.get('KALSHI-ACCESS-SIGNATURE'), 'base64'));
    if (!ok) return new Response('{"error":"bad signature"}', {status: 401});
    if (path === '/portfolio/positions' && method === 'GET') {
      return response({market_positions: state.holdings === 0 ? [] : [{ticker, position_fp: state.holdings.toFixed(2)}], cursor: ''});
    }
    if (path === '/portfolio/settlements' && method === 'GET') {
      const r = state.settlementRecord;
      return response({settlements: r ? [{ticker, market_result: r.result, yes_count_fp: r.yes.toFixed(2), no_count_fp: r.no.toFixed(2), revenue: 100 * (r.result === 'yes' ? r.yes : r.no)}] : [], cursor: ''});
    }
    if (path === '/portfolio/events/orders' && method === 'POST') {
      if (body.ticker !== ticker || body.time_in_force !== 'immediate_or_cancel' || !body.client_order_id) throw new Error('Invalid order request');
      if (state.rejectStatus) return new Response('{"error":{"code":"insufficient_balance"}}', {status: state.rejectStatus});
      state.mutationCount++;
      const count = Number(body.count), yesPrice = Number(body.price), filled = state.fillNothing ? 0 : count;
      const orderId = state.mutationCount === 1 ? ${JSON.stringify(ORDER_ID)} : 'kalshi-order-' + state.mutationCount;
      // The fill trades YES at 0.47 (NO at 0.53). The order-level fill cost is reported as the
      // YES leg (0.47 per contract), which is NOT what a DOWN buyer paid; fills price both legs.
      state.order = {order_id: orderId, client_order_id: body.client_order_id, ticker, book_side: body.side,
        outcome_side: body.side === 'ask' ? 'no' : 'yes', type: 'limit', status: filled ? 'executed' : 'canceled', fill_count_fp: filled.toFixed(2),
        initial_count_fp: count.toFixed(2), remaining_count_fp: (count - filled).toFixed(2), yes_price_dollars: yesPrice.toFixed(4), no_price_dollars: (1 - yesPrice).toFixed(4),
        taker_fill_cost_dollars: (filled * 0.47).toFixed(4), maker_fill_cost_dollars: '0.0000',
        taker_fees_dollars: filled ? (Math.ceil(0.07 * filled * 0.25 * 100) / 100).toFixed(4) : '0.0000', maker_fees_dollars: '0.0000',
        created_time: new Date(Date.now()).toISOString(), last_update_time: new Date(Date.now()).toISOString()};
      state.orders = [...(state.orders ?? []), state.order];
      if (filled) state.fills = [...(state.fills ?? []), {order_id: orderId, ticker, count_fp: filled.toFixed(2), yes_price_dollars: '0.4700', no_price_dollars: '0.5300',
        outcome_side: body.side === 'ask' ? 'no' : 'yes', fee_cost: state.order.taker_fees_dollars}];
      state.holdings = body.side === 'ask' ? -filled : filled;
      write(state);
      if (state.loseResponse) throw new Error('Simulated response loss after acceptance');
      return response({order_id: state.order.order_id, fill_count: count.toFixed(2), remaining_count: '0.00', ts_ms: Date.now()});
    }
    if (path.startsWith('/portfolio/orders/') && method === 'GET') {
      const found = (state.orders ?? []).find(o => path === '/portfolio/orders/' + o.order_id);
      if (found) return response({order: found});
      return new Response('{}', {status: 404});
    }
    if (path === '/portfolio/orders' && method === 'GET') {
      return response({orders: (state.orders ?? []).filter(o => o.ticker === url.searchParams.get('ticker')), cursor: ''});
    }
    if (path === '/portfolio/fills' && method === 'GET') {
      return response({fills: (state.fills ?? []).filter(f => f.order_id === url.searchParams.get('order_id')), cursor: ''});
    }
  } else {
    if (authenticated) throw new Error('Public request unexpectedly carried credentials');
    if (path === '/series/KXBTCD') return response({series: {ticker: 'KXBTCD', fee_type: 'quadratic', fee_multiplier: 1}});
    if (path === '/events/' + state.event.event.event_ticker) return response(state.event);
    if (path === '/markets/' + ticker) return response({market: market()});
    if (path === '/markets/' + ticker + '/orderbook') return response({orderbook_fp: {
      yes_dollars: [['0.0100', '1000.00'], ['0.5000', '500.00']], no_dollars: [['0.0100', '1000.00'], ['0.4900', '500.00']],
    }});
  }
  throw new Error('Unexpected test network request: '+method+' '+url.origin+url.pathname);
};
`;

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'perp-episode-kalshi-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const episodePath = join(dir, 'episode.json');
  const statePath = join(dir, 'exchange.json');
  const preloadPath = join(dir, 'preload.mjs');
  const keyPath = join(dir, 'kalshi.key');
  // Ephemeral synthetic key pair, never a real exchange credential.
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  writeFileSync(preloadPath, PRELOAD);
  writeFileSync(statePath, JSON.stringify({
    event: fixtureEvent, requests: [], mutationCount: 0, holdings: 0, loseResponse: false, publicResult: '', settlementRecord: null,
  } satisfies ExchangeState));
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    NODE_ENV: 'test', HL_NET: 'testnet',
    UNDERPOD_EPISODE: episodePath,
    XDG_CONFIG_HOME: dir, // never pick up the real operator credentials file
    UNDERPOD_WALLET: '0x0000000000000000000000000000000000000001',
    MOCK_EXCHANGE_FILE: statePath, MOCK_NOW: String(NOW),
    MOCK_KALSHI_PUBLIC_KEY: publicKey.export({ type: 'spki', format: 'pem' }) as string,
    KALSHI_API_KEY_ID: 'test-key-id-0001', KALSHI_PRIVATE_KEY_FILE: keyPath,
  };
  const run = (...args: string[]) => spawnSync(process.execPath, [
    '--import', import.meta.resolve('tsx'), '--import', preloadPath, join(ROOT, 'scripts/episode.ts'), ...args,
  ], { cwd: dir, env, encoding: 'utf8', timeout: 15_000, maxBuffer: 2_000_000 });
  const readEpisode = () => JSON.parse(readFileSync(episodePath, 'utf8')) as Episode;
  const readExchange = () => JSON.parse(readFileSync(statePath, 'utf8')) as ExchangeState;
  const setExchange = (update: (state: ExchangeState) => void) => {
    const state = readExchange(); update(state); writeFileSync(statePath, JSON.stringify(state));
  };
  const plan = () => {
    const result = run('plan', '--theme', 'Consumer crypto returns', '--coin', 'SOL', '--side', 'long', '--venue', 'kalshi-demo',
      '--thesis', 'Solana fits the consumer-app theme.', '--binary-side', 'down', '--start', new Date(START).toISOString(), '--json');
    success(result);
    return readEpisode();
  };
  const setClock = (timestamp: number) => { env.MOCK_NOW = String(timestamp); };
  // Replaces the operator's key with an unrelated one; the venue still holds the original public half.
  const rotateKey = () => writeFileSync(keyPath, generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }));
  return { run, readEpisode, readExchange, setExchange, setClock, plan, rotateKey };
}

function success(result: SpawnSyncReturns<string>) {
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr || result.stdout);
}
function failure(result: SpawnSyncReturns<string>, message: RegExp) {
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, message);
}

test('Kalshi plan saves the hourly strike nearest 50 cents for the chosen side without trading', (t) => {
  const f = fixture(t);
  const e = f.plan();
  assert.equal(e.binary.market.venue, 'kalshi-demo');
  assert.equal(e.binary.market.slug, TICKER);
  assert.equal(e.binary.market.eventSlug, EVENT);
  assert.equal(e.binary.market.priceToBeat, 84249.99);
  assert.equal(e.binary.market.feeCoefficient, 0.07);
  assert.equal(e.binary.side, 'down');
  assert.equal(e.startsAt, START);
  assert.equal(e.endsAt, END);
  assert.equal(e.binary.market.settlementAt, END + 300_000);
  assert.equal(e.binary.order, undefined);
  const state = f.readExchange();
  assert.equal(state.mutationCount, 0);
  assert.ok(state.requests.every(r => !r.authenticated));
  assert.ok(state.requests.every(r => r.host !== 'external-api.kalshi.com'), 'demo plans never touch production');
});

test('Kalshi prepare bounds the fee locally, checks holdings and submits nothing', (t) => {
  const f = fixture(t); f.plan();
  success(f.run('prepare-binary'));
  const e = f.readEpisode(), state = f.readExchange();
  assert.equal(e.binary.prepared?.state, 'prepared');
  assert.equal(e.binary.prepared?.expiresAt, NOW + 60_000);
  assert.ok(Number.isInteger(e.binary.prepared!.shares) && e.binary.prepared!.shares > 0);
  assert.ok(e.binary.prepared!.shares * 0.6 + Math.ceil(e.binary.prepared!.shares * 0.07 * 0.25 * 100) / 100 <= 50);
  assert.equal(e.binary.order, undefined);
  assert.equal(state.mutationCount, 0);
  assert.ok(state.requests.some(r => r.path === '/trade-api/v2/portfolio/positions' && r.authenticated));
  assert.ok(!state.requests.some(r => r.method === 'POST' && r.path.startsWith('/trade-api/v2/portfolio')));
});

test('Kalshi send submits one signed IOC ask for DOWN, records the paid cost, and refuses duplicates', (t) => {
  const f = fixture(t); const planned = f.plan();
  success(f.run('prepare-binary'));
  success(f.run('send-binary', '--confirm', planned.id));
  const sent = f.readEpisode(), state = f.readExchange();
  assert.equal(state.mutationCount, 1);
  const post = state.requests.find(r => r.method === 'POST' && r.path === '/trade-api/v2/portfolio/events/orders')!;
  assert.equal(post.body!.side, 'ask');
  assert.equal(post.body!.price, '0.4000');
  assert.equal(post.body!.count, sent.binary.prepared!.shares.toFixed(2));
  assert.equal(post.body!.client_order_id, sent.binary.prepared!.clientOrderId);
  assert.equal(sent.binary.prepared?.state, 'submitted');
  assert.equal(sent.binary.order?.id, ORDER_ID);
  assert.equal(sent.binary.order?.filledShares, sent.binary.prepared?.shares);
  // Cost basis comes from the fills' NO price, not the order's YES-leg fill cost.
  assert.equal(sent.binary.order?.averagePrice, 0.53);
  assert.equal(sent.binary.order?.totalCostUsd, Math.round(sent.binary.order!.filledShares * 0.53 * 1e8) / 1e8);
  assert.ok(sent.binary.order!.feesUsd! > 0);
  assert.ok(sent.binary.order!.totalCostUsd! + sent.binary.order!.feesUsd! <= sent.binary.budgetUsd);
  failure(f.run('send-binary', '--confirm', planned.id), /No fresh, unsubmitted/);
  assert.equal(f.readExchange().mutationCount, 1);
  failure(f.run('sync-binary', '--order-id', 'different-order'), /conflicts.*known order/);
  success(f.run('sync-binary', '--order-id', ORDER_ID));
  const synced = f.readEpisode();
  assert.equal(synced.binary.positionCheckedAt, NOW);
  assert.equal(synced.binary.reconciliationError, undefined);
  assert.equal(f.readExchange().mutationCount, 1);
});

test('Kalshi lost response persists an uncertain send that only reconciliation can resolve', (t) => {
  const f = fixture(t); const planned = f.plan();
  success(f.run('prepare-binary'));
  f.setExchange(state => { state.loseResponse = true; });
  failure(f.run('send-binary', '--confirm', planned.id), /needs reconciliation; do not resend.*Kalshi demo/);
  const uncertain = f.readEpisode();
  assert.equal(uncertain.binary.prepared?.state, 'uncertain');
  assert.ok(uncertain.binary.prepared?.clientOrderId);
  assert.equal(uncertain.binary.order, undefined);
  assert.equal(f.readExchange().mutationCount, 1);
  failure(f.run('send-binary', '--confirm', planned.id), /No fresh, unsubmitted/);
  failure(f.run('prepare-binary'), /already has an order\/submission/);
  failure(f.run('sync-binary', '--order-id', 'unknown-order'), /HTTP 404/);
  success(f.run('sync-binary', '--order-id', ORDER_ID));
  const recovered = f.readEpisode();
  assert.equal(recovered.binary.prepared?.state, 'submitted');
  assert.equal(recovered.binary.order?.id, ORDER_ID);
  assert.equal(f.readExchange().mutationCount, 1);
});

test('Kalshi settlement waits for the account settlement record, then records the verified payout', (t) => {
  const f = fixture(t); const planned = f.plan();
  success(f.run('prepare-binary'));
  success(f.run('send-binary', '--confirm', planned.id));
  const shares = f.readEpisode().binary.order!.filledShares;
  f.setClock(END + 1_000);
  f.setExchange(state => { state.holdings = 0; state.publicResult = 'no'; });
  success(f.run('sync-binary'));
  const pending = f.readEpisode();
  assert.equal(pending.binary.finalSettlement, undefined);
  assert.equal(pending.binary.reconciliationError, undefined);
  f.setExchange(state => { state.settlementRecord = { yes: 0, no: shares, result: 'no' }; });
  success(f.run('sync-binary'));
  const settled = f.readEpisode();
  assert.equal(settled.binary.finalSettlement?.shares, shares);
  assert.equal(settled.binary.finalSettlement?.yesValue, 0);
  assert.equal(settled.binary.finalSettlement?.payoutUsd, shares);
  assert.equal(f.readExchange().mutationCount, 1);
});

test('Kalshi refuses to trade when the venue rejects the operator signature', (t) => {
  const f = fixture(t); f.plan();
  f.rotateKey();
  failure(f.run('prepare-binary'), /HTTP 401/);
  const e = f.readEpisode(), state = f.readExchange();
  assert.equal(e.binary.prepared, undefined);
  assert.equal(state.mutationCount, 0);
  assert.ok(!state.requests.some(r => r.method === 'POST' && r.path.startsWith('/trade-api/v2/portfolio')));
});

test('Kalshi definite rejection (e.g. insufficient balance) clears the preparation so it can be prepared again', (t) => {
  const f = fixture(t); const planned = f.plan();
  success(f.run('prepare-binary'));
  f.setExchange(state => { state.rejectStatus = 400; });
  failure(f.run('send-binary', '--confirm', planned.id), /rejected the binary order \(HTTP 400\); nothing was submitted/);
  const rejected = f.readEpisode();
  assert.equal(rejected.binary.prepared, undefined);
  assert.equal(rejected.binary.attempts?.[0]?.outcome, 'rejected');
  f.setExchange(state => { state.rejectStatus = undefined; });
  success(f.run('prepare-binary'));
  success(f.run('send-binary', '--confirm', planned.id));
  assert.equal(f.readEpisode().binary.order?.id, ORDER_ID);
});

test('Kalshi ambiguous 5xx stays uncertain; abandon clears it only once nothing landed', (t) => {
  const f = fixture(t); const planned = f.plan();
  success(f.run('prepare-binary'));
  f.setExchange(state => { state.rejectStatus = 502; });
  failure(f.run('send-binary', '--confirm', planned.id), /needs reconciliation/);
  assert.equal(f.readEpisode().binary.prepared?.state, 'uncertain');
  success(f.run('sync-binary'));
  assert.equal(f.readEpisode().binary.prepared?.state, 'uncertain');
  failure(f.run('abandon-binary', '--confirm', planned.id), /Wait two minutes/);
  f.setClock(NOW + 130_000);
  f.setExchange(state => { state.holdings = -5; });
  failure(f.run('abandon-binary', '--confirm', planned.id), /holds this market/);
  f.setExchange(state => { state.holdings = 0; state.rejectStatus = undefined; });
  success(f.run('abandon-binary', '--confirm', planned.id));
  assert.equal(f.readEpisode().binary.attempts?.at(-1)?.outcome, 'abandoned');
  success(f.run('prepare-binary'));
});

test('Kalshi lost response is found by client order ID without the operator digging', (t) => {
  const f = fixture(t); const planned = f.plan();
  success(f.run('prepare-binary'));
  f.setExchange(state => { state.loseResponse = true; });
  failure(f.run('send-binary', '--confirm', planned.id), /needs reconciliation/);
  success(f.run('sync-binary'));
  const found = f.readEpisode();
  assert.equal(found.binary.prepared?.state, 'submitted');
  assert.equal(found.binary.order?.id, ORDER_ID);
  assert.equal(found.binary.order?.averagePrice, 0.53);
  f.setClock(NOW + 130_000);
  failure(f.run('abandon-binary', '--confirm', planned.id), /Only an uncertain submission/);
  assert.equal(f.readExchange().mutationCount, 1);
});

test('Kalshi zero-fill IOC can be prepared again, and the dead order is never adopted', (t) => {
  const f = fixture(t); const planned = f.plan();
  success(f.run('prepare-binary'));
  f.setExchange(state => { state.fillNothing = true; });
  success(f.run('send-binary', '--confirm', planned.id));
  const missed = f.readEpisode();
  assert.equal(missed.binary.order?.filledShares, 0);
  assert.equal(missed.binary.order?.status, 'canceled');
  success(f.run('prepare-binary'));
  const retry = f.readEpisode();
  assert.equal(retry.binary.order, undefined);
  assert.equal(retry.binary.attempts?.[0]?.orderId, ORDER_ID);
  f.setExchange(state => { state.fillNothing = false; });
  success(f.run('send-binary', '--confirm', planned.id));
  assert.equal(f.readEpisode().binary.order?.id, 'kalshi-order-2');
  failure(f.run('sync-binary', '--order-id', ORDER_ID), /conflicts|earlier attempt/);
});

test('Kalshi finished episode with lower-case venue statuses can be replaced', (t) => {
  const f = fixture(t); const planned = f.plan();
  success(f.run('prepare-binary'));
  success(f.run('send-binary', '--confirm', planned.id));
  const shares = f.readEpisode().binary.order!.filledShares;
  f.setClock(END + 1_000);
  f.setExchange(state => { state.holdings = 0; state.publicResult = 'no'; state.settlementRecord = { yes: 0, no: shares, result: 'no' }; });
  success(f.run('sync-binary'));
  assert.ok(f.readEpisode().binary.finalSettlement);
  const replaced = f.run('plan', '--replace', '--theme', 'Next', '--coin', 'SOL', '--side', 'long', '--venue', 'kalshi-demo',
    '--thesis', 'x', '--binary-side', 'down', '--start', new Date(START).toISOString(), '--json');
  assert.doesNotMatch(replaced.stderr, /terminal state|account settlement/);
});
