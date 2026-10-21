// Venue-neutral binary contract types shared by the operator CLI, the read-only
// tracker and every venue client. Nothing here touches the network or keys.
export type BinarySide = 'up' | 'down';
export type BinaryVenueId = 'polymarket-us' | 'kalshi' | 'kalshi-demo';
export const BINARY_VENUES: readonly BinaryVenueId[] = ['polymarket-us', 'kalshi', 'kalshi-demo'];
export function isBinaryVenue(value: unknown): value is BinaryVenueId {
  return typeof value === 'string' && (BINARY_VENUES as readonly string[]).includes(value);
}

export interface BinaryMarket {
  venue: BinaryVenueId;
  /** Venue market identifier: Polymarket US slug or Kalshi market ticker. */
  slug: string;
  /** Venue event identifier: Polymarket US event slug or Kalshi event ticker (one per hour). */
  eventSlug: string;
  title: string;
  /** Episode hour. Kalshi lists hourly contracts earlier; this remains the measured hour. */
  startsAt: number;
  endsAt: number;
  /** Exchange expiry; this is not a guarantee that funds settle at this time. */
  settlementAt: number | null;
  rules: string;
  status: string;
  priceTick: number;
  minimumShares: number;
  /** Fee curve coefficient: entry fee per share is at most coefficient / 4. */
  feeCoefficient: number | null;
  /** Polymarket US opening reference price, or the Kalshi strike the hour must finish above. */
  priceToBeat: number | null;
}

export interface BinaryQuote {
  /** True only when the venue reports the book tradeable right now. */
  open: boolean;
  buyPrice: number | null;
  sellPrice: number | null;
  /** Depth at the quoted best price, not total depth across worse prices. */
  availableShares: number;
  sellAvailableShares: number;
  updatedAt: number;
  status: string;
}

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

export interface DiscoveryOptions {
  episodeStart: number;
  targetEnd?: number;
  now?: number;
  minRemainingMs?: number;
  /** Planning only. Trading must still check the live book is OPEN. */
  allowUpcoming?: boolean;
  /** Kalshi strike ladders pick the strike quoted nearest 50 cents for this side. */
  side?: BinarySide;
}

/** Public, read-only market data. Safe for the dashboard process; never holds credentials. */
export interface BinaryMarketData {
  readonly venue: BinaryVenueId;
  readonly label: string;
  marketUrl(market: BinaryMarket): string;
  discoverHourlyBitcoin(options: DiscoveryOptions): Promise<BinaryMarket>;
  /** Re-reads the exact saved contract (same slug) with current status/terms. */
  refreshMarket(market: BinaryMarket): Promise<BinaryMarket>;
  getQuote(slug: string, side: BinarySide): Promise<BinaryQuote>;
  /** YES contract value once the venue has finalized the result; null while pending. */
  getSettlement(slug: string): Promise<number | null>;
}

export interface PreparedBinaryOrder {
  venue: BinaryVenueId;
  marketSlug: string;
  side: BinarySide;
  shares: number;
  limitPrice: number;
  /** Principal at the limit plus the worst-case entry fee; never above the budget. */
  maximumCostUsd: number;
}

/** Authenticated account operations. Only the operator process constructs one. */
export interface BinaryOperator {
  readonly venue: BinaryVenueId;
  /** Shares currently held on this side; throws when the account is on the opposite side. */
  getHoldings(market: BinaryMarket, side: BinarySide): Promise<number>;
  /** Builds, bounds and (where the venue offers it) previews the order; places nothing. */
  prepareOrder(market: BinaryMarket, side: BinarySide, shares: number, limitPrice: number, budgetUsd: number): Promise<PreparedBinaryOrder>;
  /** Submits exactly one IOC limit order and returns the venue order ID. */
  submitOrder(prepared: PreparedBinaryOrder, clientOrderId: string): Promise<string>;
  /** Fetches the order and checks it matches the prepared side, size and limit. */
  getReceipt(orderId: string, prepared: PreparedBinaryOrder): Promise<BinaryOrderReceipt>;
  /** Shares the account held at settlement per its own records; null until recorded. */
  getSettledHoldings(market: BinaryMarket, side: BinarySide): Promise<number | null>;
}
