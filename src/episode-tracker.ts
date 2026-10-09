import { POLL_MS, WALLET } from "./config.js";
import { readEpisode, type Episode } from "./episode.js";
import {
  apiFor, balanceCoin, bookCoin, exitValue, HLOutcomeClient, settlementFromFills,
  type BinaryQuote, type BinarySide, type HLFill,
} from "./hl-outcomes.js";

export type EpisodeQuote = BinaryQuote;

/** What the chain says about the account, read without keys. */
export interface AccountState {
  holdings: number | null;
  /** The account's own settlement fill: shares settled and net payout. */
  settlement: { shares: number; payoutUsd: number } | null;
}

export interface BinaryView {
  status: "planned" | "submitted" | "live" | "awaiting_result" | "settled" | "unavailable";
  side: "up" | "down";
  marketTitle: string | null;
  marketUrl: string | null;
  threshold: number | null;
  deployer: string | null;
  priceSource: string | null;
  startsAt: number;
  endsAt: number;
  settlementAt: number | null;
  quote: Omit<EpisodeQuote, "asks" | "bids"> | null;
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

export function binaryView(e: Episode, quote: EpisodeQuote | null, yesSettlement: number | null, now = Date.now(), account: AccountState = { holdings: null, settlement: null }): BinaryView {
  const b = e.binary, m = b.market, receipt = b.order;
  const shares = receipt && receipt.filledShares > 0 ? receipt.filledShares : null;
  const settlementValue = yesSettlement === null ? null : b.side === "up" ? yesSettlement : 1 - yesSettlement;
  const status = settlementValue !== null ? "settled" : now >= e.endsAt ? "awaiting_result" : shares !== null ? "live"
    : receipt || ["submitted", "uncertain", "sending"].includes(b.prepared?.state ?? "") ? "submitted" : "planned";
  // A purchase receipt alone cannot prove the account still holds those shares:
  // live holdings must match it, and a recorded mismatch disqualifies P&L.
  const holdingsMatch = account.holdings !== null && shares !== null && Math.abs(account.holdings - shares) < 1e-9;
  const quoteExpected = now >= e.startsAt - 300_000 && now < e.endsAt;
  const quoteStale = quoteExpected && !!m && (!quote || now - quote.updatedAt > POLL_MS * 3);
  const settledPayout = account.settlement && shares !== null && Math.abs(account.settlement.shares - shares) < 1e-9
    ? account.settlement.payoutUsd : b.finalSettlement?.payoutUsd ?? null;
  const exitValueUsd = shares === null || b.reconciliationError ? null : settlementValue !== null
    ? settledPayout
    : quoteExpected && !quoteStale && holdingsMatch && quote ? exitValue(quote.bids, shares) : null;
  const principal = receipt?.totalCostUsd ?? null;
  const fees = receipt?.feesUsd ?? null;
  const basis = principal !== null && fees !== null ? principal + fees : null;
  const pnl = basis !== null && exitValueUsd !== null ? Math.round((exitValueUsd - basis) * 1e8) / 1e8 : null;
  const holdingsStale = shares !== null && settlementValue === null && now < e.endsAt && !holdingsMatch;
  const { asks: _asks, bids: _bids, ...quoteSummary } = quote ?? { asks: [], bids: [] };
  return {
    status, side: b.side, marketTitle: m?.title ?? null,
    marketUrl: null, threshold: m?.threshold ?? null, deployer: m ? m.official ? "Hyperliquid" : m.deployer : null, priceSource: m?.priceSource ?? null,
    startsAt: e.startsAt, endsAt: e.endsAt, settlementAt: m?.endsAt ?? null,
    quote: quote ? quoteSummary as BinaryView["quote"] : null, shares, costUsd: principal, feesUsd: fees, exitValueUsd,
    pnlUsd: pnl, roiPct: pnl !== null && basis && basis > 0 ? pnl / basis * 100 : null,
    winPayoutUsd: shares, settlementValue, updatedAt: now,
    stale: holdingsStale || (settlementValue === null && quoteStale),
    error: b.reconciliationError ?? (holdingsStale && account.holdings !== null ? "Account holdings differ from the fill receipt; P&L withheld." : null),
  };
}

export interface BinaryDataSource {
  getQuote(outcome: number, side: BinarySide): Promise<EpisodeQuote>;
  getSettlement(outcome: number): Promise<number | null>;
  spotBalances?(user: string): Promise<Map<string, { total: number }>>;
  fills?(user: string, startTime: number): Promise<HLFill[]>;
}

export class EpisodeTracker {
  private state: { episode: Episode | null; binary: BinaryView | null; error?: string } = { episode: null, binary: null };
  constructor(private client?: BinaryDataSource, private read = readEpisode, private wallet = WALLET) {}

  get current() {
    const b = this.state.binary;
    return { ...this.state, binary: b ? { ...b, stale: b.stale || Date.now() - b.updatedAt > POLL_MS * 3 } : null };
  }

  async tick(): Promise<void> {
    const episode = this.read();
    if (!episode) { this.state = { episode: null, binary: null }; return; }
    const client = this.client ?? new HLOutcomeClient(apiFor(episode.perpNetwork));
    const now = Date.now(), m = episode.binary.market, side = episode.binary.side;
    if (!m) { this.state = { episode, binary: binaryView(episode, null, null, now) }; return; }
    try {
      const filled = (episode.binary.order?.filledShares ?? 0) > 0;
      const [quoteResult, settlementResult, balancesResult, fillsResult] = await Promise.allSettled([
        now < episode.startsAt - 300_000 || now >= episode.endsAt ? Promise.resolve(null) : client.getQuote(m.outcome, side),
        now >= episode.endsAt ? client.getSettlement(m.outcome) : Promise.resolve(null),
        filled && this.wallet && client.spotBalances ? client.spotBalances(this.wallet) : Promise.resolve(null),
        filled && this.wallet && client.fills && now >= episode.endsAt ? client.fills(this.wallet, episode.startsAt - 3_600_000) : Promise.resolve(null),
      ]);
      const quote = quoteResult.status === "fulfilled" ? quoteResult.value : null;
      const settlement = settlementResult.status === "fulfilled" ? settlementResult.value ?? episode.binary.finalSettlement?.yesValue ?? null : episode.binary.finalSettlement?.yesValue ?? null;
      const balances = balancesResult.status === "fulfilled" ? balancesResult.value : null;
      const fills = fillsResult.status === "fulfilled" ? fillsResult.value : null;
      const settled = fills ? settlementFromFills(fills, bookCoin(m.outcome, side)) : null;
      const view = binaryView(episode, quote, settlement, now, {
        holdings: balances ? balances.get(balanceCoin(m.outcome, side))?.total ?? 0 : null,
        settlement: settled ? { shares: settled.shares, payoutUsd: settled.payoutUsd } : null,
      });
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
