// Venue registry. The dashboard only ever calls binaryMarketData(); only the
// operator CLI calls binaryOperator(), which is the sole reader of credentials.
import { readFileSync } from 'node:fs';
import type { BinaryMarket, BinaryMarketData, BinaryOperator, BinarySide, BinaryVenueId, PreparedBinaryOrder } from './binary-types.js';
import { isBinaryVenue } from './binary-types.js';
import { maximumEntryCost, verifyPreview } from './binary-order.js';
import { KalshiClient, buildOrderRequest, normalizeOrder as normalizeKalshiOrder, normalizePosition as normalizeKalshiPosition, normalizeSettlement, type KalshiVenue } from './kalshi.js';
import { PolymarketUSClient, buildBuyOrder, normalizeOrder as normalizePMOrder, normalizePosition as normalizePMPosition } from './polymarket-us.js';

export const VENUE_LABELS: Record<BinaryVenueId, string> = { 'polymarket-us': 'Polymarket US', kalshi: 'Kalshi', 'kalshi-demo': 'Kalshi demo' };
export const venueLabel = (venue: BinaryVenueId): string => VENUE_LABELS[venue];
export function parseVenue(value: unknown, fallback: BinaryVenueId = 'kalshi'): BinaryVenueId {
  if (value === undefined || value === '') return fallback;
  if (!isBinaryVenue(value)) throw new Error('--venue must be kalshi, kalshi-demo or polymarket-us');
  return value;
}

export function binaryMarketData(venue: BinaryVenueId): BinaryMarketData {
  if (venue === 'polymarket-us') {
    const client = new PolymarketUSClient();
    return {
      venue, label: VENUE_LABELS[venue],
      marketUrl: m => `https://polymarket.us/event/${encodeURIComponent(m.eventSlug)}`,
      discoverHourlyBitcoin: o => client.discoverHourlyBitcoin(o),
      async refreshMarket(saved) {
        const market = await client.discoverHourlyBitcoin({ episodeStart: saved.startsAt, targetEnd: saved.endsAt });
        if (market.slug !== saved.slug) throw new Error('Binary listing changed; review a new episode plan');
        return market;
      },
      getQuote: (slug, side) => client.getQuote(slug, side),
      getSettlement: slug => client.getSettlement(slug),
    };
  }
  const client = new KalshiClient({ venue });
  return {
    venue, label: VENUE_LABELS[venue],
    marketUrl: m => client.marketUrl(m),
    discoverHourlyBitcoin: o => client.discoverHourlyBitcoin(o),
    refreshMarket: saved => client.refreshMarket(saved),
    getQuote: (slug, side) => client.getQuote(slug, side),
    getSettlement: slug => client.getSettlement(slug),
  };
}

/** Reads credentials from the given environment (the operator's, never the dashboard's). */
export function binaryOperator(venue: BinaryVenueId, env: NodeJS.ProcessEnv): BinaryOperator {
  if (venue === 'polymarket-us') {
    if (!env.PM_US_API_KEY || !env.PM_US_SECRET_KEY) throw new Error('Set PM_US_API_KEY and PM_US_SECRET_KEY in the operator environment; no order has been submitted');
    return polymarketOperator(new PolymarketUSClient({ keyId: env.PM_US_API_KEY, secretKey: env.PM_US_SECRET_KEY }));
  }
  const pem = env.KALSHI_PRIVATE_KEY_FILE ? readKeyFile(env.KALSHI_PRIVATE_KEY_FILE) : env.KALSHI_PRIVATE_KEY;
  if (!env.KALSHI_API_KEY_ID || !pem) throw new Error('Set KALSHI_API_KEY_ID and KALSHI_PRIVATE_KEY_FILE (or KALSHI_PRIVATE_KEY) in the operator environment; no order has been submitted');
  return kalshiOperator(new KalshiClient({ venue, keyId: env.KALSHI_API_KEY_ID, privateKey: pem }));
}

function readKeyFile(path: string): string {
  return readFileSync(path, 'utf8');
}

function polymarketOperator(client: PolymarketUSClient): BinaryOperator {
  const venue: BinaryVenueId = 'polymarket-us';
  const request = (p: PreparedBinaryOrder, market: Pick<BinaryMarket, 'priceTick' | 'minimumShares'>) =>
    buildBuyOrder({ marketSlug: p.marketSlug, side: p.side, shares: p.shares, maxPrice: p.limitPrice, priceTick: market.priceTick, minimumShares: market.minimumShares });
  const terms = new Map<string, Pick<BinaryMarket, 'priceTick' | 'minimumShares' | 'feeCoefficient'>>();
  return {
    venue,
    async getHoldings(market, side) {
      return normalizePMPosition(await client.getPositions(market.slug), market.slug, side).shares;
    },
    async prepareOrder(market, side, shares, limitPrice, budgetUsd) {
      if (market.feeCoefficient === null) throw new Error('Market fee coefficient unavailable; cannot guarantee the binary budget');
      terms.set(market.slug, market);
      const prepared: PreparedBinaryOrder = { venue, marketSlug: market.slug, side, shares, limitPrice, maximumCostUsd: maximumEntryCost(shares, limitPrice, market.feeCoefficient) };
      const order = request(prepared, market);
      verifyPreview(await client.previewOrder(order), order, budgetUsd, market.feeCoefficient);
      return prepared;
    },
    async submitOrder(prepared) {
      const market = terms.get(prepared.marketSlug);
      if (!market) throw new Error('Prepare the binary order before sending it');
      const response = await client.createOrder(request(prepared, market));
      if (!response.id) throw new Error('Venue did not return an order ID');
      return response.id;
    },
    async getReceipt(orderId, prepared) {
      const response = await client.getOrder(orderId);
      const receipt = normalizePMOrder(response, prepared.side);
      if (receipt.id !== orderId || receipt.marketSlug !== prepared.marketSlug) throw new Error('Order ID does not match the selected Bitcoin market');
      if (receipt.filledShares > prepared.shares + 1e-8 || receipt.averagePrice !== null && receipt.averagePrice > prepared.limitPrice + 1e-8) throw new Error('Order does not match the prepared share/price limits');
      const expectedYes = prepared.side === 'up' ? prepared.limitPrice : Math.round((1 - prepared.limitPrice) * 1e8) / 1e8;
      if (response.order.quantity !== prepared.shares || response.order.price?.currency !== 'USD' || Number(response.order.price.value) !== expectedYes) throw new Error('Recovered order differs from the prepared request');
      return receipt;
    },
    async getSettledHoldings(market, side) {
      // A resolved public market is not proof that this account held the original
      // shares to settlement. Require the account's position-resolution event.
      const activities = await client.getActivities(market.slug);
      const resolution = activities.activities.map(a => a.positionResolution).find(r => r?.marketSlug === market.slug && r.beforePosition);
      if (!resolution?.beforePosition) return null;
      return normalizePMPosition({ positions: { [market.slug]: resolution.beforePosition }, eof: true }, market.slug, side).shares;
    },
  };
}

function kalshiOperator(client: KalshiClient): BinaryOperator {
  const venue: KalshiVenue = client.venue;
  const ticks = new Map<string, number>();
  return {
    venue,
    async getHoldings(market, side) {
      return normalizeKalshiPosition(await client.getPositions(market.slug), market.slug, side).shares;
    },
    async prepareOrder(market, side, shares, limitPrice, budgetUsd) {
      if (market.feeCoefficient === null) throw new Error('Market fee coefficient unavailable; cannot guarantee the binary budget');
      // Kalshi has no preview endpoint: validate the request locally and bound the taker fee
      // by its quadratic maximum (coefficient / 4 per contract, rounded up per order).
      buildOrderRequest({ ticker: market.slug, side, shares, maxPrice: limitPrice, priceTick: market.priceTick, clientOrderId: 'preview' });
      const maximumCostUsd = maximumEntryCost(shares, limitPrice, market.feeCoefficient);
      if (maximumCostUsd > budgetUsd) throw new Error('Maximum entry cost exceeds the total binary budget');
      ticks.set(market.slug, market.priceTick);
      return { venue, marketSlug: market.slug, side, shares, limitPrice, maximumCostUsd };
    },
    async submitOrder(prepared, clientOrderId) {
      const tick = ticks.get(prepared.marketSlug);
      if (tick === undefined) throw new Error('Prepare the binary order before sending it');
      const response = await client.createOrder(buildOrderRequest({ ticker: prepared.marketSlug, side: prepared.side, shares: prepared.shares, maxPrice: prepared.limitPrice, priceTick: tick, clientOrderId }));
      if (!response.order_id) throw new Error('Venue did not return an order ID');
      return response.order_id;
    },
    async getReceipt(orderId, prepared) {
      const receipt = normalizeKalshiOrder(await client.getOrder(orderId), { ticker: prepared.marketSlug, side: prepared.side, shares: prepared.shares, limitPrice: prepared.limitPrice });
      if (receipt.id !== orderId) throw new Error('Received a different binary order');
      return receipt;
    },
    async getSettledHoldings(market, side) {
      return normalizeSettlement(await client.getSettlements(market.slug), market.slug, side)?.shares ?? null;
    },
  };
}
