import { POLL_MS } from "./config.js";
import { readEpisode, type Episode } from "./episode.js";
import { PolymarketUSClient } from "./polymarket-us.js";

export interface EpisodeQuote {
  buyPrice: number | null;
  sellPrice: number | null;
  availableShares: number;
  sellAvailableShares: number;
  updatedAt: number;
  status: string;
}

export interface BinaryView {
  status: "planned" | "submitted" | "live" | "awaiting_result" | "settled" | "unavailable";
  side: "up" | "down";
  marketTitle: string;
  marketUrl: string;
  startsAt: number;
  endsAt: number;
  settlementAt: number | null;
  quote: EpisodeQuote | null;
  shares: number | null;
  costUsd: number | null;
  feesUsd: number | null;
  exitValueUsd: number | null;
  pnlUsd: number | null;
  roiPct: number | null;
  winPayoutUsd: number | null;
  settlementValue: number | null;
  updatedAt: number;
  stale: boolean;
  error: string | null;
}

export function binaryView(e: Episode, quote: EpisodeQuote | null, yesSettlement: number | null, now = Date.now()): BinaryView {
  const b = e.binary, m = b.market, receipt = b.order;
  const shares = receipt && receipt.filledShares > 0 ? receipt.filledShares : null;
  const settlementValue = yesSettlement === null ? null : b.side === "up" ? yesSettlement : 1 - yesSettlement;
  const status = settlementValue !== null ? "settled" : now >= m.endsAt ? "awaiting_result" : shares !== null ? "live" : receipt || b.prepared?.state === "submitted" || b.prepared?.state === "uncertain" || b.prepared?.state === "sending" ? "submitted" : "planned";
  const reconciliationStale = shares !== null && (!b.finalSettlement && now - (b.positionCheckedAt ?? 0) > 60_000 || !!b.reconciliationError);
  const quoteExpected = now >= m.startsAt - 90_000 && now < m.endsAt;
  const quoteStale = quoteExpected && (!quote || now - quote.updatedAt > POLL_MS * 3);
  // A purchase receipt alone cannot prove the account still holds those shares.
  // Polling/reconciliation belongs to the operator; this process uses no keys.
  const holdingsKnown = shares !== null && !reconciliationStale;
  const exitValueUsd = !holdingsKnown ? null : settlementValue !== null
    ? b.finalSettlement?.payoutUsd ?? null
    : quoteExpected && !quoteStale && quote?.status === "MARKET_STATE_OPEN" && quote.sellPrice !== null && quote.sellAvailableShares >= shares
      ? shares * quote.sellPrice : null;
  const principal = receipt?.totalCostUsd ?? null;
  const fees = receipt?.feesUsd ?? null;
  const basis = principal !== null && fees !== null ? principal + fees : null;
  const pnl = basis !== null && exitValueUsd !== null ? exitValueUsd - basis : null;
  return {
    status, side: b.side, marketTitle: m.title,
    marketUrl: `https://polymarket.us/event/${encodeURIComponent(m.eventSlug)}`,
    startsAt: m.startsAt, endsAt: m.endsAt, settlementAt: m.settlementAt,
    quote, shares, costUsd: principal, feesUsd: fees, exitValueUsd,
    pnlUsd: pnl, roiPct: pnl !== null && basis && basis > 0 ? pnl / basis * 100 : null,
    winPayoutUsd: shares, settlementValue, updatedAt: now,
    stale: reconciliationStale || (settlementValue === null && quoteStale),
    error: b.reconciliationError ?? (reconciliationStale ? "Refresh the binary account using episode sync-binary --watch." : null),
  };
}

export interface BinaryDataSource {
  getQuote(slug: string, side: "up" | "down"): Promise<EpisodeQuote>;
  getSettlement(slug: string): Promise<number | null>;
}

export class EpisodeTracker {
  private state: { episode: Episode | null; binary: BinaryView | null; error?: string } = { episode: null, binary: null };
  constructor(private client: BinaryDataSource = new PolymarketUSClient(), private read = readEpisode) {}

  get current() {
    const b = this.state.binary;
    return { ...this.state, binary: b ? { ...b, stale: b.stale || Date.now() - b.updatedAt > POLL_MS * 3 } : null };
  }

  async tick(): Promise<void> {
    const episode = this.read();
    if (!episode) { this.state = { episode: null, binary: null }; return; }
    const now = Date.now();
    try {
      const [quoteResult, settlementResult] = await Promise.allSettled([
        now < episode.startsAt - 90_000 ? Promise.resolve(null) : this.client.getQuote(episode.binary.market.slug, episode.binary.side),
        now >= episode.endsAt ? this.client.getSettlement(episode.binary.market.slug) : Promise.resolve(null),
      ]);
      const quote = quoteResult.status === "fulfilled" ? quoteResult.value : null;
      const settlement = episode.binary.finalSettlement?.yesValue ?? (settlementResult.status === "fulfilled" ? settlementResult.value : null);
      const view = binaryView(episode, quote, settlement, now);
      if (quoteResult.status === "rejected" && settlement === null) view.error = "Binary quotes unavailable; the thematic perp continues independently.";
      if (settlementResult.status === "rejected") view.error = "The binary result could not be verified yet.";
      this.state = { episode, binary: view };
    } catch (err) {
      this.state = { episode, binary: { ...binaryView(episode, null, null, now), stale: true, error: err instanceof Error ? err.message : "Binary market unavailable" } };
    }
  }

  start(): void {
    const loop = async () => {
      try { await this.tick(); } catch (err) {
        this.state = { episode: null, binary: null, error: err instanceof Error ? err.message : "Episode unavailable" };
      }
      setTimeout(() => void loop(), POLL_MS).unref();
    };
    void loop();
  }
}
