import { POLL_MS } from "./config.js";
import { readEpisode, type Episode } from "./episode.js";
import type { BinaryMarketData, BinaryVenueId } from "./binary-types.js";
import { binaryMarketData, venueLabel } from "./binary-venue.js";
import { midPrice } from "./hyperliquid.js";
import type { EpisodePoint } from "./store.js";

export interface EpisodePointStore {
  insertEpisodePoint(p: EpisodePoint): void;
  episodePoints(episodeId: string, sinceTs?: number): EpisodePoint[];
}
const MAX_POINTS = 2000; // ~2.7h of 5s polls; the episode hour needs 720

export interface EpisodeQuote {
  open: boolean;
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
  venue: BinaryVenueId;
  venueLabel: string;
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
    : quoteExpected && !quoteStale && quote?.open && quote.sellPrice !== null && quote.sellAvailableShares >= shares
      ? shares * quote.sellPrice : null;
  const principal = receipt?.totalCostUsd ?? null;
  const fees = receipt?.feesUsd ?? null;
  const basis = principal !== null && fees !== null ? principal + fees : null;
  const pnl = basis !== null && exitValueUsd !== null ? exitValueUsd - basis : null;
  return {
    status, side: b.side, venue: m.venue, venueLabel: venueLabel(m.venue), marketTitle: m.title,
    marketUrl: binaryMarketData(m.venue).marketUrl(m),
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
  private readonly sources = new Map<BinaryVenueId, BinaryMarketData>();
  private pointsFor: string | null = null;
  private pointBuffer: EpisodePoint[] = [];
  /** Without an explicit source, public market data is resolved from the saved episode's venue. */
  constructor(
    private client: BinaryDataSource | null = null,
    private read = readEpisode,
    private pointStore: EpisodePointStore | null = null,
    private btcPrice: () => Promise<number | null> = () => midPrice("BTC"),
  ) {}

  /** BTC price and this side's quote across the episode hour, oldest first. */
  points(): EpisodePoint[] { return this.pointBuffer; }

  private recordPoint(episode: Episode, quote: EpisodeQuote | null, btc: number | null, now: number): void {
    if (this.pointsFor !== episode.id) {
      this.pointsFor = episode.id;
      this.pointBuffer = this.pointStore?.episodePoints(episode.id, episode.startsAt - 10 * 60_000).slice(-MAX_POINTS) ?? [];
    }
    // Only the episode hour (plus a short lead-in) belongs on the chart.
    if (now < episode.startsAt - 10 * 60_000 || now > episode.endsAt + 5 * 60_000) return;
    if (btc === null && !quote) return;
    const point: EpisodePoint = { episodeId: episode.id, ts: now, btc, buy: quote?.buyPrice ?? null, sell: quote?.sellPrice ?? null };
    this.pointBuffer.push(point);
    if (this.pointBuffer.length > MAX_POINTS) this.pointBuffer.splice(0, this.pointBuffer.length - MAX_POINTS);
    try { this.pointStore?.insertEpisodePoint(point); } catch { /* chart history is best-effort */ }
  }

  private source(venue: BinaryVenueId): BinaryDataSource {
    if (this.client) return this.client;
    let source = this.sources.get(venue);
    if (!source) { source = binaryMarketData(venue); this.sources.set(venue, source); }
    return source;
  }

  get current() {
    const b = this.state.binary;
    return { ...this.state, binary: b ? { ...b, stale: b.stale || Date.now() - b.updatedAt > POLL_MS * 3 } : null };
  }

  async tick(): Promise<void> {
    const episode = this.read();
    if (!episode) { this.state = { episode: null, binary: null }; return; }
    const now = Date.now();
    try {
      const client = this.source(episode.binary.market.venue);
      const wantPrice = now >= episode.startsAt - 10 * 60_000 && now <= episode.endsAt + 5 * 60_000;
      const [quoteResult, settlementResult, priceResult] = await Promise.allSettled([
        now < episode.startsAt - 90_000 ? Promise.resolve(null) : client.getQuote(episode.binary.market.slug, episode.binary.side),
        now >= episode.endsAt ? client.getSettlement(episode.binary.market.slug) : Promise.resolve(null),
        wantPrice ? this.btcPrice() : Promise.resolve(null),
      ]);
      const quote = quoteResult.status === "fulfilled" ? quoteResult.value : null;
      this.recordPoint(episode, quote, priceResult.status === "fulfilled" ? priceResult.value : null, now);
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
