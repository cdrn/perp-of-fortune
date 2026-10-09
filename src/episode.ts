import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export interface EpisodeMarket {
  venue: "polymarket-us";
  slug: string;
  eventSlug: string;
  title: string;
  startsAt: number;
  endsAt: number;
  settlementAt: number | null;
  rules: string;
  priceTick: number;
  minimumShares: number;
  feeCoefficient: number | null;
  priceToBeat: number | null;
  status: string;
}

export interface BinaryReceipt {
  id: string;
  marketSlug: string;
  side: "up" | "down";
  filledShares: number;
  averagePrice: number | null;
  totalCostUsd: number | null; // principal paid; fees stored separately
  feesUsd: number | null;
  status: string;
  updatedAt: number;
}

export interface Episode {
  version: 1;
  id: string;
  createdAt: number;
  theme: string;
  startsAt: number;
  endsAt: number;
  perpNetwork: "mainnet" | "testnet";
  perp: { coin: string; side: "long" | "short"; leverage: number; marginUsd: number; thesis: string };
  binary: {
    market: EpisodeMarket;
    side: "up" | "down";
    budgetUsd: number;
    limitPrice: number;
    order?: BinaryReceipt;
    positionCheckedAt?: number;
    reconciliationError?: string;
    finalSettlement?: { shares: number; yesValue: number; payoutUsd: number; verifiedAt: number };
    /** Earlier orders for this episode that ended with no fills or never reached the venue.
     * Recovery must never adopt one of these as the current order. */
    attempts?: { orderId?: string; preparedAt: number; outcome: "unfilled" | "rejected" | "abandoned" }[];
    prepared?: {
      shares: number;
      limitPrice: number;
      preparedAt: number;
      expiresAt: number;
      state: "prepared" | "sending" | "submitted" | "uncertain";
      orderId?: string;
    };
  };
}

export const episodePath = () => resolve(process.env.UNDERPOD_EPISODE ?? "underpod-episode.json");

export function positiveNumber(value: unknown, name: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a finite positive number`);
  return n;
}

export function validateEpisode(e: Episode): Episode {
  if (e.version !== 1 || !e.id || !e.theme?.trim() || !e.perp?.thesis?.trim()) throw new Error("Invalid episode: theme and perp thesis are required");
  if (!/^[A-Za-z0-9:_-]+$/.test(e.perp.coin)) throw new Error("Invalid perp coin");
  if (!["long", "short"].includes(e.perp.side) || !["up", "down"].includes(e.binary?.side)) throw new Error("Invalid episode sides");
  if (!["testnet", "mainnet"].includes(e.perpNetwork)) throw new Error("Invalid perp network");
  positiveNumber(e.perp.marginUsd, "Perp margin");
  positiveNumber(e.binary.budgetUsd, "Binary budget");
  if (!Number.isInteger(e.perp.leverage) || e.perp.leverage < 1) throw new Error("Invalid perp leverage");
  if (!(e.binary.limitPrice >= 0.4 && e.binary.limitPrice <= 0.6)) throw new Error("Binary entry limit must be between $0.40 and $0.60");
  const m = e.binary.market;
  if (m.venue !== "polymarket-us" || !m.slug || !m.eventSlug || !m.rules) throw new Error("Invalid binary market");
  if (!Number.isFinite(m.startsAt) || m.endsAt - m.startsAt !== 3_600_000 || e.startsAt !== m.startsAt || e.endsAt !== m.endsAt) throw new Error("Episode must match one complete hourly binary window");
  if (e.binary.order) {
    const o = e.binary.order;
    if (o.marketSlug !== m.slug || o.side !== e.binary.side || !o.id) throw new Error("Binary receipt does not match this episode");
    for (const n of [o.filledShares, o.totalCostUsd, o.feesUsd]) {
      if (n !== null && (!Number.isFinite(n) || n < 0)) throw new Error("Invalid binary fill accounting");
    }
  }
  return e;
}

export function readEpisode(path = episodePath()): Episode | null {
  if (!existsSync(path)) return null;
  return validateEpisode(JSON.parse(readFileSync(path, "utf8")) as Episode);
}

export function writeEpisode(episode: Episode, path = episodePath()): void {
  validateEpisode(episode);
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(episode, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    renameSync(temp, path);
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
}

// Serialize CLI changes and persist an uncertain send before making a network
// mutation. A crashed send must be reconciled, never automatically retried.
export async function withEpisodeLock<T>(fn: () => Promise<T>, path = episodePath()): Promise<T> {
  mkdirSync(dirname(path), { recursive: true });
  const lock = `${path}.lock`;
  try {
    writeFileSync(lock, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
  } catch {
    throw new Error(`Episode is locked: ${lock}. Check the running operator before recovering a stale lock.`);
  }
  try { return await fn(); } finally { unlinkSync(lock); }
}
