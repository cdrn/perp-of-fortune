import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Episode } from '../src/episode.js';
import type { PMOrder } from '../src/polymarket-us.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const START = Date.parse('2026-10-01T20:00:00Z');
const NOW = START + 120_000;
const END = START + 3_600_000;
const SLUG = 'cpc-btc-updown-1h-2026-10-01-2000z';
const ORDER_ID = 'test-order-1';
const fixtureEvent = {
  slug: 'btc-updown-1h-2026-10-01-2000z', title: 'BTC Up or Down: 60 min',
  startDate: new Date(START).toISOString(), endDate: new Date(END).toISOString(), active: true, closed: false,
  markets: [{
    slug: SLUG, question: 'BTC Up or Down: 60 min', active: true, closed: false,
    status: 'MARKET_STATUS_OPEN', description: 'Up if the final Bitcoin BRTI reference price is at or above the opening price; otherwise Down.',
    startDate: '2026-09-30T20:00:14Z', endDate: '2026-10-01T21:30:00Z',
    orderPriceMinTickSize: 0.01, minimumTradeQty: 0.01, feeCoefficient: 0.0695,
    assetPriceTerms: {
      marketType: 'ASSET_PRICE_MARKET_TYPE_UP_DOWN', asset: { symbol: 'btc', assetClass: 'ASSET_CLASS_CRYPTO' },
      horizon: '1h', windowStart: new Date(START).toISOString(), windowEnd: new Date(END).toISOString(),
      priceToBeat: { value: '84000.00', currency: 'USD' },
    },
  }],
};

interface RequestLog {
  method: string;
  host: string;
  path: string;
  authenticated: boolean;
  body: Record<string, unknown> | null;
}
interface ExchangeState {
  event: typeof fixtureEvent;
  requests: RequestLog[];
  mutationCount: number;
  previewCount: number;
  holdings: number;
  loseResponse: boolean;
  publicSettlement: number | null;
  resolutionPosition: number | null;
  rejectStatus?: number;
  fillNothing?: boolean;
  trades?: number;
  order?: PMOrder;
}

// This preloader completely replaces networking in each CLI subprocess. The
// fake exchange survives subprocess restarts, including an accepted order whose
// response is lost, so duplicate prevention is tested across real CLI runs.
const PRELOAD = String.raw`
import { readFileSync, writeFileSync } from 'node:fs';
const statePath = process.env.MOCK_EXCHANGE_FILE;
const read = () => JSON.parse(readFileSync(statePath, 'utf8'));
const write = state => writeFileSync(statePath, JSON.stringify(state));
Date.now = () => Number(process.env.MOCK_NOW);
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  const method = init.method ?? 'GET';
  const body = init.body === undefined ? null : JSON.parse(String(init.body));
  const headers = new Headers(init.headers);
  const state = read();
  const authenticated = headers.has('X-PM-Access-Key') && headers.has('X-PM-Signature');
  state.requests.push({method,host:url.hostname,path:url.pathname,authenticated,body});
  write(state);
  const response = value => Response.json(value);
  if (url.hostname === 'api.hyperliquid-testnet.xyz' && url.pathname === '/info'
      && method === 'POST' && body.type === 'metaAndAssetCtxs') {
    return response([{universe:[{name:'SOL',szDecimals:2,maxLeverage:20}]},[{markPx:'150.00'}]]);
  }
  const slug = state.event.markets[0].slug;
  if (url.hostname === 'gateway.polymarket.us' && method === 'GET') {
    if (authenticated) throw new Error('Public request unexpectedly carried credentials');
    if (url.pathname === '/v1/search') return response({events:[state.event]});
    if (url.pathname === '/v1/market/slug/'+slug) return response({market:{...state.event.markets[0],
      status:state.publicSettlement === null ? 'MARKET_STATUS_RESOLVING' : 'MARKET_STATUS_RESOLVED',
    }});
    if (url.pathname === '/v1/markets/'+slug+'/settlement') return response({slug,settlement:state.publicSettlement});
    if (url.pathname === '/v1/markets/'+slug+'/book') return response({marketData:{
      marketSlug:slug,state:'MARKET_STATE_OPEN',transactTime:new Date(Date.now()).toISOString(),
      bids:[{px:{value:'0.50',currency:'USD'},qty:'500'}],
      offers:[{px:{value:'0.51',currency:'USD'},qty:'500'}],
    }});
  }
  if (url.hostname === 'api.polymarket.us') {
    if (!authenticated) throw new Error('Private request is missing authentication');
    if (url.pathname === '/v1/portfolio/positions' && method === 'GET') {
      return response({positions:state.holdings === 0 ? {} : {[slug]:{netPositionDecimal:String(state.holdings)}},eof:true});
    }
    if (url.pathname === '/v1/portfolio/activities' && method === 'GET') {
      if (state.trades) return response({activities:Array.from({length:state.trades},(_, i)=>({
        type:'ACTIVITY_TYPE_TRADE',trade:{id:'t'+i,marketSlug:slug,qty:'1'}})),eof:true});
      return response({activities:state.resolutionPosition === null ? [] : [{
        type:'ACTIVITY_TYPE_POSITION_RESOLUTION',positionResolution:{marketSlug:slug,
          beforePosition:{netPositionDecimal:String(state.resolutionPosition)},
          afterPosition:{netPositionDecimal:'0'},updateTime:new Date(Date.now()).toISOString(),
        },
      }],eof:true});
    }
    if (url.pathname === '/v1/order/preview' && method === 'POST') {
      if (!body.request || body.request.type !== 'ORDER_TYPE_LIMIT') throw new Error('Invalid preview request');
      state.previewCount++; write(state);
      return response({order:{...body.request,state:'ORDER_STATE_NEW',cumQuantity:0,
        commissionNotionalTotalCollected:{value:String(Math.ceil(body.request.quantity*0.0695*0.25*100)/100),currency:'USD'},
      }});
    }
    if (url.pathname === '/v1/orders' && method === 'POST') {
      if (state.rejectStatus) return new Response('{}',{status:state.rejectStatus});
      state.mutationCount++;
      if (state.fillNothing) {
        state.order = {...body,id:'test-order-'+state.mutationCount,state:'ORDER_STATE_CANCELED',cumQuantity:0,leavesQuantity:0,
          insertTime:new Date(Date.now()).toISOString()};
        write(state);
        return response({id:state.order.id});
      }
      state.order = {...body,id:'test-order-1',state:'ORDER_STATE_FILLED',cumQuantity:body.quantity,leavesQuantity:0,
        avgPx:{value:'0.50',currency:'USD'},insertTime:new Date(Date.now()).toISOString(),
        commissionNotionalTotalCollected:{value:String(Math.ceil(body.quantity*0.0695*0.25*100)/100),currency:'USD'},
      };
      state.holdings = body.intent === 'ORDER_INTENT_BUY_SHORT' ? -body.quantity : body.quantity;
      write(state);
      if (state.loseResponse) throw new Error('Simulated response loss after acceptance');
      return response({id:state.order.id});
    }
    if (url.pathname.startsWith('/v1/order/') && method === 'GET') {
      if (state.order && url.pathname === '/v1/order/'+state.order.id) return response({order:state.order});
      return new Response('{}',{status:404});
    }
  }
  throw new Error('Unexpected test network request: '+method+' '+url.origin+url.pathname);
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
    event: fixtureEvent, requests: [], mutationCount: 0, previewCount: 0, holdings: 0, loseResponse: false,
    publicSettlement: null, resolutionPosition: null,
  } satisfies ExchangeState));
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    NODE_ENV: 'test', HL_NET: 'testnet',
    UNDERPOD_EPISODE: episodePath,
    UNDERPOD_WALLET: '0x0000000000000000000000000000000000000001',
    MOCK_EXCHANGE_FILE: statePath, MOCK_NOW: String(NOW),
    // Ephemeral synthetic material, never a real exchange credential.
    PM_US_API_KEY: 'synthetic-test-key', PM_US_SECRET_KEY: randomBytes(32).toString('base64'),
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
    const result = run('plan', '--theme', 'Consumer crypto returns', '--coin', 'SOL', '--side', 'long',
      '--thesis', 'Solana fits the consumer-app theme.', '--binary-side', 'down', '--start', new Date(START).toISOString(), '--json');
    success(result);
    return readEpisode();
  };
  const setClock = (timestamp: number) => { env.MOCK_NOW = String(timestamp); };
  return { run, readEpisode, readExchange, setExchange, setClock, plan };
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

test('CLI plan saves one exact hourly BTC binary alongside the thematic perp without trading', (t) => {
  const f = fixture(t);
  const e = f.plan();
  assert.equal(e.theme, 'Consumer crypto returns');
  assert.deepEqual(e.perp, { coin: 'SOL', side: 'long', leverage: 20, marginUsd: 50, thesis: 'Solana fits the consumer-app theme.' });
  assert.equal(e.perpNetwork, 'testnet');
  assert.equal(e.binary.market.slug, SLUG);
  assert.equal(e.binary.market.venue, 'polymarket-us');
  assert.equal(e.binary.side, 'down');
  assert.equal(e.startsAt, START);
  assert.equal(e.endsAt, END);
  assert.equal(e.binary.market.settlementAt, END + 1_800_000);
  assert.equal(e.binary.order, undefined);
  const state = f.readExchange();
  assert.equal(state.mutationCount, 0);
  assert.equal(state.previewCount, 0);
  assert.ok(state.requests.every(r => !r.authenticated));
});

test('CLI prepare previews a budgeted IOC order without submitting either leg', (t) => {
  const f = fixture(t); f.plan();
  success(f.run('prepare-binary'));
  const e = f.readEpisode(), state = f.readExchange();
  assert.equal(e.binary.prepared?.state, 'prepared');
  assert.equal(e.binary.prepared?.expiresAt, NOW + 60_000);
  assert.ok(e.binary.prepared!.shares > 0);
  assert.equal(e.binary.order, undefined);
  assert.equal(state.mutationCount, 0);
  assert.equal(state.previewCount, 1);
  const preview = state.requests.find(r => r.path === '/v1/order/preview')!;
  const request = preview.body!.request as Record<string, unknown>;
  assert.equal(request.intent, 'ORDER_INTENT_BUY_SHORT');
  assert.deepEqual(request.price, { value: '0.4', currency: 'USD' });
  assert.equal(request.tif, 'TIME_IN_FORCE_IMMEDIATE_OR_CANCEL');
  assert.ok(!state.requests.some(r => ['/v1/orders', '/exchange'].includes(r.path)));
});

test('CLI send submits once, saves actual fills, rejects duplicate sends, and syncs the known ID', (t) => {
  const f = fixture(t); const planned = f.plan();
  success(f.run('prepare-binary'));
  success(f.run('send-binary', '--confirm', planned.id));
  const sent = f.readEpisode();
  assert.equal(f.readExchange().mutationCount, 1);
  assert.equal(sent.binary.prepared?.state, 'submitted');
  assert.equal(sent.binary.order?.id, ORDER_ID);
  assert.equal(sent.binary.order?.filledShares, sent.binary.prepared?.shares);
  assert.equal(sent.binary.order?.averagePrice, 0.5);
  assert.equal(sent.binary.order?.totalCostUsd, sent.binary.order!.filledShares * 0.5);
  assert.ok(sent.binary.order!.feesUsd! > 0);
  assert.ok(sent.binary.order!.totalCostUsd! + sent.binary.order!.feesUsd! <= sent.binary.budgetUsd);
  failure(f.run('send-binary', '--confirm', planned.id), /No fresh, unsubmitted/);
  assert.equal(f.readExchange().mutationCount, 1);
  const beforeWrongId = f.readExchange().requests.length;
  failure(f.run('sync-binary', '--order-id', 'different-order'), /conflicts.*known order/);
  assert.equal(f.readExchange().requests.length, beforeWrongId);
  success(f.run('sync-binary', '--order-id', ORDER_ID));
  const synced = f.readEpisode();
  assert.equal(synced.binary.positionCheckedAt, NOW);
  assert.equal(synced.binary.reconciliationError, undefined);
  assert.equal(synced.binary.order?.id, ORDER_ID);
  assert.equal(f.readExchange().mutationCount, 1);
});

test('CLI lost response persists uncertain state and requires reconciliation instead of retrying', (t) => {
  const f = fixture(t); const planned = f.plan();
  success(f.run('prepare-binary'));
  f.setExchange(state => { state.loseResponse = true; });
  failure(f.run('send-binary', '--confirm', planned.id), /needs reconciliation; do not resend/);
  const uncertain = f.readEpisode();
  assert.equal(uncertain.binary.prepared?.state, 'uncertain');
  assert.equal(uncertain.binary.prepared?.orderId, undefined);
  assert.equal(uncertain.binary.order, undefined);
  assert.equal(f.readExchange().mutationCount, 1);
  failure(f.run('send-binary', '--confirm', planned.id), /No fresh, unsubmitted/);
  failure(f.run('prepare-binary'), /already has an order\/submission/);
  assert.equal(f.readExchange().mutationCount, 1);
  failure(f.run('sync-binary', '--order-id', 'unknown-order'), /HTTP 404/);
  assert.equal(f.readEpisode().binary.prepared?.state, 'uncertain');
  success(f.run('sync-binary', '--order-id', ORDER_ID));
  const recovered = f.readEpisode();
  assert.equal(recovered.binary.prepared?.state, 'submitted');
  assert.equal(recovered.binary.prepared?.orderId, ORDER_ID);
  assert.equal(recovered.binary.order?.id, ORDER_ID);
  assert.equal(recovered.binary.positionCheckedAt, NOW);
  assert.equal(f.readExchange().mutationCount, 1);
});

test('CLI settlement waits when inventory clears before the public result, then records verified payout', (t) => {
  const f = fixture(t); const planned = f.plan();
  success(f.run('prepare-binary'));
  success(f.run('send-binary', '--confirm', planned.id));
  const shares = f.readEpisode().binary.order!.filledShares;
  f.setClock(END + 1_000);
  f.setExchange(state => { state.holdings = 0; });
  success(f.run('sync-binary'));
  const pending = f.readEpisode();
  assert.equal(pending.binary.finalSettlement, undefined);
  assert.equal(pending.binary.reconciliationError, undefined);
  f.setExchange(state => { state.publicSettlement = 0; state.resolutionPosition = -shares; });
  success(f.run('sync-binary'));
  const settled = f.readEpisode();
  assert.equal(settled.binary.finalSettlement?.shares, shares);
  assert.equal(settled.binary.finalSettlement?.yesValue, 0);
  assert.equal(settled.binary.finalSettlement?.payoutUsd, shares);
  assert.equal(settled.binary.reconciliationError, undefined);
  assert.equal(f.readExchange().mutationCount, 1);
});

test('CLI settlement preserves a holdings mismatch observed before cutoff', (t) => {
  const f = fixture(t); const planned = f.plan();
  success(f.run('prepare-binary'));
  success(f.run('send-binary', '--confirm', planned.id));
  const shares = f.readEpisode().binary.order!.filledShares;
  f.setExchange(state => { state.holdings = -shares / 2; });
  success(f.run('sync-binary'));
  assert.match(f.readEpisode().binary.reconciliationError!, /holdings differ/);
  f.setClock(END + 1_000);
  f.setExchange(state => { state.holdings = 0; state.publicSettlement = 0; state.resolutionPosition = -shares; });
  success(f.run('sync-binary'));
  assert.equal(f.readEpisode().binary.finalSettlement, undefined);
  assert.match(f.readEpisode().binary.reconciliationError!, /review the account activity/);
});

test('CLI definite 4xx rejection clears the preparation so the operator can prepare again', (t) => {
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
  assert.equal(f.readExchange().mutationCount, 1);
});

test('CLI ambiguous 5xx still requires reconciliation', (t) => {
  const f = fixture(t); const planned = f.plan();
  success(f.run('prepare-binary'));
  f.setExchange(state => { state.rejectStatus = 502; });
  failure(f.run('send-binary', '--confirm', planned.id), /needs reconciliation; do not resend/);
  assert.equal(f.readEpisode().binary.prepared?.state, 'uncertain');
});

test('CLI abandon clears an uncertain send only when the account shows no order landed', (t) => {
  const f = fixture(t); const planned = f.plan();
  success(f.run('prepare-binary'));
  f.setExchange(state => { state.rejectStatus = 504; });
  failure(f.run('send-binary', '--confirm', planned.id), /needs reconciliation/);
  failure(f.run('abandon-binary', '--confirm', planned.id), /Wait two minutes/);
  f.setClock(NOW + 130_000);
  f.setExchange(state => { state.trades = 1; });
  failure(f.run('abandon-binary', '--confirm', planned.id), /has a trade in this market/);
  f.setExchange(state => { state.trades = 0; state.holdings = -3; });
  failure(f.run('abandon-binary', '--confirm', planned.id), /holds this market/);
  assert.equal(f.readEpisode().binary.prepared?.state, 'uncertain');
  f.setExchange(state => { state.holdings = 0; state.rejectStatus = undefined; });
  failure(f.run('abandon-binary', '--confirm', 'wrong-id'), /--confirm/);
  success(f.run('abandon-binary', '--confirm', planned.id));
  const abandoned = f.readEpisode();
  assert.equal(abandoned.binary.prepared, undefined);
  assert.equal(abandoned.binary.attempts?.[0]?.outcome, 'abandoned');
  success(f.run('prepare-binary'));
});

test('CLI zero-fill IOC can be prepared again, and the dead order cannot be recovered as the new one', (t) => {
  const f = fixture(t); const planned = f.plan();
  success(f.run('prepare-binary'));
  f.setExchange(state => { state.fillNothing = true; });
  success(f.run('send-binary', '--confirm', planned.id));
  const missed = f.readEpisode();
  assert.equal(missed.binary.order?.filledShares, 0);
  const deadId = missed.binary.order!.id;
  success(f.run('prepare-binary'));
  const retry = f.readEpisode();
  assert.equal(retry.binary.order, undefined);
  assert.deepEqual(retry.binary.attempts?.map(a => [a.orderId, a.outcome]), [[deadId, 'unfilled']]);
  f.setExchange(state => { state.rejectStatus = 503; });
  failure(f.run('send-binary', '--confirm', planned.id), /needs reconciliation/);
  failure(f.run('sync-binary', '--order-id', deadId), /earlier attempt/);
  assert.equal(f.readEpisode().binary.prepared?.state, 'uncertain');
});

test('CLI recovery refuses an order created before the uncertain preparation', (t) => {
  const f = fixture(t); const planned = f.plan();
  success(f.run('prepare-binary'));
  f.setExchange(state => { state.loseResponse = true; });
  failure(f.run('send-binary', '--confirm', planned.id), /needs reconciliation/);
  f.setExchange(state => { state.order!.insertTime = new Date(NOW - 300_000).toISOString(); });
  failure(f.run('sync-binary', '--order-id', ORDER_ID), /created before this preparation/);
  assert.equal(f.readEpisode().binary.prepared?.state, 'uncertain');
});

test('CLI transient pre-cutoff mismatch heals, and a withheld result does not block the next episode', (t) => {
  const f = fixture(t); const planned = f.plan();
  success(f.run('prepare-binary'));
  success(f.run('send-binary', '--confirm', planned.id));
  const shares = f.readEpisode().binary.order!.filledShares;
  f.setExchange(state => { state.holdings = -shares / 2; });
  success(f.run('sync-binary'));
  assert.match(f.readEpisode().binary.reconciliationError!, /holdings differ/);
  f.setExchange(state => { state.holdings = -shares; });
  success(f.run('sync-binary'));
  assert.equal(f.readEpisode().binary.reconciliationError, undefined);
  // A real mismatch at cutoff still withholds P&L, but no longer strands the operator.
  f.setExchange(state => { state.holdings = -shares / 2; });
  success(f.run('sync-binary'));
  f.setClock(END + 1_000);
  f.setExchange(state => { state.holdings = 0; state.publicSettlement = 0; state.resolutionPosition = -shares / 2; });
  success(f.run('sync-binary'));
  assert.equal(f.readEpisode().binary.finalSettlement, undefined);
  // List the next hour so planning the replacement can discover a market.
  f.setExchange(state => {
    const shift = (iso: string) => new Date(Date.parse(iso) + 3_600_000).toISOString();
    const m = state.event.markets[0]!;
    state.event.slug += '-next'; m.slug += '-next';
    state.event.startDate = shift(state.event.startDate); state.event.endDate = shift(state.event.endDate);
    m.assetPriceTerms.windowStart = shift(m.assetPriceTerms.windowStart); m.assetPriceTerms.windowEnd = shift(m.assetPriceTerms.windowEnd);
  });
  const next = ['--theme', 'Next', '--coin', 'SOL', '--side', 'long', '--thesis', 'x', '--binary-side', 'up', '--start', new Date(END).toISOString(), '--json'];
  failure(f.run('plan', ...next), /already exists/);
  const replaced = f.run('plan', '--replace', ...next);
  success(replaced);
  assert.equal(f.readEpisode().startsAt, END);
});
