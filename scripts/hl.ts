// Perp of Fortune — the roller. Operator CLI the agent drives live on the show.
// The agent rolls, calls sigil to sign the prepared typed-data, then sends.
//
//   npm run hl roll                                  # spin the wheel
//   npm run hl prepare-leverage --coin SOL --lev 10  # → typed-data for sigil
//   npm run hl prepare-order --coin SOL --side short --usd 50 --lev 10
//   npm run hl send --sig 0x<65-byte-sig-from-sigil>
//
// HL_NET=testnet (default, safe) or mainnet. prepare- commands stash the exact
// {action, nonce} so `send` signs/posts the identical bytes sigil signed.
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import {
  agentTypedData,
  assetInfo,
  formatPrice,
  formatSize,
  IS_MAINNET,
  NET,
  postExchange,
  splitSig,
} from "./hllib.js";

const STASH = join(tmpdir(), "underpod-hl-pending.json");
const TD_FILE = join(tmpdir(), "underpod-hl-typeddata.json");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

// A basket weighted toward chaos. The wheel picks coin / side / leverage.
const BASKET = ["BTC", "ETH", "SOL", "DOGE", "WIF", "kPEPE", "AVAX", "SUI", "LINK", "HYPE"];
const LEV_WHEEL = [2, 3, 5, 5, 10, 10, 20]; // bigger rolls rarer, funnier

function roll(): void {
  const coin = BASKET[Math.floor(Math.random() * BASKET.length)]!;
  const side = Math.random() < 0.5 ? "long" : "short";
  const lev = LEV_WHEEL[Math.floor(Math.random() * LEV_WHEEL.length)]!;
  console.log(`\n  🎡  THE WHEEL HAS SPOKEN\n`);
  console.log(`      ${side.toUpperCase()} ${coin}  ·  ${lev}×\n`);
  console.log(`  next (note the -- separator so npm forwards the flags):`);
  console.log(`    npm run hl -- prepare-leverage --coin ${coin} --lev ${lev}`);
  console.log(`    npm run hl -- prepare-order --coin ${coin} --side ${side} --usd 50 --lev ${lev}\n`);
}

function emitTypedData(label: string, action: unknown, nonce: number): void {
  const td = agentTypedData(action, nonce, null);
  writeFileSync(STASH, JSON.stringify({ label, action, nonce, vaultAddress: null }, null, 2));
  writeFileSync(TD_FILE, JSON.stringify(td)); // exact object to hand to sigil
  console.log(`\n  [${NET}] prepared: ${label}`);
  console.log(`  stashed action+nonce → ${STASH}\n`);
  console.log(`  ── hand this to sigil_eth_sign_typed_data (portal = the trading key) ──\n`);
  console.log(JSON.stringify(td, null, 2));
  console.log(`\n  then: npm run hl -- send --sig 0x<signature>\n`);
}

async function prepareLeverage(): Promise<void> {
  const coin = arg("coin");
  const lev = Number(arg("lev"));
  if (!coin || !lev) throw new Error("need --coin and --lev");
  const { assetId } = await assetInfo(coin);
  // isolated margin so the liquidation maths are clean and dramatic
  const action = { type: "updateLeverage", asset: assetId, isCross: false, leverage: lev };
  emitTypedData(`set ${coin} isolated leverage ${lev}×`, action, Date.now());
}

async function prepareOrder(): Promise<void> {
  const coin = arg("coin");
  const side = arg("side");
  const usd = Number(arg("usd") ?? 50); // margin to commit
  const lev = Number(arg("lev") ?? 1);
  const slip = Number(arg("slippage") ?? 0.05);
  if (!coin || (side !== "long" && side !== "short")) {
    throw new Error("need --coin and --side long|short");
  }
  const { assetId, szDecimals, markPx } = await assetInfo(coin);
  const isBuy = side === "long";
  const notional = usd * lev;
  const size = formatSize(notional / markPx, szDecimals);
  // marketable IOC: cross the spread by `slip` so it fills now
  const px = formatPrice(markPx * (isBuy ? 1 + slip : 1 - slip), szDecimals);
  const action = {
    type: "order",
    orders: [{ a: assetId, b: isBuy, p: px, s: size, r: false, t: { limit: { tif: "Ioc" } } }],
    grouping: "na",
  };
  console.log(
    `\n  ${side.toUpperCase()} ${coin}: margin $${usd} × ${lev}× = $${notional} notional` +
      ` → size ${size} @ mark ${markPx} (IOC limit ${px})`,
  );
  emitTypedData(`${side} ${coin} ${size} @ ${px}`, action, Date.now());
}

async function send(): Promise<void> {
  const sig = arg("sig");
  if (!sig) throw new Error("need --sig 0x<65-byte signature from sigil>");
  const { label, action, nonce, vaultAddress } = JSON.parse(readFileSync(STASH, "utf8"));
  console.log(`\n  [${NET}] sending: ${label}  (nonce ${nonce})`);
  const result = await postExchange(action, nonce, splitSig(sig), vaultAddress);
  console.log(`  response:\n${JSON.stringify(result, null, 2)}\n`);
}

const cmd = process.argv[2];
const run =
  cmd === "roll"
    ? async () => roll()
    : cmd === "prepare-leverage"
      ? prepareLeverage
      : cmd === "prepare-order"
        ? prepareOrder
        : cmd === "send"
          ? send
          : null;

if (!run) {
  console.error(
    `usage: npm run hl <roll|prepare-leverage|prepare-order|send> [...]\n` +
      `  net: ${NET}${IS_MAINNET ? "  ⚠️  MAINNET — real money" : "  (testnet)"}`,
  );
  process.exit(1);
}
run().catch((e) => {
  console.error(`error: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
