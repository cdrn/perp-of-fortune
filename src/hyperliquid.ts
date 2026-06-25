import { HL_API } from "./config.js";

// Thin read client for Hyperliquid's public /info endpoint. One POST per query
// type; no auth. (The same endpoint backdraft's funding module already polls.)
async function info<T>(body: unknown): Promise<T> {
  const res = await fetch(`${HL_API}/info`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`hyperliquid /info ${res.status}`);
  return (await res.json()) as T;
}

export interface RawPosition {
  coin: string;
  szi: string; // signed size: negative = short
  entryPx: string | null;
  positionValue: string;
  unrealizedPnl: string;
  liquidationPx: string | null;
  marginUsed: string;
  leverage: { type: string; value: number };
  cumFunding?: { allTime: string; sinceOpen: string; sinceChange: string };
}

export interface ClearinghouseState {
  assetPositions: { position: RawPosition }[];
  marginSummary: {
    accountValue: string;
    totalMarginUsed: string;
    totalNtlPos: string;
  };
  withdrawable: string;
}

export function clearinghouseState(user: string, dex = ""): Promise<ClearinghouseState> {
  return info<ClearinghouseState>(
    dex ? { type: "clearinghouseState", user, dex } : { type: "clearinghouseState", user },
  );
}

interface AssetCtx {
  funding: string; // current hourly funding rate (8h-equivalent? no — HL is hourly)
  markPx: string;
  oraclePx: string;
}

export async function markAndFunding(dex = ""): Promise<
  Map<string, { markPx: number; funding: number }>
> {
  const [meta, ctxs] = await info<
    [{ universe: { name: string }[] }, AssetCtx[]]
  >(dex ? { type: "metaAndAssetCtxs", dex } : { type: "metaAndAssetCtxs" });
  const out = new Map<string, { markPx: number; funding: number }>();
  for (let i = 0; i < meta.universe.length; i++) {
    const name = meta.universe[i]?.name;
    const ctx = ctxs[i];
    if (!name || !ctx) continue;
    out.set(name, { markPx: Number(ctx.markPx), funding: Number(ctx.funding) });
  }
  return out;
}
