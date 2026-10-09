import { depthWithin, MIN_NOTIONAL_USD, type BinaryQuote } from "./hl-outcomes.js";

export const ENTRY_FLOOR = 0.4;
export const ENTRY_CEILING = 0.6;
/** Entry has to leave most of the hour on the clock, and can't start long before it. */
export const MIN_REMAINING_MS = 45 * 60_000;
export const EARLY_ENTRY_MS = 5 * 60_000;
const STALE_MS = 15_000;

/** Whole shares to buy with an IOC at `limit`. Opening an outcome position pays
 * no fee on Hyperliquid (fees fall on closes and settlement), so the budget is
 * principal; the cost can never exceed shares × limit. */
export function sizeBinaryOrder(window: { startsAt: number; endsAt: number }, quote: BinaryQuote, budget: number, limit: number, now = Date.now()): number {
  if (!Number.isFinite(budget) || budget <= 0 || !(limit >= ENTRY_FLOOR && limit <= ENTRY_CEILING)) throw new Error("Invalid binary budget or entry limit");
  if (now < window.startsAt - EARLY_ENTRY_MS || now > window.endsAt - MIN_REMAINING_MS) throw new Error("Binary is outside its entry window (5 minutes before the hour to 15 minutes after)");
  if (quote.status !== "open" || now - quote.updatedAt > STALE_MS || quote.updatedAt > now + 5_000) throw new Error("Binary order book is empty or stale");
  if (quote.buyPrice === null || quote.buyPrice < ENTRY_FLOOR || quote.buyPrice > limit) throw new Error(`Binary entry must be quoted between $${ENTRY_FLOOR.toFixed(2)} and the chosen limit ($${limit.toFixed(2)})`);
  const shares = Math.floor(Math.min(budget / limit, depthWithin(quote.asks, limit)));
  if (shares < 1 || shares * quote.buyPrice < MIN_NOTIONAL_USD) throw new Error(`Budget or depth is too small for Hyperliquid's $${MIN_NOTIONAL_USD} minimum order`);
  return shares;
}

/** Whole shares for a resting bid at `price`: same band, window and minimum, no book needed. */
export function sizeRestingOrder(window: { startsAt: number; endsAt: number }, budget: number, price: number, limit: number, now = Date.now()): number {
  if (!Number.isFinite(budget) || budget <= 0 || !(price >= ENTRY_FLOOR && price <= limit && limit <= ENTRY_CEILING)) throw new Error(`Resting bid must be between $${ENTRY_FLOOR.toFixed(2)} and the limit ($${limit.toFixed(2)})`);
  if (now < window.startsAt - EARLY_ENTRY_MS || now > window.endsAt - MIN_REMAINING_MS) throw new Error("Binary is outside its entry window (5 minutes before the hour to 15 minutes after)");
  const shares = Math.floor(budget / price);
  if (shares * price < MIN_NOTIONAL_USD) throw new Error(`Budget is too small for Hyperliquid's $${MIN_NOTIONAL_USD} minimum order`);
  return shares;
}

export const maximumEntryCost = (shares: number, limit: number) => Math.round(shares * limit * 1e8) / 1e8;
