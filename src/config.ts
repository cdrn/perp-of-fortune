// All read-only. No private keys live in this process — order signing is done
// out-of-band by sigil. This service only watches a wallet's position.
import { readFileSync } from "node:fs";

// Featherweight .env loader (tsx doesn't load one) — real env vars win.
try {
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*("?)(.*?)\2\s*$/);
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[3]!;
  }
} catch {}

export const HL_API = process.env.HL_API ?? "https://api.hyperliquid.xyz";
export const WALLET = (process.env.UNDERPOD_WALLET ?? "").toLowerCase();
// Builder perp dex (HIP-3) to track, e.g. "xyz". Empty = main perp dex.
export const DEX = (process.env.UNDERPOD_DEX ?? "").trim();
export const PORT = Number(process.env.UNDERPOD_PORT ?? 4749);
export const POLL_MS = Number(process.env.UNDERPOD_POLL_MS ?? 5000);
export const DB_PATH = process.env.UNDERPOD_DB ?? "underpod.db";

if (!WALLET || !/^0x[0-9a-f]{40}$/.test(WALLET)) {
  console.warn(
    `[underpod] UNDERPOD_WALLET is not a valid address (${WALLET || "unset"}) — tracker will idle until set`,
  );
}
