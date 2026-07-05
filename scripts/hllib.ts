// Deterministic Hyperliquid exchange helpers — the fiddly, must-be-exact bits
// the agent should never hand-assemble live: msgpack action → connectionId hash
// → EIP-712 typed-data (handed to sigil to sign), tick/size rounding, and the
// signed POST to /exchange.
//
// This is OPERATOR TOOLING. The dash server (src/) never imports it.
//
// Signing is NOT done here — these build the artifact sigil signs and then post
// the result. Flow: prepare → (sigil_eth_sign_typed_data) → send.
import { readFileSync } from "node:fs";
import { encode } from "@msgpack/msgpack";
import jsSha3 from "js-sha3";
const { keccak256 } = jsSha3;

// Featherweight .env loader (tsx doesn't load one) — real env vars win.
try {
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*("?)(.*?)\2\s*$/);
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[3]!;
  }
} catch {}

export const NET = (process.env.HL_NET ?? "testnet").toLowerCase();
export const IS_MAINNET = NET === "mainnet";
export const API = IS_MAINNET
  ? "https://api.hyperliquid.xyz"
  : "https://api.hyperliquid-testnet.xyz";
const SOURCE = IS_MAINNET ? "a" : "b";
const ZERO = "0x0000000000000000000000000000000000000000";

export interface TypedData {
  domain: Record<string, unknown>;
  types: Record<string, { name: string; type: string }[]>;
  primaryType: string;
  message: Record<string, unknown>;
}

async function info<T>(body: unknown): Promise<T> {
  const res = await fetch(`${API}/info`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`/info ${res.status}`);
  return (await res.json()) as T;
}

export interface AssetInfo {
  assetId: number;
  szDecimals: number;
  markPx: number;
}

// Tradeable perp names on the current net — so the roll never picks a coin
// that doesn't exist here (testnet is missing chunks of the mainnet basket).
export async function universe(): Promise<string[]> {
  const [meta] = await info<
    [{ universe: { name: string; isDelisted?: boolean }[] }, unknown]
  >({ type: "metaAndAssetCtxs" });
  return meta.universe.filter((u) => !u.isDelisted).map((u) => u.name);
}

export interface LivePosition {
  coin: string;
  szi: number; // signed size: negative = short
  entryPx: number;
  leverage: number;
}

export async function openPositions(user: string, dex = ""): Promise<LivePosition[]> {
  const chs = await info<{
    assetPositions: {
      position: {
        coin: string;
        szi: string;
        entryPx: string | null;
        positionValue: string;
        leverage?: { value: number };
      };
    }[];
  }>(dex ? { type: "clearinghouseState", user, dex } : { type: "clearinghouseState", user });
  return chs.assetPositions
    .map((p) => p.position)
    .filter((p) => Number(p.szi) !== 0)
    .sort((a, b) => Math.abs(Number(b.positionValue)) - Math.abs(Number(a.positionValue)))
    .map((p) => ({
      coin: p.coin,
      szi: Number(p.szi),
      entryPx: Number(p.entryPx ?? 0),
      leverage: p.leverage?.value ?? 1,
    }));
}

// Resolve a perp to the integer asset id used in actions.
//  - main-dex perps: the plain index in the meta universe (BTC = 0).
//  - HIP-3 builder perps, addressed as "dex:COIN" (e.g. "xyz:DRAM"):
//      assetId = 100000 + perpDexIndex*10000 + indexInDexMeta
//    where perpDexIndex is the position in the `perpDexs` list (main = 0).
export async function assetInfo(coin: string): Promise<AssetInfo> {
  const isHip3 = coin.includes(":");
  const dexName = isHip3 ? coin.slice(0, coin.indexOf(":")) : null;

  let perpDexIndex = 0;
  if (isHip3) {
    const dexs = await info<({ name: string } | null)[]>({ type: "perpDexs" });
    perpDexIndex = dexs.findIndex((d) => d?.name === dexName);
    if (perpDexIndex < 0) throw new Error(`unknown perp dex: ${dexName} (net=${NET})`);
  }

  const [meta, ctxs] = await info<
    [{ universe: { name: string; szDecimals: number }[] }, { markPx: string }[]]
  >(isHip3 ? { type: "metaAndAssetCtxs", dex: dexName } : { type: "metaAndAssetCtxs" });

  const index = meta.universe.findIndex((u) => u.name === coin);
  if (index < 0) throw new Error(`unknown perp: ${coin} (net=${NET})`);

  return {
    assetId: isHip3 ? 100000 + perpDexIndex * 10000 + index : index,
    szDecimals: meta.universe[index]!.szDecimals,
    markPx: Number(ctxs[index]!.markPx),
  };
}

function trim(n: number): string {
  // plain decimal string, no exponent, no trailing zeros
  let s = n.toFixed(8);
  if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
  return s;
}

// HL size: rounded to the asset's szDecimals.
export function formatSize(sz: number, szDecimals: number): string {
  return trim(Number(sz.toFixed(szDecimals)));
}

// HL perp price: ≤5 significant figures AND ≤(6 − szDecimals) decimal places.
export function formatPrice(px: number, szDecimals: number): string {
  const maxDec = Math.max(0, 6 - szDecimals);
  let p = Number(px.toPrecision(5));
  p = Number(p.toFixed(maxDec));
  return trim(p);
}

function hexToBytes(h: string): Uint8Array {
  const s = h.startsWith("0x") ? h.slice(2) : h;
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// keccak256( msgpack(action) || nonce(8B big-endian) || (vault ? 0x01||addr : 0x00) )
export function actionHash(
  action: unknown,
  nonce: number,
  vaultAddress: string | null,
): string {
  const packed = encode(action);
  const nonceBuf = new Uint8Array(8);
  new DataView(nonceBuf.buffer).setBigUint64(0, BigInt(nonce), false);
  const extra = vaultAddress
    ? new Uint8Array([0x01, ...hexToBytes(vaultAddress)])
    : new Uint8Array([0x00]);
  const data = new Uint8Array(packed.length + 8 + extra.length);
  data.set(packed, 0);
  data.set(nonceBuf, packed.length);
  data.set(extra, packed.length + 8);
  return "0x" + keccak256(data);
}

// The exact object to hand to sigil_eth_sign_typed_data. sigil builds the
// EIP712Domain type itself from the domain fields, so we omit it here.
export function agentTypedData(
  action: unknown,
  nonce: number,
  vaultAddress: string | null = null,
): TypedData {
  return {
    domain: { name: "Exchange", version: "1", chainId: 1337, verifyingContract: ZERO },
    types: {
      Agent: [
        { name: "source", type: "string" },
        { name: "connectionId", type: "bytes32" },
      ],
    },
    primaryType: "Agent",
    message: { source: SOURCE, connectionId: actionHash(action, nonce, vaultAddress) },
  };
}

// Split a 65-byte hex signature into HL's {r,s,v} shape.
export function splitSig(hex: string): { r: string; s: string; v: number } {
  const s = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (s.length !== 130) throw new Error(`expected 65-byte sig, got ${s.length / 2} bytes`);
  let v = parseInt(s.slice(128, 130), 16);
  if (v < 27) v += 27;
  return { r: "0x" + s.slice(0, 64), s: "0x" + s.slice(64, 128), v };
}

export async function postExchange(
  action: unknown,
  nonce: number,
  signature: { r: string; s: string; v: number },
  vaultAddress: string | null = null,
): Promise<unknown> {
  const res = await fetch(`${API}/exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, nonce, signature, vaultAddress }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`/exchange ${res.status}: ${JSON.stringify(json)}`);
  return json;
}
