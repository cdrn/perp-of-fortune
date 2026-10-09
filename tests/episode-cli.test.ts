import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Episode } from '../src/episode.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const START = Date.parse('2026-10-01T20:00:00Z');
const NOW = START + 120_000;
const END = START + 3_600_000;
const TIME = '20261001-2100';
const WALLET = '0x0000000000000000000000000000000000000001';
const SIG = '0x' + '11'.repeat(64) + '1b';
// Outcome 500 is the coin flip; 501 is lopsided for a DOWN buyer.
const META = { outcomes: [
  { outcome: 500, name: 'template:binaryPrice', description: `perp:BTC|priceDescription:BTC-USDC perp mark|seconds:60|threshold:81944|time:${TIME}`, sideSpecs: [{ name: 'Yes' }, { name: 'No' }], quoteToken: 'USDC', venue: 'skew' },
  { outcome: 501, name: 'template:binaryPrice', description: `perp:BTC|priceDescription:BTC-USDC perp mark|seconds:60|threshold:79000|time:${TIME}`, sideSpecs: [{ name: 'Yes' }, { name: 'No' }], quoteToken: 'USDC', venue: 'skew' },
] };

type Mode = 'fill' | 'miss' | 'reject' | 'http400' | 'http502' | 'lose';
interface ExchangeState {
  meta: typeof META;
  books: Record<string, { bids: [string, string][]; asks: [string, string][] }>;
  usdc: number;
  holdings: Record<string, number>;
  orders: Record<string, unknown>;
  fills: Record<string, unknown>[];
  settled: Record<string, number>;
  mode: Mode;
  mutationCount: number;
  nextOid: number;
  requests: { path: string; type?: string }[];
}

// Replaces networking in each CLI subprocess. The fake exchange persists across
// runs, including an accepted order whose response is lost.
const PRELOAD = String.raw`
import { readFileSync, writeFileSync } from 'node:fs';
const statePath = process.env.MOCK_EXCHANGE_FILE;
const read = () => JSON.parse(readFileSync(statePath, 'utf8'));
const write = state => writeFileSync(statePath, JSON.stringify(state));
Date.now = () => Number(process.env.MOCK_NOW);
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  const body = init.body === undefined ? null : JSON.parse(String(init.body));
  const state = read();
  state.requests.push({ path: url.pathname, type: body?.type ?? body?.action?.type });
  write(state);
  if (url.hostname !== 'api.hyperliquid-testnet.xyz') throw new Error('Unexpected host ' + url.hostname);
  const json = value => Response.json(value);
  if (url.pathname === '/info') {
    if (body.type === 'metaAndAssetCtxs') return json([{ universe: [{ name: 'SOL', szDecimals: 2, maxLeverage: 20 }] }, [{ markPx: '150.00' }]]);
    if (body.type === 'outcomeMeta') return json(state.meta);
    if (body.type === 'l2Book') {
      const book = state.books[body.coin];
      if (!book) return json(null);
      const level = ([px, sz]) => ({ px, sz, n: 1 });
      return json({ coin: body.coin, time: Date.now(), levels: [book.bids.map(level), book.asks.map(level)] });
    }
    if (body.type === 'spotClearinghouseState') return json({ balances: [
      { coin: 'USDC', token: 0, total: String(state.usdc), hold: '0.0', entryNtl: '0.0' },
      ...Object.entries(state.holdings).map(([coin, total]) => ({ coin: '+' + coin.slice(1), total: String(total), hold: '0.0', entryNtl: '0.0' })),
    ] });
    if (body.type === 'orderStatus') return json(state.orders[body.oid] ?? { status: 'unknownOid' });
    if (body.type === 'userFillsByTime') return json(state.fills);
    if (body.type === 'settledOutcome') return json(state.settled[body.outcome] === undefined ? null : { spec: { outcome: body.outcome }, settleFraction: String(state.settled[body.outcome]) });
  }
  if (url.pathname === '/exchange') {
    if (state.mode === 'http400') return new Response(JSON.stringify('Failed to deserialize'), { status: 422 });
    if (state.mode === 'http502') return new Response('{}', { status: 502 });
    if (state.mode === 'reject') return json({ status: 'err', response: 'Insufficient spot balance' });
    const order = body.action.orders[0];
    const coin = '#' + (order.a - 100000000);
    state.mutationCount++;
    if (state.mode === 'miss') {
      const oid = state.nextOid++;
      state.orders[order.c] = { status: 'order', order: { order: { coin, side: 'B', limitPx: order.p, sz: '0.0', origSz: order.s + '.0', oid, cloid: order.c }, status: 'canceled' } };
      write(state);
      return json({ status: 'ok', response: { type: 'order', data: { statuses: [{ error: 'Order could not immediately match against any resting orders. asset=' + order.a }] } } });
    }
    const oid = state.nextOid++, shares = Number(order.s), px = state.books[coin].asks[0][0];
    state.orders[order.c] = { status: 'order', order: { order: { coin, side: 'B', limitPx: order.p, sz: '0.0', origSz: order.s + '.0', oid, cloid: order.c }, status: 'filled' } };
    state.fills.push({ coin, px, sz: order.s + '.0', side: 'B', time: Date.now(), dir: 'Buy', oid, fee: '0.0', cloid: order.c });
    state.holdings[coin] = (state.holdings[coin] ?? 0) + shares;
    state.usdc -= shares * Number(px);
    write(state);
    if (state.mode === 'lose') throw new Error('Simulated response loss after acceptance');
    return json({ status: 'ok', response: { type: 'order', data: { statuses: [{ filled: { totalSz: order.s + '.0', avgPx: px, oid } }] } } });
  }
  throw new Error('Unexpected request ' + url.pathname + ' ' + body?.type);
};
`;

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'perp-episode-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const episodePath = join(dir, 'episode.json');
  const statePath = join(dir, 'exchange.json');
  const preloadPath = join(dir, 'preload.mjs');
  writeFileSync(preloadPath, PRELOAD);
  writeFileSync(statePath, JSON.stringify({
    meta: META,
    books: {
      '#5000': { bids: [['0.49', '500']], asks: [['0.51', '500']] },
      '#5001': { bids: [['0.48', '500']], asks: [['0.52', '500']] },
      '#5010': { bids: [['0.92', '500']], asks: [['0.94', '500']] },
      '#5011': { bids: [['0.05', '500']], asks: [['0.08', '500']] },
    },
    usdc: 100, holdings: {}, orders: {}, fills: [], settled: {}, mode: 'fill', mutationCount: 0, nextOid: 77, requests: [],
  } satisfies ExchangeState));
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, NODE_ENV: 'test', HL_NET: 'testnet',
    UNDERPOD_EPISODE: episodePath, UNDERPOD_WALLET: WALLET, TMPDIR: dir,
    MOCK_EXCHANGE_FILE: statePath, MOCK_NOW: String(NOW),
  };
  const run = (...args: string[]) => spawnSync(process.execPath, [
    '--import', import.meta.resolve('tsx'), '--import', preloadPath, join(ROOT, 'scripts/episode.ts'), ...args,
  ], { cwd: dir, env, encoding: 'utf8', timeout: 15_000, maxBuffer: 2_000_000 });
  const readEpisode = () => JSON.parse(readFileSync(episodePath, 'utf8')) as Episode;
  const readExchange = () => JSON.parse(readFileSync(statePath, 'utf8')) as ExchangeState;
  const setExchange = (update: (state: ExchangeState) => void) => {
    const state = readExchange(); update(state); writeFileSync(statePath, JSON.stringify(state));
  };
  const plan = (...extra: string[]) => {
    success(run('plan', '--theme', 'Consumer crypto returns', '--coin', 'SOL', '--side', 'long',
      '--thesis', 'Solana fits the consumer-app theme.', '--binary-side', 'down', '--start', new Date(START).toISOString(), '--json', ...extra));
    return readEpisode();
  };
  const setClock = (timestamp: number) => { env.MOCK_NOW = String(timestamp); };
  const sendAndFill = () => {
    const planned = plan();
    success(run('prepare-binary'));
    success(run('send-binary', '--sig', SIG));
    return planned;
  };
  return { run, readEpisode, readExchange, setExchange, setClock, plan, sendAndFill, episodePath };
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

test('CLI plan saves the pair and the hour without trading or picking a strike', (t) => {
  const f = fixture(t);
  const e = f.plan();
  assert.deepEqual(e.perp, { coin: 'SOL', side: 'long', leverage: 20, marginUsd: 50, thesis: 'Solana fits the consumer-app theme.' });
  assert.equal(e.perpNetwork, 'testnet');
  assert.equal(e.binary.side, 'down');
  assert.equal(e.binary.market, undefined);
  assert.equal(e.startsAt, START);
  assert.equal(e.endsAt, END);
  assert.equal(f.readExchange().mutationCount, 0);
  assert.ok(!f.readExchange().requests.some(r => r.path === '/exchange'));
});

test('CLI prepare picks the coin-flip strike and emits the exact IOC to sign, without sending', (t) => {
  const f = fixture(t); f.plan();
  const result = f.run('prepare-binary');
  success(result);
  const e = f.readEpisode(), p = e.binary.prepared!;
  assert.equal(e.binary.market?.outcome, 500);
  assert.equal(p.state, 'prepared');
  assert.equal(p.shares, 83);
  assert.equal(p.expiresAt, NOW + 120_000);
  assert.deepEqual(p.action.orders[0], { a: 100_005_001, b: true, p: '0.6', s: '83', r: false, t: { limit: { tif: 'Ioc' } }, c: p.cloid });
  assert.match(result.stdout, /"primaryType": "Agent"/);
  assert.match(result.stdout, /#501 \$79000: Binary entry must be quoted/);
  assert.equal(f.readExchange().mutationCount, 0);
});

test('CLI prepare refuses when spot USDC cannot cover the maximum cost, and says how to move it', (t) => {
  const f = fixture(t); f.plan();
  f.setExchange(s => { s.usdc = 20; });
  failure(f.run('prepare-binary'), /Spot USDC 20\.00 is below the \$49\.80 maximum cost[\s\S]*xfer\.ts prepare --dex spot --amount 50/);
  assert.equal(f.readEpisode().binary.prepared, undefined);
});

test('CLI send fills once, records the receipt, refuses a duplicate and syncs from the chain', (t) => {
  const f = fixture(t); f.sendAndFill();
  const sent = f.readEpisode();
  assert.equal(f.readExchange().mutationCount, 1);
  assert.equal(sent.binary.prepared?.state, 'submitted');
  assert.equal(sent.binary.order?.id, '77');
  assert.equal(sent.binary.order?.filledShares, 83);
  assert.equal(sent.binary.order?.averagePrice, 0.52);
  assert.equal(sent.binary.order?.totalCostUsd, 43.16);
  failure(f.run('send-binary', '--sig', SIG), /No fresh, unsubmitted/);
  success(f.run('sync-binary'));
  const synced = f.readEpisode();
  assert.equal(synced.binary.order?.feesUsd, 0);
  assert.equal(synced.binary.reconciliationError, undefined);
  assert.equal(f.readExchange().mutationCount, 1);
});

test('CLI an IOC that misses can be prepared again', (t) => {
  const f = fixture(t); f.plan();
  success(f.run('prepare-binary'));
  f.setExchange(s => { s.mode = 'miss'; });
  failure(f.run('send-binary', '--sig', SIG), /no liquidity[\s\S]*Prepare again/);
  const missed = f.readEpisode();
  assert.equal(missed.binary.prepared, undefined);
  assert.equal(missed.binary.attempts?.[0]?.outcome, 'unfilled');
  f.setExchange(s => { s.mode = 'fill'; });
  success(f.run('prepare-binary'));
  success(f.run('send-binary', '--sig', SIG));
  assert.equal(f.readEpisode().binary.order?.filledShares, 83);
});

test('CLI definite rejections clear the preparation; an ambiguous 5xx does not', (t) => {
  const f = fixture(t); f.plan();
  for (const mode of ['reject', 'http400'] as Mode[]) {
    success(f.run('prepare-binary'));
    f.setExchange(s => { s.mode = mode; });
    failure(f.run('send-binary', '--sig', SIG), /rejected the binary order; nothing was submitted/);
    assert.equal(f.readEpisode().binary.prepared, undefined);
  }
  success(f.run('prepare-binary'));
  f.setExchange(s => { s.mode = 'http502'; });
  failure(f.run('send-binary', '--sig', SIG), /needs reconciliation/);
  assert.equal(f.readEpisode().binary.prepared?.state, 'uncertain');
  failure(f.run('prepare-binary'), /already has an order\/submission/);
  assert.deepEqual(f.readEpisode().binary.attempts?.map(a => a.outcome), ['rejected', 'rejected']);
});

test('CLI a lost response is recovered exactly by client order id, never resent', (t) => {
  const f = fixture(t); f.plan();
  success(f.run('prepare-binary'));
  f.setExchange(s => { s.mode = 'lose'; });
  failure(f.run('send-binary', '--sig', SIG), /needs reconciliation/);
  assert.equal(f.readEpisode().binary.prepared?.state, 'uncertain');
  failure(f.run('send-binary', '--sig', SIG), /No fresh, unsubmitted/);
  failure(f.run('abandon-binary', '--confirm', f.readEpisode().id), /Wait two minutes/);
  f.setClock(NOW + 130_000);
  failure(f.run('abandon-binary', '--confirm', f.readEpisode().id), /Hyperliquid has this order/);
  success(f.run('sync-binary'));
  const recovered = f.readEpisode();
  assert.equal(recovered.binary.prepared?.state, 'submitted');
  assert.equal(recovered.binary.order?.id, '77');
  assert.equal(recovered.binary.order?.filledShares, 83);
  assert.equal(f.readExchange().mutationCount, 1);
});

test('CLI abandon clears a send that never landed, then allows a fresh preparation', (t) => {
  const f = fixture(t); const planned = f.plan();
  success(f.run('prepare-binary'));
  f.setExchange(s => { s.mode = 'http502'; });
  failure(f.run('send-binary', '--sig', SIG), /needs reconciliation/);
  success(f.run('sync-binary'));
  assert.equal(f.readEpisode().binary.prepared?.state, 'uncertain');
  f.setClock(NOW + 130_000);
  failure(f.run('abandon-binary', '--confirm', 'wrong'), /--confirm/);
  f.setExchange(s => { s.holdings['#5001'] = 3; });
  failure(f.run('abandon-binary', '--confirm', planned.id), /holds this outcome/);
  f.setExchange(s => { s.holdings = {}; s.mode = 'fill'; });
  success(f.run('abandon-binary', '--confirm', planned.id));
  assert.equal(f.readEpisode().binary.attempts?.at(-1)?.outcome, 'abandoned');
  f.setClock(NOW + 140_000);
  success(f.run('prepare-binary'));
});

test('CLI settlement records the payout from the account settlement fill', (t) => {
  const f = fixture(t); f.sendAndFill();
  f.setClock(END + 60_000);
  success(f.run('sync-binary'));
  assert.equal(f.readEpisode().binary.finalSettlement, undefined);
  f.setExchange(s => {
    s.settled['500'] = 0;
    delete s.holdings['#5001'];
    s.fills.push({ coin: '#5001', px: '1.0', sz: '83.0', side: 'A', time: END + 30_000, dir: 'Settlement', oid: 900, fee: '0.1' });
  });
  success(f.run('sync-binary'));
  const settled = f.readEpisode().binary.finalSettlement!;
  assert.equal(settled.shares, 83);
  assert.equal(settled.yesValue, 0);
  assert.equal(settled.payoutUsd, 82.9);
});

test('CLI a transient mismatch heals; one at cutoff withholds P&L but not the next episode', (t) => {
  const f = fixture(t); f.sendAndFill();
  f.setExchange(s => { s.holdings['#5001'] = 40; });
  success(f.run('sync-binary'));
  assert.match(f.readEpisode().binary.reconciliationError!, /holdings differ/);
  f.setExchange(s => { s.holdings['#5001'] = 83; });
  success(f.run('sync-binary'));
  assert.equal(f.readEpisode().binary.reconciliationError, undefined);
  f.setExchange(s => { s.holdings['#5001'] = 40; });
  success(f.run('sync-binary'));
  f.setClock(END + 60_000);
  f.setExchange(s => {
    s.settled['500'] = 0; delete s.holdings['#5001'];
    s.fills.push({ coin: '#5001', px: '1.0', sz: '40.0', side: 'A', time: END + 30_000, dir: 'Settlement', oid: 900, fee: '0.0' });
  });
  success(f.run('sync-binary'));
  assert.equal(f.readEpisode().binary.finalSettlement, undefined);
  const next = ['--theme', 'Next', '--coin', 'SOL', '--side', 'long', '--thesis', 'x', '--binary-side', 'up', '--start', new Date(END).toISOString()];
  failure(f.run('plan', ...next), /already exists/);
  success(f.run('plan', '--replace', ...next));
  assert.equal(f.readEpisode().startsAt, END);
});

test('CLI refuses to prepare on a different network than the episode', (t) => {
  const f = fixture(t); f.plan();
  const e = f.readEpisode(); e.perpNetwork = 'mainnet';
  writeFileSync(f.episodePath, JSON.stringify(e));
  const before = f.readExchange().requests.length;
  failure(f.run('prepare-binary'), /rerun with HL_NET=mainnet/);
  assert.equal(f.readExchange().requests.length, before);
});
