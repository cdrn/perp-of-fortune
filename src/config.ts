// All read-only. No private keys live in this process — order signing is done
// out-of-band by sigil. This service only watches a wallet's position.
import { readFileSync } from "node:fs";

// Featherweight .env loader (tsx doesn't load one) — real env vars win.
try {
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*("?)(.*?)\2\s*$/);
    // This process is public/read-only. Operator API credentials belong in the
    // operator environment and must never be loaded from .env by the dashboard.
    if (m && /^(UNDERPOD_(WALLET|DEX|DEXES|PORT|HOST|POLL_MS|DB|EPISODE)|HL_API)$/.test(m[1]!)
      && process.env[m[1]!] === undefined) process.env[m[1]!] = m[3]!;
  }
} catch {}

export const HL_API = process.env.HL_API ?? "https://api.hyperliquid.xyz";
export const WALLET = (process.env.UNDERPOD_WALLET ?? "").toLowerCase();
// Builder perp dex (HIP-3) to track, e.g. "xyz". Empty = main perp dex.
export const DEX = (process.env.UNDERPOD_DEX ?? "").trim();
// Every perp dex to scan for the live position. Main perp dex is "".
// UNDERPOD_DEXES is a comma list (e.g. ",xyz"); default = main + UNDERPOD_DEX.
export const DEXES: string[] = (
  process.env.UNDERPOD_DEXES !== undefined
    ? process.env.UNDERPOD_DEXES.split(",").map((d) => d.trim())
    : ["", DEX]
).filter((d, i, a) => a.indexOf(d) === i);
export const PORT = Number(process.env.UNDERPOD_PORT ?? 4749);
export const HOST = process.env.UNDERPOD_HOST ?? "127.0.0.1";
export const POLL_MS = Number(process.env.UNDERPOD_POLL_MS ?? 5000);
export const DB_PATH = process.env.UNDERPOD_DB ?? "underpod.db";

if (!WALLET || !/^0x[0-9a-f]{40}$/.test(WALLET)) {
  console.warn(
    `[underpod] UNDERPOD_WALLET is not a valid address (${WALLET || "unset"}) — tracker will idle until set`,
  );
}
