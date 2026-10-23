import { constants, createPrivateKey, sign, type KeyObject } from 'node:crypto';
import type { BinaryMarket, BinaryOrderReceipt, BinaryQuote, BinarySide, BinaryVenueId, DiscoveryOptions } from './binary-types.js';

/** Kalshi Trade API v2 (CFTC-regulated US exchange). Sources verified 2026-10-21:
 * https://docs.kalshi.com/getting_started/quick_start_authenticated_requests (RSA-PSS over ts+METHOD+path)
 * https://docs.kalshi.com/getting_started/api_environments (production + demo hosts)
 * https://docs.kalshi.com/getting_started/orderbook_responses (bids only; YES ask = 1 - best NO bid)
 * https://docs.kalshi.com/api-reference/orders/create-order-v2 (side bid/ask, everything quoted on YES)
 * https://docs.kalshi.com/api-reference/orders/get-order, portfolio/get-positions, portfolio/get-settlements
 * Live: GET /series/KXBTCD is the hourly "Bitcoin price Above/below" ladder settling on CF Benchmarks BRTI.
 */
export const KALSHI_API: Record<KalshiVenue, string> = {
  kalshi: 'https://external-api.kalshi.com/trade-api/v2',
  'kalshi-demo': 'https://external-api.demo.kalshi.co/trade-api/v2',
};
export type KalshiVenue = Extract<BinaryVenueId, 'kalshi' | 'kalshi-demo'>;
export const KALSHI_SERIES = 'KXBTCD';
/** Quadratic taker fee: 0.07 × contracts × P × (1 − P), rounded up per order (fee_multiplier scales it). */
export const KALSHI_TAKER_FEE_RATE = 0.07;
export const KALSHI_MINIMUM_CONTRACTS = 1;

export interface KalshiOrderRequest {
  ticker: string;
  /** bid buys YES; ask sells YES, which is how NO exposure is bought (quoted as 1 − NO price). */
  side: 'bid' | 'ask';
  count: string;
  price: string;
  time_in_force: 'immediate_or_cancel';
  self_trade_prevention_type: 'taker_at_cross';
  client_order_id: string;
}
export interface KalshiCreateOrderResponse { order_id?: string; fill_count?: string; remaining_count?: string; average_fill_price?: string; average_fee_paid?: string; ts_ms?: number }
export interface KalshiOrder {
  order_id?: string; client_order_id?: string; ticker?: string; outcome_side?: string; book_side?: string; type?: string; status?: string;
  yes_price_dollars?: string; no_price_dollars?: string; initial_count_fp?: string; fill_count_fp?: string; remaining_count_fp?: string;
  taker_fees_dollars?: string; maker_fees_dollars?: string; taker_fill_cost_dollars?: string; maker_fill_cost_dollars?: string;
  created_time?: string | null; last_update_time?: string | null;
}
export interface KalshiOrderResponse { order: KalshiOrder }
export interface KalshiPosition { ticker?: string; position_fp?: string; market_exposure_dollars?: string; fees_paid_dollars?: string; realized_pnl_dollars?: string }
export interface KalshiPositionsResponse { market_positions?: KalshiPosition[]; cursor?: string }
export interface KalshiSettlement { ticker?: string; market_result?: string; yes_count_fp?: string; no_count_fp?: string; revenue?: number; settled_time?: string; fee_cost?: string }
export interface KalshiSettlementsResponse { settlements?: KalshiSettlement[]; cursor?: string }
export interface ExpectedOrder { ticker: string; side: BinarySide; shares: number; limitPrice: number }
export interface KalshiFill { order_id?: string; ticker?: string; count_fp?: string; yes_price_dollars?: string; no_price_dollars?: string; outcome_side?: string; fee_cost?: string }
export interface KalshiFillsResponse { fills?: KalshiFill[]; cursor?: string }
export interface KalshiOrdersResponse { orders?: KalshiOrder[]; cursor?: string }

type JsonObject = Record<string, unknown>;
const HOUR = 60 * 60 * 1000;
const object = (value: unknown): JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const string = (value: unknown): string => typeof value === 'string' ? value : '';
function number(value: unknown): number | null {
  if (typeof value !== 'number' && (typeof value !== 'string' || value.trim() === '')) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function timestamp(value: unknown): number | null {
  const t = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(t) ? t : null;
}
const round = (value: number): number => Math.round(value * 1e8) / 1e8;
function sideCheck(side: BinarySide): void {
  if (side !== 'up' && side !== 'down') throw new Error('Binary side must be up or down');
}
export function safeTicker(value: string): string {
  if (!/^[A-Za-z0-9._-]{1,120}$/.test(value)) throw new Error('Invalid Kalshi identifier');
  return encodeURIComponent(value);
}

/** Hourly events are keyed by the close hour in New York time, e.g. KXBTCD-26OCT2217 closes 17:00 ET on 2026-10-22. */
export function hourlyEventTicker(closeTime: number, series = KALSHI_SERIES): string {
  if (!Number.isFinite(closeTime) || closeTime % HOUR !== 0) throw new Error('Kalshi hourly contracts close on full-hour boundaries');
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: '2-digit', month: 'short', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(closeTime));
  const part = (type: string) => parts.find(p => p.type === type)?.value ?? '';
  const month = part('month').toUpperCase().slice(0, 3), hour = part('hour').padStart(2, '0');
  if (!/^\d\d$/.test(part('year')) || !/^[A-Z]{3}$/.test(month) || !/^\d\d$/.test(part('day')) || !/^\d\d$/.test(hour)) throw new Error('Could not format the Kalshi event hour');
  return `${series}-${part('year')}${month}${part('day')}${hour}`;
}

export function feeCoefficient(series: unknown): number {
  const s = object(object(series).series ?? series);
  const multiplier = number(s.fee_multiplier);
  if (!/^quadratic/.test(string(s.fee_type)) || multiplier === null || multiplier < 0 || multiplier > 10) throw new Error('Kalshi series fee schedule is not the expected quadratic curve');
  return round(KALSHI_TAKER_FEE_RATE * multiplier);
}

function priceTick(market: JsonObject): number | null {
  const ranges = array(market.price_ranges).map(object);
  if (ranges.length !== 1) return null; // Tapered sub-cent grids are not used for this ladder; refuse rather than guess.
  const step = number(ranges[0]!.step), start = number(ranges[0]!.start), end = number(ranges[0]!.end);
  if (step === null || step <= 0 || step >= 1 || start !== 0 || end !== 1) return null;
  return step;
}

export interface StrikeSelection { venue: KalshiVenue; eventTitle: string; feeCoefficient: number }
/** Converts one Kalshi market into the venue-neutral record; the episode hour is the hour ending at close_time. */
export function marketFromKalshi(raw: unknown, selection: StrikeSelection): BinaryMarket | null {
  const market = object(raw);
  const ticker = string(market.ticker), eventTicker = string(market.event_ticker);
  const endsAt = timestamp(market.close_time), strike = number(market.floor_strike), tick = priceTick(market);
  if (!ticker.startsWith(`${KALSHI_SERIES}-`) || !eventTicker || !ticker.startsWith(`${eventTicker}-`) || market.market_type !== 'binary'
    || market.strike_type !== 'greater' || strike === null || endsAt === null || endsAt % HOUR !== 0 || tick === null || !string(market.rules_primary)) return null;
  const label = string(market.yes_sub_title) || string(market.subtitle) || `Above $${strike}`;
  return {
    venue: selection.venue, slug: ticker, eventSlug: eventTicker, title: `${label} · ${selection.eventTitle}`,
    startsAt: endsAt - HOUR, endsAt, settlementAt: timestamp(market.expected_expiration_time), rules: string(market.rules_primary),
    status: string(market.status), priceTick: tick, minimumShares: KALSHI_MINIMUM_CONTRACTS, feeCoefficient: selection.feeCoefficient, priceToBeat: strike,
  };
}

/** Picks the strike whose entry ask for this side sits nearest 50 cents: the double-or-nothing contract. */
export function selectHourlyStrike(eventResponse: unknown, options: DiscoveryOptions & { venue: KalshiVenue; feeCoefficient: number }): BinaryMarket {
  const now = options.now ?? Date.now();
  const minRemainingMs = options.minRemainingMs ?? 45 * 60 * 1000;
  const targetEnd = options.targetEnd ?? options.episodeStart + HOUR;
  if (!Number.isFinite(options.episodeStart) || !Number.isFinite(now) || !Number.isFinite(minRemainingMs) || minRemainingMs < 0 || minRemainingMs > HOUR
    || !Number.isFinite(targetEnd) || targetEnd <= options.episodeStart || targetEnd - options.episodeStart !== HOUR) {
    throw new Error('Invalid episode window');
  }
  if (targetEnd <= now || targetEnd - Math.max(now, options.episodeStart) < minRemainingMs) throw new Error('The Kalshi hourly Bitcoin contract for this window has too little time remaining');
  const root = object(eventResponse), event = object(root.event);
  if (string(event.series_ticker) !== KALSHI_SERIES || string(event.event_ticker) !== hourlyEventTicker(targetEnd)) throw new Error('Kalshi returned a different hourly Bitcoin event');
  const side = options.side ?? 'up';
  sideCheck(side);
  const candidates: { market: BinaryMarket; ask: number | null }[] = [];
  // GET /events/{ticker} nests markets under event.markets with with_nested_markets, else at the top level.
  for (const raw of array(root.markets).length ? array(root.markets) : array(event.markets)) {
    const market = marketFromKalshi(raw, { venue: options.venue, eventTitle: string(event.title), feeCoefficient: options.feeCoefficient });
    if (!market || market.endsAt !== targetEnd) continue;
    const m = object(raw);
    const open = market.status === 'active' && (timestamp(m.open_time) ?? 0) <= now;
    if (!open && !(options.allowUpcoming === true && ['initialized', 'inactive', 'active'].includes(market.status))) continue;
    const yesBid = number(m.yes_bid_dollars), yesAsk = number(m.yes_ask_dollars), noAsk = number(m.no_ask_dollars);
    const quoted = yesBid !== null && yesAsk !== null && yesBid > 0 && yesAsk < 1;
    const ask = side === 'up' ? yesAsk : noAsk ?? (yesBid === null ? null : round(1 - yesBid));
    candidates.push({ market, ask: open && quoted && ask !== null ? ask : null });
  }
  if (candidates.length === 0) throw new Error('No eligible Kalshi hourly Bitcoin strike matches the episode window. Start near the hour or specify a matching episode start/end.');
  const quoted = candidates.filter(c => c.ask !== null).sort((a, b) => Math.abs(a.ask! - 0.5) - Math.abs(b.ask! - 0.5) || a.market.priceToBeat! - b.market.priceToBeat!);
  if (quoted[0]) return quoted[0].market;
  if (options.allowUpcoming !== true) throw new Error('No Kalshi strike is quoted two-sided yet; the strike is chosen from the live book when preparing the order');
  // Planning before the book exists: keep the ladder's middle strike as a provisional placeholder.
  const ladder = candidates.sort((a, b) => a.market.priceToBeat! - b.market.priceToBeat!);
  const middle = ladder[Math.floor(ladder.length / 2)]!.market;
  return { ...middle, title: `${middle.title} (provisional strike; re-selected at prepare)` };
}

export function quoteFromBook(response: unknown, side: BinarySide, status: string, now: number): BinaryQuote {
  sideCheck(side);
  const book = object(object(response).orderbook_fp);
  const bids = (raw: unknown) => array(raw).map(level => {
    const [price, size] = Array.isArray(level) ? level : [];
    return { price: number(price), size: number(size) };
  }).filter((level): level is { price: number; size: number } => level.price !== null && level.price > 0 && level.price < 1 && level.size !== null && level.size > 0)
    .sort((a, b) => b.price - a.price);
  const yes = bids(book.yes_dollars), no = bids(book.no_dollars);
  const bestYes = yes[0], bestNo = no[0];
  if (bestYes && bestNo && bestYes.price + bestNo.price >= 1) throw new Error('Kalshi returned a crossed order book');
  const depth = (levels: typeof yes, best: typeof bestYes) => best ? levels.filter(l => l.price === best.price).reduce((sum, l) => sum + l.size, 0) : 0;
  const open = status === 'active';
  // Buying this side lifts the complementary bid; selling it hits this side's own bid.
  const buyFrom = side === 'up' ? bestNo : bestYes, sellInto = side === 'up' ? bestYes : bestNo;
  return {
    open,
    buyPrice: open && buyFrom ? round(1 - buyFrom.price) : null,
    sellPrice: open && sellInto ? sellInto.price : null,
    availableShares: open ? depth(side === 'up' ? no : yes, buyFrom) : 0,
    sellAvailableShares: open ? depth(side === 'up' ? yes : no, sellInto) : 0,
    updatedAt: now, // The book carries no exchange timestamp; freshness is the fetch time.
    status,
  };
}

export function buildOrderRequest(input: { ticker: string; side: BinarySide; shares: number; maxPrice: number; priceTick?: number; clientOrderId: string }): KalshiOrderRequest {
  safeTicker(input.ticker);
  sideCheck(input.side);
  const tick = input.priceTick ?? 0.01;
  if (!Number.isInteger(input.shares) || input.shares < KALSHI_MINIMUM_CONTRACTS) throw new Error('Kalshi contracts must be a positive whole number');
  if (!Number.isFinite(input.maxPrice) || input.maxPrice <= 0 || input.maxPrice >= 1 || !Number.isFinite(tick) || tick <= 0 || tick >= 1) throw new Error('Invalid binary limit price');
  const yesPrice = input.side === 'up' ? input.maxPrice : round(1 - input.maxPrice);
  if (Math.abs(yesPrice / tick - Math.round(yesPrice / tick)) > 1e-7) throw new Error('Binary limit price must match the market tick size');
  if (!/^[A-Za-z0-9:_-]{1,64}$/.test(input.clientOrderId)) throw new Error('Invalid client order ID');
  return {
    ticker: input.ticker, side: input.side === 'up' ? 'bid' : 'ask', count: input.shares.toFixed(2), price: yesPrice.toFixed(4),
    time_in_force: 'immediate_or_cancel', self_trade_prevention_type: 'taker_at_cross', client_order_id: input.clientOrderId,
  };
}

/** Never treats an accepted order ID as a filled position; the fill count and paid cost come from the order record. */
export function normalizeOrder(response: KalshiOrderResponse | KalshiOrder, expected: ExpectedOrder): BinaryOrderReceipt {
  const root = object(response);
  const order = object(root.order ?? response);
  const id = string(order.order_id), ticker = string(order.ticker);
  const bookSide = string(order.book_side), outcome = string(order.outcome_side);
  // book_side is what we sent (bid buys YES, ask buys NO exposure); outcome_side is the venue's exposure label.
  const side: BinarySide | null = bookSide === 'bid' ? 'up' : bookSide === 'ask' ? 'down' : outcome === 'yes' ? 'up' : outcome === 'no' ? 'down' : null;
  const filled = number(order.fill_count_fp);
  if (!id || !ticker || !side || filled === null || filled < 0) throw new Error('Order response does not yet confirm a matching order and fill count; reconcile using its order ID');
  if (ticker !== expected.ticker || side !== expected.side) throw new Error('Recovered order is for a different market or side');
  const initial = number(order.initial_count_fp);
  if (initial !== null && Math.abs(initial - expected.shares) > 1e-8 || filled > expected.shares + 1e-8) throw new Error('Recovered order differs from the prepared request');
  const yesLimit = number(order.yes_price_dollars), noLimit = number(order.no_price_dollars);
  const expectedYes = side === 'up' ? expected.limitPrice : round(1 - expected.limitPrice);
  if (yesLimit !== null && Math.abs(yesLimit - expectedYes) > 1e-6 || noLimit !== null && Math.abs(noLimit - round(1 - expectedYes)) > 1e-6) throw new Error('Recovered order differs from the prepared request');
  const cost = (number(order.taker_fill_cost_dollars) ?? 0) + (number(order.maker_fill_cost_dollars) ?? 0);
  const fees = (number(order.taker_fees_dollars) ?? 0) + (number(order.maker_fees_dollars) ?? 0);
  if (cost < 0 || fees < 0) throw new Error('Invalid negative fill accounting');
  let averagePrice: number | null = null;
  if (filled > 0) {
    averagePrice = round(cost / filled);
    // Kalshi reports the cost of the exposure actually bought. A NO fill costing more than its limit
    // would mean the venue reported YES-side cost; refuse to attribute rather than guess.
    if (averagePrice <= 0 || averagePrice >= 1 || averagePrice > expected.limitPrice + 1e-6) throw new Error('Filled order cost does not fit the prepared side/limit; reconcile the fill accounting manually');
  }
  return {
    id, marketSlug: ticker, side, filledShares: filled, averagePrice, feesUsd: round(fees),
    totalCostUsd: filled === 0 ? 0 : round(cost), status: string(order.status) || 'unknown',
    updatedAt: timestamp(order.last_update_time) ?? timestamp(order.created_time) ?? 0,
  };
}

/** Cost basis from the order's fills. Each fill carries both legs' prices, so the price
 * paid for this side is explicit; the order-level fill cost doesn't say which leg it's in. */
export function costFromFills(response: KalshiFillsResponse, orderId: string, expected: ExpectedOrder): { shares: number; averagePrice: number | null; costUsd: number; feesUsd: number } {
  const fills = array(response.fills).map(object).filter(f => f.order_id === orderId);
  if (response.cursor && fills.length === 0) throw new Error('Fills response is incomplete');
  let shares = 0, cost = 0, fees = 0;
  for (const f of fills) {
    const count = number(f.count_fp), yes = number(f.yes_price_dollars), no = number(f.no_price_dollars), fee = number(f.fee_cost) ?? 0;
    if (f.ticker !== undefined && f.ticker !== expected.ticker) throw new Error('Fill is for a different market');
    if (count === null || count <= 0 || yes === null || no === null || Math.abs(yes + no - 1) > 1e-6 || fee < 0) throw new Error('Invalid Kalshi fill record');
    if (f.outcome_side !== undefined && f.outcome_side !== (expected.side === 'up' ? 'yes' : 'no')) throw new Error('Fill is on the opposite side; manual reconciliation is required');
    shares += count; cost += count * (expected.side === 'up' ? yes : no); fees += fee;
  }
  const averagePrice = shares > 0 ? round(cost / shares) : null;
  if (averagePrice !== null && averagePrice > expected.limitPrice + 1e-6) throw new Error('Fills cost more than the prepared limit; reconcile manually');
  return { shares: round(shares), averagePrice, costUsd: round(cost), feesUsd: round(fees) };
}

/** Current holdings on this side. Positive position_fp is YES inventory, negative is NO. */
export function normalizePosition(response: KalshiPositionsResponse, ticker: string, side: BinarySide): { shares: number; averagePrice: null } {
  sideCheck(side);
  const positions = array(response.market_positions).map(object);
  const position = positions.find(p => p.ticker === ticker);
  if (!position) {
    if (response.cursor) throw new Error('Positions response is incomplete');
    return { shares: 0, averagePrice: null };
  }
  const net = number(position.position_fp);
  if (net === null) throw new Error('Position response has no valid quantity');
  if (net > 0 && side !== 'up' || net < 0 && side !== 'down') throw new Error('Current position is on the opposite side; manual reconciliation is required');
  return { shares: Math.abs(net), averagePrice: null };
}

/** Shares this account held when the venue settled the contract; null until a settlement record exists. */
export function normalizeSettlement(response: KalshiSettlementsResponse, ticker: string, side: BinarySide): { shares: number; result: 0 | 1 } | null {
  sideCheck(side);
  const records = array(response.settlements).map(object).filter(s => s.ticker === ticker);
  if (records.length === 0) {
    if (response.cursor) throw new Error('Settlements response is incomplete');
    return null;
  }
  if (records.length !== 1) throw new Error('Multiple settlement records for one contract; review the account before attributing P&L');
  const record = records[0]!;
  const yes = number(record.yes_count_fp) ?? 0, no = number(record.no_count_fp) ?? 0;
  const result = record.market_result === 'yes' ? 1 : record.market_result === 'no' ? 0 : null;
  if (result === null || yes < 0 || no < 0) throw new Error('Invalid settlement record');
  if (side === 'up' && no > 0 || side === 'down' && yes > 0) throw new Error('Settled holdings include the opposite side; manual reconciliation is required');
  return { shares: side === 'up' ? yes : no, result };
}

export function settlementFromMarket(raw: unknown): number | null {
  const market = object(object(raw).market ?? raw);
  if (!['determined', 'finalized', 'settled'].includes(string(market.status))) return null;
  const result = string(market.result);
  if (result !== 'yes' && result !== 'no') return null;
  const value = number(market.settlement_value_dollars);
  if (value !== null && value !== (result === 'yes' ? 1 : 0)) throw new Error('Unexpected Kalshi settlement value');
  return result === 'yes' ? 1 : 0;
}

/** Accepts the downloaded PEM (optionally with escaped newlines). RSA keys sign with PSS; Ed25519 keys sign directly. */
export function loadPrivateKey(pem: string): KeyObject {
  const text = pem.includes('\\n') && !pem.includes('\n') ? pem.replace(/\\n/g, '\n') : pem;
  if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) throw new Error('Kalshi private key must be a PEM private key');
  const key = createPrivateKey(text);
  if (key.asymmetricKeyType !== 'rsa' && key.asymmetricKeyType !== 'ed25519') throw new Error('Kalshi private key must be RSA or Ed25519');
  return key;
}

/** Signs `${timestampMs}${METHOD}${pathname}`; the pathname includes the /trade-api/v2 prefix and excludes the query string. */
export function createAuthHeaders(keyId: string, key: KeyObject, method: string, pathname: string, now = Date.now()): Record<string, string> {
  if (!/^[A-Za-z0-9-]{8,80}$/.test(keyId)) throw new Error('Invalid Kalshi API key ID');
  const time = String(now);
  const message = Buffer.from(`${time}${method.toUpperCase()}${pathname.split('?')[0]}`);
  const signature = key.asymmetricKeyType === 'rsa'
    ? sign('sha256', message, { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST })
    : sign(null, message, key);
  return { 'KALSHI-ACCESS-KEY': keyId, 'KALSHI-ACCESS-TIMESTAMP': time, 'KALSHI-ACCESS-SIGNATURE': signature.toString('base64') };
}

export class KalshiHttpError extends Error {
  constructor(public readonly status: number, method: string, path: string) {
    // Do not echo private payloads or headers into dashboards/logs.
    super(`Kalshi ${method} ${path} returned HTTP ${status}`);
    this.name = 'KalshiHttpError';
  }
}

export class KalshiClient {
  readonly venue: KalshiVenue;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly credentials?: { keyId: string; key: KeyObject };
  private fee?: Promise<number>;
  constructor(options: { venue?: KalshiVenue; keyId?: string; privateKey?: string | KeyObject; fetch?: typeof fetch; now?: () => number } = {}) {
    this.venue = options.venue ?? 'kalshi';
    if (!KALSHI_API[this.venue]) throw new Error('Unknown Kalshi venue');
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    // Deliberately never reads process.env. The dashboard uses a public client.
    if (options.keyId || options.privateKey) {
      if (!options.keyId || !options.privateKey) throw new Error('Both KALSHI_API_KEY_ID and a private key are required');
      this.credentials = { keyId: options.keyId, key: typeof options.privateKey === 'string' ? loadPrivateKey(options.privateKey) : options.privateKey };
    }
  }
  private async request<T>(method: 'GET' | 'POST', path: string, options: { authenticated?: boolean; query?: Record<string, string>; body?: unknown } = {}): Promise<T> {
    const url = new URL(`${KALSHI_API[this.venue]}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) url.searchParams.set(key, value);
    const headers: Record<string, string> = { Accept: 'application/json', 'Content-Type': 'application/json' };
    if (options.authenticated) {
      if (!this.credentials) throw new Error('Authenticated command requires KALSHI_API_KEY_ID and KALSHI_PRIVATE_KEY(_FILE)');
      Object.assign(headers, createAuthHeaders(this.credentials.keyId, this.credentials.key, method, url.pathname, this.now()));
    }
    // No automatic retries, especially for a submit with an ambiguous timeout.
    const response = await this.fetcher(url, { method, headers, redirect: 'error', body: options.body === undefined ? undefined : JSON.stringify(options.body), signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new KalshiHttpError(response.status, method, path);
    return await response.json() as T;
  }
  private feeCoefficient(): Promise<number> {
    this.fee ??= this.request<unknown>('GET', `/series/${KALSHI_SERIES}`).then(feeCoefficient).catch(err => { this.fee = undefined; throw err; });
    return this.fee;
  }
  async discoverHourlyBitcoin(options: DiscoveryOptions): Promise<BinaryMarket> {
    const targetEnd = options.targetEnd ?? options.episodeStart + HOUR;
    const [event, fee] = await Promise.all([
      this.request<unknown>('GET', `/events/${safeTicker(hourlyEventTicker(targetEnd))}`, { query: { with_nested_markets: 'true' } }),
      this.feeCoefficient(),
    ]);
    return selectHourlyStrike(event, { ...options, targetEnd, now: options.now ?? this.now(), venue: this.venue, feeCoefficient: fee });
  }
  async getMarket(ticker: string): Promise<JsonObject> {
    const response = await this.request<{ market?: unknown }>('GET', `/markets/${safeTicker(ticker)}`);
    const market = object(response.market);
    if (market.ticker !== ticker) throw new Error('Kalshi returned a different market');
    return market;
  }
  async refreshMarket(saved: BinaryMarket): Promise<BinaryMarket> {
    const [raw, fee] = await Promise.all([this.getMarket(saved.slug), this.feeCoefficient()]);
    const market = marketFromKalshi(raw, { venue: this.venue, eventTitle: saved.title.split(' · ').slice(1).join(' · ') || saved.eventSlug, feeCoefficient: fee });
    if (!market || market.eventSlug !== saved.eventSlug || market.endsAt !== saved.endsAt || market.priceToBeat !== saved.priceToBeat) throw new Error('Kalshi contract terms changed; review a new episode plan');
    return market;
  }
  async getQuote(ticker: string, side: BinarySide): Promise<BinaryQuote> {
    const [market, book] = await Promise.all([this.getMarket(ticker), this.request<unknown>('GET', `/markets/${safeTicker(ticker)}/orderbook`)]);
    return quoteFromBook(book, side, string(market.status), this.now());
  }
  async getSettlement(ticker: string): Promise<number | null> {
    return settlementFromMarket(await this.getMarket(ticker));
  }
  createOrder(order: KalshiOrderRequest): Promise<KalshiCreateOrderResponse> {
    return this.request('POST', '/portfolio/events/orders', { authenticated: true, body: order });
  }
  getOrder(id: string): Promise<KalshiOrderResponse> {
    return this.request('GET', `/portfolio/orders/${safeTicker(id)}`, { authenticated: true });
  }
  getPositions(ticker: string): Promise<KalshiPositionsResponse> {
    safeTicker(ticker);
    return this.request('GET', '/portfolio/positions', { authenticated: true, query: { ticker, limit: '100' } });
  }
  getFills(orderId: string): Promise<KalshiFillsResponse> {
    safeTicker(orderId);
    return this.request('GET', '/portfolio/fills', { authenticated: true, query: { order_id: orderId, limit: '200' } });
  }
  /** Orders in one market since a Unix-seconds timestamp (Kalshi can't filter by client order ID). */
  getOrders(ticker: string, sinceSeconds: number): Promise<KalshiOrdersResponse> {
    safeTicker(ticker);
    return this.request('GET', '/portfolio/orders', { authenticated: true, query: { ticker, min_ts: String(Math.floor(sinceSeconds)), limit: '200' } });
  }
  getSettlements(ticker: string): Promise<KalshiSettlementsResponse> {
    safeTicker(ticker);
    return this.request('GET', '/portfolio/settlements', { authenticated: true, query: { ticker, limit: '100' } });
  }
  marketUrl(market: BinaryMarket): string {
    return `https://kalshi.com/markets/${KALSHI_SERIES.toLowerCase()}/bitcoin-price-abovebelow/${encodeURIComponent(market.eventSlug.toLowerCase())}`;
  }
}
