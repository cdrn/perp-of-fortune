import type { EpisodeMarket } from "./episode.js";
import type { BinaryQuote, BuyOrder, PMOrderResponse } from "./polymarket-us.js";

export function maximumEntryCost(shares: number, limitPrice: number, feeCoefficient: number): number {
  // The symmetric fee curve is bounded by coefficient / 4 per share. Round
  // fees up and leave a cent of headroom when sizing, including fractional lots.
  return shares * limitPrice + Math.ceil(shares * feeCoefficient * 0.25 * 100) / 100;
}

export function sizeBinaryOrder(market: EpisodeMarket, quote: BinaryQuote, budget: number, limit: number, now = Date.now()): number {
  if (!Number.isFinite(budget) || budget <= 0 || limit < 0.4 || limit > 0.6) throw new Error("Invalid binary budget or entry limit");
  if (now >= market.endsAt || now < market.startsAt - 90_000) throw new Error("Binary market is outside its entry window");
  if (quote.status !== "MARKET_STATE_OPEN" || now - quote.updatedAt > 15_000 || quote.updatedAt > now + 5_000) throw new Error("Binary order book is closed or stale");
  if (quote.buyPrice === null || quote.buyPrice < 0.4 || quote.buyPrice > limit) throw new Error("Binary entry must be quoted between $0.40 and the chosen limit (at most $0.60)");
  const fee = market.feeCoefficient;
  if (fee === null || !Number.isFinite(fee) || fee < 0 || fee > 1) throw new Error("Market fee coefficient unavailable; cannot guarantee the binary budget");
  const step = market.minimumShares;
  if (!Number.isFinite(step) || step <= 0 || !Number.isFinite(quote.availableShares)) throw new Error("Invalid binary quantity/depth");
  const shares = Math.floor(Math.min((budget - 0.01) / (limit + fee / 4), quote.availableShares) / step) * step;
  const rounded = Math.round(shares * 1e8) / 1e8;
  if (rounded < step || maximumEntryCost(rounded, limit, fee) > budget) throw new Error("Budget or quoted depth is too small for the minimum binary order");
  return rounded;
}

export function verifyPreview(preview: PMOrderResponse, request: BuyOrder, budget: number, feeCoefficient: number): void {
  const order = preview.order;
  if (!order || order.marketSlug !== request.marketSlug || order.intent !== request.intent || order.quantity !== request.quantity
    || order.price?.currency !== "USD" || Number(order.price.value) !== Number(request.price.value)) {
    throw new Error("Venue preview does not match the prepared binary order");
  }
  if (/REJECT|EXPIRED/i.test(order.state ?? "")) throw new Error("Venue rejected the binary order preview");
  const sidePrice = request.intent === "ORDER_INTENT_BUY_SHORT" ? 1 - Number(request.price.value) : Number(request.price.value);
  const fee = order.commissionNotionalTotalCollected;
  if (fee && (fee.currency !== "USD" || !Number.isFinite(Number(fee.value)) || Number(fee.value) < 0)) throw new Error("Invalid preview fee");
  const previewCost = request.quantity * sidePrice + (fee ? Number(fee.value) : 0);
  if (previewCost > budget || maximumEntryCost(request.quantity, sidePrice, feeCoefficient) > budget + 1e-8) throw new Error("Preview exceeds the total binary budget");
}
