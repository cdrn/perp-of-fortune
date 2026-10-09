import { createPrivateKey, sign } from 'node:crypto';

/** Retail API, not the international Polymarket CLOB. Sources verified 2026-10-01:
 * https://docs.polymarket.us/api-reference/authentication
 * https://docs.polymarket.us/concepts/orders (all order prices are YES prices)
 * https://docs.polymarket.us/api-reference/markets/get-market-by-slug
 * https://docs.polymarket.us/trader-guide/crypto-schema
 */
export type BinarySide = 'up' | 'down';
export interface BinaryMarket {
  venue: 'polymarket-us';
  slug: string;
  eventSlug: string;
  title: string;
  startsAt: number;
  endsAt: number;
  /** Exchange expiry; this is not a guarantee that funds settle at this time. */
  settlementAt: number | null;
  rules: string;
  status: string;
  priceTick: number;
  minimumShares: number;
  feeCoefficient: number | null;
  priceToBeat: number | null;
}
export interface BinaryQuote {
  buyPrice: number | null;
  sellPrice: number | null;
  /** Depth at the quoted best price, not total depth across worse prices. */
  availableShares: number;
  sellAvailableShares: number;
  updatedAt: number;
  status: string;
}
export interface PMAmount { value: string; currency: string }
export interface PMOrder {
  id?: string;
  marketSlug?: string;
  intent?: string;
  outcomeSide?: string;
  action?: string;
  state?: string;
  quantity?: number;
  cumQuantity?: number;
  leavesQuantity?: number;
  price?: PMAmount;
  avgPx?: PMAmount;
  commissionNotionalTotalCollected?: PMAmount;
  commissionsBasisPoints?: string;
  insertTime?: string;
  createTime?: string;
}
export interface PMOrderResponse { order: PMOrder }
export interface PMExecution {
  id?: string;
  order?: PMOrder;
  lastShares?: string;
  lastPx?: PMAmount;
  type?: string;
  transactTime?: string;
  commissionNotionalCollected?: PMAmount;
}
export interface PMCreateOrderResponse { id: string; executions?: PMExecution[] }
export interface BinaryOrderReceipt {
  id: string;
  marketSlug: string;
  side: BinarySide;
  filledShares: number;
  averagePrice: number | null;
  /** Filled contract principal only. Entry fees are separately reported. */
  totalCostUsd: number | null;
  feesUsd: number | null;
  status: string;
  updatedAt: number;
}
export interface BuyOrder {
  marketSlug: string;
  intent: 'ORDER_INTENT_BUY_LONG' | 'ORDER_INTENT_BUY_SHORT';
  type: 'ORDER_TYPE_LIMIT';
  price: PMAmount;
  quantity: number;
  tif: 'TIME_IN_FORCE_IMMEDIATE_OR_CANCEL';
  manualOrderIndicator: 'MANUAL_ORDER_INDICATOR_AUTOMATIC';
  synchronousExecution: true;
  maxBlockTime: '5';
}
export interface DiscoveryOptions {
  episodeStart: number;
  targetEnd?: number;
  now?: number;
  minRemainingMs?: number;
  /** Planning only. Trading must still check the live book is OPEN. */
  allowUpcoming?: boolean;
}
export interface PMPosition {
  netPosition?: string;
  netPositionDecimal?: string;
  expired?: boolean;
  cost?: PMAmount;
  realized?: PMAmount;
  cashValue?: PMAmount;
  updateTime?: string;
}
export interface PMPositionsResponse {
  positions: Record<string, PMPosition>;
  nextCursor?: string;
  eof?: boolean;
}
export interface PMActivity {
  type?: string;
  trade?: {
    id?: string; marketSlug?: string; state?: string; createTime?: string;
    updateTime?: string; price?: PMAmount; qty?: string; qtyDecimal?: string;
    costBasis?: PMAmount; realizedPnl?: PMAmount;
  };
  positionResolution?: {
    marketSlug?: string; beforePosition?: PMPosition; afterPosition?: PMPosition;
    updateTime?: string; tradeId?: string; side?: string;
  };
}
export interface PMActivitiesResponse { activities: PMActivity[]; nextCursor?: string; eof?: boolean }
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
function amount(value: unknown): number | null {
  const a = object(value);
  return a.currency === 'USD' ? number(a.value) : null;
}
function timestamp(value: unknown): number | null {
  const t = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(t) ? t : null;
}
function cents(value: number): number { return Math.round(value * 1e8) / 1e8; }
function sideCheck(side: BinarySide): void {
  if (side !== 'up' && side !== 'down') throw new Error('Binary side must be up or down');
}
function safeIdentifier(value: string): string {
  if (!/^[a-zA-Z0-9_-]{1,200}$/.test(value)) throw new Error('Invalid Polymarket US identifier');
  return encodeURIComponent(value);
}

/** Strict typed-term validation. Titles and slug naming are not authoritative. */
export function selectHourlyBitcoin(events: unknown[], options: DiscoveryOptions): BinaryMarket {
  const now = options.now ?? Date.now();
  const minRemainingMs = options.minRemainingMs ?? 45 * 60 * 1000;
  if (!Number.isFinite(options.episodeStart) || !Number.isFinite(now)
    || !Number.isFinite(minRemainingMs) || minRemainingMs < 0 || minRemainingMs > HOUR
    || (options.targetEnd !== undefined && (!Number.isFinite(options.targetEnd) || options.targetEnd <= options.episodeStart))) {
    throw new Error('Invalid episode window');
  }
  const matches: BinaryMarket[] = [];
  for (const rawEvent of events) {
    const event = object(rawEvent);
    if (event.active !== true || event.archived === true || event.ended === true) continue;
    for (const rawMarket of array(event.markets)) {
      const market = object(rawMarket);
      const terms = object(market.assetPriceTerms);
      const asset = object(terms.asset);
      if (terms.marketType !== 'ASSET_PRICE_MARKET_TYPE_UP_DOWN' || asset.assetClass !== 'ASSET_CLASS_CRYPTO'
        || string(asset.symbol).toLowerCase() !== 'btc' || terms.horizon !== '1h') continue;
      const startsAt = timestamp(terms.windowStart);
      const endsAt = timestamp(terms.windowEnd);
      if (startsAt === null || endsAt === null || endsAt - startsAt !== HOUR) continue;
      if (timestamp(event.startDate) !== startsAt || timestamp(event.endDate) !== endsAt) continue;
      if (endsAt <= now || startsAt > options.episodeStart || options.episodeStart >= endsAt) continue;
      if (endsAt - Math.max(now, options.episodeStart) < minRemainingMs) continue;
      if (options.targetEnd !== undefined && endsAt !== options.targetEnd) continue;
      const status = string(market.status);
      const upcoming = options.allowUpcoming === true && startsAt > now
        && ['MARKET_STATUS_CLOSED', 'MARKET_STATUS_UNSPECIFIED'].includes(status);
      if (market.active !== true || market.archived === true || !upcoming &&
        (event.closed === true || market.closed === true || status !== 'MARKET_STATUS_OPEN')) continue;
      const slug = string(market.slug), eventSlug = string(event.slug), rules = string(market.description);
      const priceTick = number(market.orderPriceMinTickSize), minimumShares = number(market.minimumTradeQty);
      if (!slug || !eventSlug || !rules || priceTick === null || priceTick <= 0 || priceTick >= 1
        || minimumShares === null || minimumShares <= 0) continue;
      matches.push({
        venue: 'polymarket-us', slug, eventSlug, title: string(market.question) || string(event.title),
        startsAt, endsAt, settlementAt: timestamp(market.endDate), rules, status, priceTick, minimumShares,
        feeCoefficient: number(market.feeCoefficient), priceToBeat: amount(terms.priceToBeat),
      });
    }
  }
  const unique = [...new Map(matches.map(m => [m.slug, m])).values()];
  if (unique.length === 0) throw new Error('No eligible one-hour Bitcoin up/down market matches the episode window. Start near the hour or specify a matching episode start/end; closed, short-remaining and other markets are excluded.');
  if (unique.length !== 1) throw new Error('Multiple Bitcoin hourly markets match; refusing ambiguous selection');
  return unique[0]!;
}

export function quoteFromBook(response: unknown, side: BinarySide): BinaryQuote {
  sideCheck(side);
  const data = object(object(response).marketData);
  const updatedAt = timestamp(data.transactTime);
  if (updatedAt === null) throw new Error('Polymarket US book has no valid exchange timestamp');
  const status = string(data.state);
  const levels = (raw: unknown, ascending: boolean) => array(raw).map(object).map(level => ({
    price: amount(level.px), size: number(level.qty),
  })).filter((level): level is { price: number; size: number } => level.price !== null
    && level.price > 0 && level.price < 1 && level.size !== null && level.size > 0)
    .sort((a, b) => ascending ? a.price - b.price : b.price - a.price);
  const bids = levels(data.bids, false), offers = levels(data.offers, true);
  if (bids[0] && offers[0] && bids[0].price >= offers[0].price) throw new Error('Polymarket US returned a crossed order book');
  const buyLevels = side === 'up' ? offers : bids;
  const sellLevels = side === 'up' ? bids : offers;
  const buy = buyLevels[0], sell = sellLevels[0];
  const open = status === 'MARKET_STATE_OPEN';
  return {
    buyPrice: open && buy ? (side === 'up' ? buy.price : cents(1 - buy.price)) : null,
    sellPrice: open && sell ? (side === 'up' ? sell.price : cents(1 - sell.price)) : null,
    availableShares: open && buy ? buyLevels.filter(x => x.price === buy.price).reduce((sum, x) => sum + x.size, 0) : 0,
    sellAvailableShares: open && sell ? sellLevels.filter(x => x.price === sell.price).reduce((sum, x) => sum + x.size, 0) : 0,
    updatedAt, status,
  };
}

export function buildBuyOrder(input: { marketSlug: string; side: BinarySide; shares: number; maxPrice: number; priceTick?: number; minimumShares?: number }): BuyOrder {
  safeIdentifier(input.marketSlug);
  sideCheck(input.side);
  const tick = input.priceTick ?? 0.01, minimum = input.minimumShares ?? 1;
  if (!Number.isFinite(input.shares) || input.shares <= 0 || !Number.isFinite(minimum) || minimum <= 0
    || Math.abs(input.shares / minimum - Math.round(input.shares / minimum)) > 1e-7) throw new Error('Shares must be a positive multiple of the market minimum quantity');
  if (!Number.isFinite(input.maxPrice) || input.maxPrice <= 0 || input.maxPrice >= 1
    || !Number.isFinite(tick) || tick <= 0 || tick >= 1) throw new Error('Invalid binary limit price');
  const yesPrice = input.side === 'up' ? input.maxPrice : cents(1 - input.maxPrice);
  if (Math.abs(yesPrice / tick - Math.round(yesPrice / tick)) > 1e-7) throw new Error('Binary limit price must match the market tick size');
  return {
    marketSlug: input.marketSlug, intent: input.side === 'up' ? 'ORDER_INTENT_BUY_LONG' : 'ORDER_INTENT_BUY_SHORT',
    type: 'ORDER_TYPE_LIMIT', price: { value: String(yesPrice), currency: 'USD' }, quantity: input.shares,
    tif: 'TIME_IN_FORCE_IMMEDIATE_OR_CANCEL', manualOrderIndicator: 'MANUAL_ORDER_INDICATOR_AUTOMATIC',
    synchronousExecution: true, maxBlockTime: '5',
  };
}

/** Never treats a merely accepted order ID as a filled position. */
export function normalizeOrder(response: PMOrderResponse | PMCreateOrderResponse | PMOrder, expectedSide?: BinarySide): BinaryOrderReceipt {
  const root = object(response);
  let order = object(root.order ?? response);
  let executionTime: number | null = null;
  if (Array.isArray(root.executions)) {
    const executions = root.executions.map(object);
    const lastWithOrder = executions.filter(e => Object.keys(object(e.order)).length > 0).at(-1);
    if (lastWithOrder) order = object(lastWithOrder.order);
    executionTime = timestamp(executions.at(-1)?.transactTime);
  }
  const intent = string(order.intent);
  const side: BinarySide | null = intent === 'ORDER_INTENT_BUY_LONG' ? 'up'
    : intent === 'ORDER_INTENT_BUY_SHORT' ? 'down'
      : order.action === 'ORDER_ACTION_BUY' && order.outcomeSide === 'OUTCOME_SIDE_YES' ? 'up'
        : order.action === 'ORDER_ACTION_BUY' && order.outcomeSide === 'OUTCOME_SIDE_NO' ? 'down' : null;
  const filledShares = number(order.cumQuantity);
  const id = string(order.id) || string(root.id), marketSlug = string(order.marketSlug);
  if (!side || expectedSide && side !== expectedSide || !id || !marketSlug || filledShares === null || filledShares < 0) {
    throw new Error('Order response does not yet confirm a matching buy order and cumulative fill quantity; reconcile using its order ID');
  }
  if (order.action && order.action !== 'ORDER_ACTION_BUY'
    || order.outcomeSide && order.outcomeSide !== (side === 'up' ? 'OUTCOME_SIDE_YES' : 'OUTCOME_SIDE_NO')) {
    throw new Error('Order response has conflicting outcome side or action');
  }
  const yesAverage = amount(order.avgPx);
  if (filledShares > 0 && (yesAverage === null || yesAverage <= 0 || yesAverage >= 1)) {
    throw new Error('Filled order has no valid average fill price; reconcile using its order ID');
  }
  const averagePrice = filledShares === 0 || yesAverage === null ? null : side === 'up' ? yesAverage : cents(1 - yesAverage);
  const feesUsd = amount(order.commissionNotionalTotalCollected);
  if (feesUsd !== null && feesUsd < 0) throw new Error('Invalid negative entry commission');
  return {
    id, marketSlug, side, filledShares, averagePrice, feesUsd,
    totalCostUsd: filledShares === 0 ? 0 : averagePrice === null ? null : cents(filledShares * averagePrice),
    status: string(order.state) || 'ORDER_STATE_UNKNOWN',
    updatedAt: executionTime ?? timestamp(order.insertTime) ?? timestamp(order.createTime) ?? 0,
  };
}

/** Current holdings, independent of the original fill. Never attributes unrelated opposite positions. */
export function normalizePosition(response: PMPositionsResponse, marketSlug: string, side: BinarySide): { shares: number; averagePrice: null } {
  sideCheck(side);
  if (!response.positions || typeof response.positions !== 'object' || Array.isArray(response.positions)) throw new Error('Invalid positions response');
  const position = response.positions[marketSlug];
  if (!position) {
    if (response.nextCursor && response.eof !== true) throw new Error('Positions response is incomplete');
    return { shares: 0, averagePrice: null };
  }
  const net = number(position.netPositionDecimal ?? position.netPosition);
  if (net === null) throw new Error('Position response has no valid quantity');
  if (net > 0 && side !== 'up' || net < 0 && side !== 'down') throw new Error('Current position is on the opposite side; manual reconciliation is required');
  // API cost accounting for short inventory differs from paid NO collateral;
  // entry average comes from the matched order, not an inferred position cost.
  return { shares: Math.abs(net), averagePrice: null };
}

/** The SDK signs the pathname only, excluding query and body. 32/64-byte secrets accepted. */
export function createAuthHeaders(keyId: string, secretKey: string, method: string, path: string, now = Date.now()): Record<string, string> {
  if (!keyId || !/^[A-Za-z0-9+/]+={0,2}$/.test(secretKey)) throw new Error('Invalid Polymarket US API credentials');
  const raw = Buffer.from(secretKey, 'base64');
  if (raw.length !== 32 && raw.length !== 64) throw new Error('Polymarket US secret key must decode to a 32-byte seed or 64-byte key');
  const seed = raw.subarray(0, 32);
  const key = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
  const time = String(now);
  return {
    'X-PM-Access-Key': keyId, 'X-PM-Timestamp': time,
    'X-PM-Signature': sign(null, Buffer.from(`${time}${method.toUpperCase()}${path.split('?')[0]}`), key).toString('base64'),
  };
}

export class PolymarketUSHttpError extends Error {
  constructor(public readonly status: number, method: string, path: string) {
    // Do not echo private provider payloads or headers into dashboards/logs.
    super(`Polymarket US ${method} ${path} returned HTTP ${status}`);
    this.name = 'PolymarketUSHttpError';
  }
}
export class PolymarketUSClient {
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly credentials?: { keyId: string; secretKey: string };
  constructor(options: { keyId?: string; secretKey?: string; fetch?: typeof fetch; now?: () => number } = {}) {
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    // Deliberately never reads process.env. The dashboard uses a public client.
    if (options.keyId || options.secretKey) {
      if (!options.keyId || !options.secretKey) throw new Error('Both PM_US_API_KEY and PM_US_SECRET_KEY are required');
      this.credentials = { keyId: options.keyId, secretKey: options.secretKey };
    }
  }
  private async request<T>(method: 'GET' | 'POST', path: string, options: { authenticated?: boolean; query?: Record<string, string>; body?: unknown } = {}): Promise<T> {
    const url = new URL(path, options.authenticated ? 'https://api.polymarket.us' : 'https://gateway.polymarket.us');
    for (const [key, value] of Object.entries(options.query ?? {})) url.searchParams.set(key, value);
    const headers: Record<string, string> = { Accept: 'application/json', 'Content-Type': 'application/json' };
    if (options.authenticated) {
      if (!this.credentials) throw new Error('Authenticated command requires PM_US_API_KEY and PM_US_SECRET_KEY');
      Object.assign(headers, createAuthHeaders(this.credentials.keyId, this.credentials.secretKey, method, url.pathname, this.now()));
    }
    // No automatic retries, especially for a submit with an ambiguous timeout.
    const response = await this.fetcher(url, { method, headers, redirect: 'error', body: options.body === undefined ? undefined : JSON.stringify(options.body), signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new PolymarketUSHttpError(response.status, method, path);
    return await response.json() as T;
  }
  async discoverHourlyBitcoin(options: DiscoveryOptions): Promise<BinaryMarket> {
    const from = Math.floor(options.episodeStart / HOUR) * HOUR;
    if (!Number.isFinite(from)) throw new Error('Invalid episode start');
    const response = await this.request<{ events?: unknown[] }>('GET', '/v1/search', { query: {
      query: 'bitcoin', limit: '100', startTimeMin: new Date(from).toISOString(), startTimeMax: new Date(options.episodeStart).toISOString(),
      // Public search defaults to live listings; scheduled BTC windows are
      // marked closed until shortly before the hour and need status=all.
      ...(options.allowUpcoming ? { status: 'all' } : {}),
    } });
    return selectHourlyBitcoin(response.events ?? [], { ...options, now: options.now ?? this.now() });
  }
  async getMarket(slug: string): Promise<JsonObject> {
    const response = await this.request<{ market?: unknown }>('GET', `/v1/market/slug/${safeIdentifier(slug)}`);
    const market = object(response.market);
    if (market.slug !== slug) throw new Error('Polymarket US returned a different market');
    return market;
  }
  async getQuote(slug: string, side: BinarySide): Promise<BinaryQuote> {
    const response = await this.request<unknown>('GET', `/v1/markets/${safeIdentifier(slug)}/book`);
    if (object(object(response).marketData).marketSlug !== slug) throw new Error('Polymarket US returned a different order book');
    return quoteFromBook(response, side);
  }
  async getSettlement(slug: string): Promise<number | null> {
    const market = await this.getMarket(slug);
    if (market.status !== 'MARKET_STATUS_RESOLVED') return null;
    try {
      const response = await this.request<{ slug?: string; settlement?: unknown }>('GET', `/v1/markets/${safeIdentifier(slug)}/settlement`);
      if (response.slug !== slug || response.settlement === undefined) throw new Error('Invalid Polymarket US settlement response');
      const payout = number(response.settlement);
      if (payout !== 0 && payout !== 1) throw new Error('Unexpected hourly Bitcoin settlement payout');
      return payout;
    } catch (error) {
      if (error instanceof PolymarketUSHttpError && error.status === 404) return null;
      throw error;
    }
  }
  buildBuyOrder(input: Parameters<typeof buildBuyOrder>[0]): BuyOrder { return buildBuyOrder(input); }
  previewOrder(order: BuyOrder): Promise<PMOrderResponse> {
    return this.request('POST', '/v1/order/preview', { authenticated: true, body: { request: order } });
  }
  createOrder(order: BuyOrder): Promise<PMCreateOrderResponse> {
    return this.request('POST', '/v1/orders', { authenticated: true, body: order });
  }
  getOrder(id: string): Promise<PMOrderResponse> {
    return this.request('GET', `/v1/order/${safeIdentifier(id)}`, { authenticated: true });
  }
  getPositions(slug: string): Promise<PMPositionsResponse> {
    safeIdentifier(slug);
    return this.request('GET', '/v1/portfolio/positions', { authenticated: true, query: { market: slug, limit: '100' } });
  }
  getActivities(slug: string, cursor?: string): Promise<PMActivitiesResponse> {
    safeIdentifier(slug);
    return this.request('GET', '/v1/portfolio/activities', { authenticated: true, query: {
      marketSlug: slug, limit: '100', sortOrder: 'SORT_ORDER_DESCENDING', ...(cursor ? { cursor } : {}),
    } });
  }
}
