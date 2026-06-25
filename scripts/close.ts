// Flatten an open perp position with a reduce-only marketable IOC order.
// Reads the live position from UNDERPOD_WALLET, builds the opposite-side order
// sized to the exact position, and emits typed-data for sigil — same
// prepare → (sigil sign) → `npm run hl -- send` flow as opening.
//
//   HL_NET=mainnet npm run close -- --coin SOL
//   then: npm run hl -- send --sig 0x<signature>
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { agentTypedData, assetInfo, formatPrice, formatSize, NET } from "./hllib.js";

const API = NET === "mainnet"
  ? "https://api.hyperliquid.xyz"
  : "https://api.hyperliquid-testnet.xyz";
const STASH = join(tmpdir(), "underpod-hl-pending.json");
const TD_FILE = join(tmpdir(), "underpod-hl-typeddata.json");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const coin = arg("coin");
  const wallet = (process.env.UNDERPOD_WALLET ?? "").trim();
  if (!coin) throw new Error("need --coin");
  if (!wallet) throw new Error("need UNDERPOD_WALLET (set it in .env)");

  const res = await fetch(`${API}/info`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "clearinghouseState", user: wallet }),
  });
  const state = (await res.json()) as {
    assetPositions: { position: { coin: string; szi: string } }[];
  };
  const pos = state.assetPositions.find((ap) => ap.position.coin === coin);
  const szi = pos ? Number(pos.position.szi) : 0;
  if (!szi) throw new Error(`no open ${coin} position for ${wallet} (net=${NET})`);

  const { assetId, szDecimals, markPx } = await assetInfo(coin);
  const buyToClose = szi < 0; // short → buy back; long → sell
  const size = formatSize(Math.abs(szi), szDecimals);
  const slip = Number(arg("slippage") ?? 0.05);
  const px = formatPrice(markPx * (buyToClose ? 1 + slip : 1 - slip), szDecimals);
  const action = {
    type: "order",
    orders: [{ a: assetId, b: buyToClose, p: px, s: size, r: true, t: { limit: { tif: "Ioc" } } }],
    grouping: "na",
  };
  const nonce = Date.now();
  const td = agentTypedData(action, nonce, null);
  writeFileSync(STASH, JSON.stringify({ label: `close ${coin} (${szi})`, action, nonce, vaultAddress: null }, null, 2));
  writeFileSync(TD_FILE, JSON.stringify(td));

  console.log(`\n  [${NET}] prepared CLOSE ${coin}: ${buyToClose ? "BUY" : "SELL"} ${size} @ ${px} (reduce-only IOC)`);
  console.log(`\n  ── hand this to sigil_eth_sign_typed_data (portal = the trading key) ──\n`);
  console.log(JSON.stringify(td, null, 2));
  console.log(`\n  then: npm run hl -- send --sig 0x<signature>\n`);
}

main().catch((e) => {
  console.error(`error: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
