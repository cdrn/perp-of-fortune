import { randomBytes } from "node:crypto";

/** Hyperliquid HIP-4 outcome markets: fully collateralised YES/NO tokens that
 * settle to 0 or 1 at expiry. Verified against mainnet 2026-10-08:
 * https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/asset-ids
 *   encoding = 10 * outcome + side (0 = YES, 1 = NO)
 *   "#<encoding>"  order book / order coin
 *   "+<encoding>"  spot balance coin (with entryNtl cost basis)
 *   100_000_000 + encoding  order asset id
 * Settlement needs no claim: the account gets a fill with dir "Settlement" at
 * px 1 or 0, and info {type:"settledOutcome"} returns the public settleFraction.
 * Sizes are whole tokens, prices have at most 5 decimals, $10 minimum notional.
 */
export type BinarySide = "up" | "down";
export const OUTCOME_ASSET_BASE = 100_000_000;
export const MIN_NOTIONAL_USD = 10;
const HOUR = 3_600_000;

export interface BinaryMarket {
  venue: "hyperliquid";
  outcome: number;
  title: string;
  underlying: "BTC";
  /** YES wins when the settlement price is at or above this. */
  threshold: number;
  endsAt: number;
  /** "hyperliquid" for the protocol's own recurring markets, else the HIP-4 deployer venue. */
  deployer: string;
  official: boolean;
  priceSource: string;
  rules: string;
  quoteToken: "USDC";
}
export interface BookLevel { price: number; size: number }
export interface BinaryQuote {
  buyPrice: number | null;
  sellPrice: number | null;
  /** Depth at the best ask/bid only. */
  availableShares: number;
  sellAvailableShares: number;
  asks: BookLevel[];
  bids: BookLevel[];
  updatedAt: number;
  status: "open" | "empty";
}
export interface OutcomeOrderAction {
  type: "order";
  orders: [{ a: number; b: true; p: string; s: string; r: false; t: { limit: { tif: "Ioc" | "Gtc" } }; c: string }];
  grouping: "na";
}
export type ExchangeResult =
  | { kind: "filled"; oid: number; filledShares: number; averagePrice: number }
  | { kind: "resting"; oid: number }
  | { kind: "unfilled"; message: string }
  | { kind: "rejected"; message: string };
export interface HLFill {
  coin: string; px: string; sz: string; side: string; time: number; dir: string;
  closedPnl?: string; oid: number; fee: string; feeToken?: string; cloid?: string | null;
}

type JsonObject = Record<string, unknown>;
const object = (value: unknown): JsonObject => value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const string = (value: unknown): string => typeof value === "string" ? value : "";
function number(value: unknown): number | null {
  if (typeof value !== "number" && (typeof value !== "string" || value.trim() === "")) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export const sideIndex = (side: BinarySide): 0 | 1 => side === "up" ? 0 : 1;
export const encoding = (outcome: number, side: BinarySide) => 10 * outcome + sideIndex(side);
export const bookCoin = (outcome: number, side: BinarySide) => `#${encoding(outcome, side)}`;
export const balanceCoin = (outcome: number, side: BinarySide) => `+${encoding(outcome, side)}`;
export const assetId = (outcome: number, side: BinarySide) => OUTCOME_ASSET_BASE + encoding(outcome, side);

/** "key:value|key:value"; values may themselves contain colons. */
export function parseDescription(description: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const part of description.split("|")) {
    const i = part.indexOf(":");
    if (i > 0) fields[part.slice(0, i)] = part.slice(i + 1);
  }
  return fields;
}
/** YYYYMMDD-HHMM in UTC. */
export function parseExpiry(value: string): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})$/.exec(value);
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  return Number.isFinite(t) ? t : null;
}

function marketFromOutcome(raw: unknown): BinaryMarket | null {
  const o = object(raw);
  const outcome = number(o.outcome), name = string(o.name), description = string(o.description);
  if (outcome === null || !Number.isInteger(outcome) || outcome < 0 || array(o.sideSpecs).length !== 2) return null;
  if (o.quoteToken !== undefined && o.quoteToken !== "USDC") return null;
  const f = parseDescription(description);
  let threshold: number | null, endsAt: number | null, priceSource: string;
  if (name === "Recurring" && f.class === "priceBinary" && f.underlying === "BTC") {
    threshold = number(f.targetPrice); endsAt = parseExpiry(f.expiry ?? "");
    priceSource = "the Hyperliquid BTC perp mark price";
  } else if (name === "template:binaryPrice" && f.perp === "BTC") {
    threshold = number(f.threshold); endsAt = parseExpiry(f.time ?? "");
    priceSource = f.priceDescription || "BTC price";
  } else return null;
  if (threshold === null || threshold <= 0 || endsAt === null) return null;
  const venue = string(o.venue);
  const deployer = venue || "hyperliquid";
  const at = new Date(endsAt).toISOString().slice(11, 16);
  return {
    venue: "hyperliquid", outcome, underlying: "BTC", threshold, endsAt, deployer, official: !venue, priceSource,
    title: `BTC at or above $${threshold.toLocaleString("en-US")} at ${at} UTC`, rules: description, quoteToken: "USDC",
  };
}

/** Every BTC price binary expiring exactly at the episode cutoff. Titles are not
 * trusted; only the typed template fields are. */
export function btcBinariesAt(meta: unknown, endsAt: number): BinaryMarket[] {
  const markets = array(object(meta).outcomes).map(marketFromOutcome)
    .filter((m): m is BinaryMarket => m !== null && m.endsAt === endsAt);
  return [...new Map(markets.map((m) => [m.outcome, m])).values()];
}

export function quoteFromBook(response: unknown, now = Date.now()): BinaryQuote {
  const book = object(response);
  const levels = array(book.levels);
  if (levels.length !== 2) throw new Error("Outcome order book is unavailable (unlisted or already settled)");
  const parse = (raw: unknown, ascending: boolean) => array(raw).map(object)
    .map((l) => ({ price: number(l.px), size: number(l.sz) }))
    .filter((l): l is BookLevel => l.price !== null && l.price > 0 && l.price < 1 && l.size !== null && l.size > 0)
    .sort((a, b) => ascending ? a.price - b.price : b.price - a.price);
  const bids = parse(levels[0], false), asks = parse(levels[1], true);
  if (bids[0] && asks[0] && bids[0].price >= asks[0].price) throw new Error("Outcome order book is crossed");
  const at = (side: BookLevel[]) => side[0] ? side.filter((l) => l.price === side[0]!.price).reduce((s, l) => s + l.size, 0) : 0;
  return {
    buyPrice: asks[0]?.price ?? null, sellPrice: bids[0]?.price ?? null,
    availableShares: at(asks), sellAvailableShares: at(bids), asks, bids,
    updatedAt: number(book.time) ?? now, status: asks.length || bids.length ? "open" : "empty",
  };
}

/** Shares purchasable at or below the limit, walking the asks. */
export function depthWithin(asks: BookLevel[], limit: number): number {
  return asks.filter((l) => l.price <= limit + 1e-12).reduce((s, l) => s + l.size, 0);
}
/** Proceeds from selling `shares` into the bids now; null if the book can't absorb it. */
export function exitValue(bids: BookLevel[], shares: number): number | null {
  let left = shares, value = 0;
  for (const l of bids) {
    const take = Math.min(left, l.size);
    value += take * l.price; left -= take;
    if (left <= 1e-9) return Math.round(value * 1e8) / 1e8;
  }
  return null;
}

export function formatOutcomePrice(price: number): string {
  if (!Number.isFinite(price) || price <= 0 || price >= 1) throw new Error("Outcome price must be between 0 and 1");
  const fixed = Number(price.toFixed(5));
  if (Math.abs(fixed - price) > 1e-12) throw new Error("Outcome price allows at most 5 decimals");
  return String(fixed);
}
export function newCloid(): string { return `0x${randomBytes(16).toString("hex")}`; }

/** IOC takes what's on the book; GTC rests a bid when nobody is offering. */
export function buildBuyAction(input: { outcome: number; side: BinarySide; shares: number; limitPrice: number; cloid: string; tif?: "Ioc" | "Gtc" }): OutcomeOrderAction {
  if (!Number.isInteger(input.outcome) || input.outcome < 0) throw new Error("Invalid outcome id");
  if (input.side !== "up" && input.side !== "down") throw new Error("Binary side must be up or down");
  if (!Number.isInteger(input.shares) || input.shares < 1) throw new Error("Outcome size must be a whole number of shares");
  if (!/^0x[0-9a-f]{32}$/.test(input.cloid)) throw new Error("Invalid client order id");
  // Key order matters: the action is msgpack-hashed for the signature.
  return {
    type: "order",
    orders: [{ a: assetId(input.outcome, input.side), b: true, p: formatOutcomePrice(input.limitPrice), s: String(input.shares), r: false, t: { limit: { tif: input.tif ?? "Ioc" } }, c: input.cloid }],
    grouping: "na",
  };
}

/** Interprets a 2xx /exchange body. A non-2xx never reaches here. */
export function parseExchangeResult(body: unknown): ExchangeResult {
  const root = object(body);
  if (root.status === "err") return { kind: "rejected", message: string(root.response) || "Order rejected" };
  const status = object(array(object(object(root.response).data).statuses)[0]);
  const filled = object(status.filled), resting = object(status.resting);
  if (Object.keys(filled).length) {
    const oid = number(filled.oid), filledShares = number(filled.totalSz), averagePrice = number(filled.avgPx);
    if (oid === null || filledShares === null || averagePrice === null) throw new Error("Fill response is missing its order id, size or price");
    return { kind: "filled", oid, filledShares, averagePrice };
  }
  if (Object.keys(resting).length && number(resting.oid) !== null) return { kind: "resting", oid: number(resting.oid)! };
  if (typeof status.error === "string") {
    // An IOC that found nothing to match is over, not rejected.
    return /could not immediately match/i.test(status.error) ? { kind: "unfilled", message: status.error } : { kind: "rejected", message: status.error };
  }
  throw new Error("Unrecognised order response");
}

/** Buys of this coin by order id: total shares, average price and fees. */
export function summariseFills(fills: HLFill[], coin: string, oid: number) {
  const mine = fills.filter((f) => f.coin === coin && f.oid === oid && f.dir !== "Settlement");
  const shares = mine.reduce((s, f) => s + Number(f.sz), 0);
  const cost = mine.reduce((s, f) => s + Number(f.sz) * Number(f.px), 0);
  const fees = mine.reduce((s, f) => s + Number(f.fee), 0);
  return { shares, averagePrice: shares > 0 ? Math.round(cost / shares * 1e8) / 1e8 : null, costUsd: Math.round(cost * 1e8) / 1e8, feesUsd: Math.round(fees * 1e8) / 1e8, count: mine.length };
}
/** The account's own settlement record for this coin: shares settled, gross payout, fee. */
export function settlementFromFills(fills: HLFill[], coin: string) {
  const s = fills.filter((f) => f.coin === coin && f.dir === "Settlement");
  if (!s.length) return null;
  const shares = s.reduce((t, f) => t + Number(f.sz), 0);
  const gross = s.reduce((t, f) => t + Number(f.sz) * Number(f.px), 0);
  const fees = s.reduce((t, f) => t + Number(f.fee), 0);
  return { shares, price: Number(s[0]!.px), payoutUsd: Math.round((gross - fees) * 1e8) / 1e8, feesUsd: fees, time: Math.max(...s.map((f) => f.time)) };
}

export const apiFor = (network: "mainnet" | "testnet") => network === "mainnet" ? "https://api.hyperliquid.xyz" : "https://api.hyperliquid-testnet.xyz";

/** Public, keyless reads. Everything about an account on Hyperliquid is public by address. */
export class HLOutcomeClient {
  constructor(private readonly api: string, private readonly fetcher: typeof fetch = fetch) {}
  private async info<T>(body: unknown): Promise<T> {
    const res = await this.fetcher(`${this.api}/info`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`hyperliquid /info ${res.status}`);
    return await res.json() as T;
  }
  async binariesAt(endsAt: number): Promise<BinaryMarket[]> { return btcBinariesAt(await this.info({ type: "outcomeMeta" }), endsAt); }
  async getQuote(outcome: number, side: BinarySide): Promise<BinaryQuote> {
    return quoteFromBook(await this.info({ type: "l2Book", coin: bookCoin(outcome, side) }));
  }
  /** settleFraction for YES (1 = YES won, 0 = NO won), or null before settlement. */
  async getSettlement(outcome: number): Promise<number | null> {
    const r = object(await this.info<unknown>({ type: "settledOutcome", outcome }));
    if (!Object.keys(r).length) return null;
    if (number(object(r.spec).outcome) !== outcome) throw new Error("Hyperliquid returned a different settled outcome");
    const f = number(r.settleFraction);
    if (f === null || f < 0 || f > 1) throw new Error("Unexpected settlement fraction");
    return f;
  }
  async spotBalances(user: string): Promise<Map<string, { total: number; hold: number; entryNtl: number }>> {
    const r = object(await this.info({ type: "spotClearinghouseState", user }));
    const out = new Map<string, { total: number; hold: number; entryNtl: number }>();
    for (const b of array(r.balances).map(object)) {
      out.set(string(b.coin), { total: number(b.total) ?? 0, hold: number(b.hold) ?? 0, entryNtl: number(b.entryNtl) ?? 0 });
    }
    return out;
  }
  async holdings(user: string, outcome: number, side: BinarySide): Promise<number> {
    return (await this.spotBalances(user)).get(balanceCoin(outcome, side))?.total ?? 0;
  }
  async orderStatus(user: string, cloid: string): Promise<JsonObject | null> {
    const r = object(await this.info({ type: "orderStatus", user, oid: cloid }));
    if (r.status === "unknownOid") return null;
    if (r.status !== "order") throw new Error("Unexpected order status response");
    return object(r.order);
  }
  fills(user: string, startTime: number): Promise<HLFill[]> {
    return this.info<HLFill[]>({ type: "userFillsByTime", user, startTime, aggregateByTime: false });
  }
}

export { HOUR };
