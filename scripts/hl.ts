// Perp of Fortune — the roller. Operator CLI the agent drives live on the show.
// The agent rolls, calls sigil to sign the prepared typed-data, then sends.
//
//   npm run hl roll                                  # spin the wheel (curated basket)
//   npm run hl -- roll --any                         # spin over the ENTIRE universe
//   npm run hl -- roll --seed "listener phrase"      # verifiable (keccak) roll
//   npm run hl prepare-leverage --coin SOL --lev 10  # → typed-data for sigil
//   npm run hl prepare-order --coin SOL --side short --usd 50 --lev 10
//   npm run hl prepare-close [--coin SOL]            # reduce-only, cut it loose
//   npm run hl send --sig 0x<65-byte-sig-from-sigil>
//
// HL_NET=testnet (default, safe) or mainnet. prepare- commands stash the exact
// {action, nonce} so `send` signs/posts the identical bytes sigil signed.
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import jsSha3 from "js-sha3";
import {
  agentTypedData,
  assetInfo,
  formatPrice,
  formatSize,
  IS_MAINNET,
  NET,
  openPositions,
  postExchange,
  splitSig,
  universe,
} from "./hllib.js";
const { keccak256 } = jsSha3;

const STASH = join(tmpdir(), "underpod-hl-pending.json");
const TD_FILE = join(tmpdir(), "underpod-hl-typeddata.json");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

// A basket weighted toward chaos. The wheel picks coin / side / leverage.
const BASKET = ["BTC", "ETH", "SOL", "DOGE", "WIF", "kPEPE", "AVAX", "SUI", "LINK", "HYPE"];
const LEV_WHEEL = [2, 3, 5, 5, 10, 10, 20]; // bigger rolls rarer, funnier

async function roll(): Promise<void> {
  // Only spin over coins that actually trade on this net — testnet is missing
  // chunks of the basket and we don't want to find out live. --any widens the
  // wheel to the entire listed universe (~180 perps of varying dignity).
  const listed = await universe();
  const any = process.argv.includes("--any");
  const basket = any ? listed : BASKET.filter((c) => listed.includes(c));
  const missing = any ? [] : BASKET.filter((c) => !listed.includes(c));
  if (!basket.length) throw new Error(`none of the basket trades on ${NET}`);
  if (any) console.log(`\n  (full universe: ${basket.length} perps on ${NET})`);
  if (missing.length) console.log(`\n  (not listed on ${NET}, skipped: ${missing.join(", ")})`);

  // With --seed the roll is deterministic and verifiable: keccak256 of the
  // phrase picks coin / side / leverage. Anyone can re-derive it at home.
  const seed = arg("seed");
  let picks: number[];
  let provenance = "";
  if (seed) {
    const h = keccak256(seed);
    picks = [0, 1, 2].map((i) => parseInt(h.slice(i * 8, i * 8 + 8), 16));
    provenance = `  seed "${seed}" → keccak256 0x${h.slice(0, 16)}…\n`;
  } else {
    picks = [0, 1, 2].map(() => Math.floor(Math.random() * 0xffffffff));
  }
  const coin = basket[picks[0]! % basket.length]!;
  const side = picks[1]! % 2 === 0 ? "long" : "short";
  const lev = LEV_WHEEL[picks[2]! % LEV_WHEEL.length]!;

  console.log(`\n  🎡  THE WHEEL HAS SPOKEN\n`);
  console.log(`      ${side.toUpperCase()} ${coin}  ·  ${lev}×\n`);
  if (provenance) console.log(provenance);
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
  if (notional < 10) throw new Error(`HL minimum order value is $10 notional (got $${notional})`);
  const size = formatSize(notional / markPx, szDecimals);
  if (Number(size) <= 0) {
    throw new Error(
      `$${notional} notional rounds to 0 ${coin} (size step ${Math.pow(10, -szDecimals)}) — raise --usd or --lev`,
    );
  }
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

// The "cut it loose" button: reduce-only IOC for the full size, opposite
// direction. Reads the live position from the tracked wallet, so there's
// nothing to fat-finger on air beyond approving the signature.
async function prepareClose(): Promise<void> {
  const wallet = (arg("wallet") ?? process.env.UNDERPOD_WALLET ?? "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(wallet)) {
    throw new Error("need the position's address: --wallet 0x… or UNDERPOD_WALLET in .env");
  }
  const coinArg = arg("coin");
  const slip = Number(arg("slippage") ?? 0.05);
  // HIP-3 coins are addressed "dex:COIN" — read that dex's clearinghouse.
  const dex = coinArg?.includes(":")
    ? coinArg.slice(0, coinArg.indexOf(":"))
    : (process.env.UNDERPOD_DEX ?? "").trim();
  const positions = await openPositions(wallet, dex);
  if (!positions.length) throw new Error(`no open position on ${wallet} (net=${NET})`);
  const pos = coinArg ? positions.find((p) => p.coin === coinArg) : positions[0];
  if (!pos) {
    throw new Error(`no open ${coinArg} position (open: ${positions.map((p) => p.coin).join(", ")})`);
  }
  const side = pos.szi < 0 ? "SHORT" : "LONG";
  const { assetId, szDecimals, markPx } = await assetInfo(pos.coin);
  const isBuy = pos.szi < 0; // closing a short buys it back
  const size = formatSize(Math.abs(pos.szi), szDecimals);
  const px = formatPrice(markPx * (isBuy ? 1 + slip : 1 - slip), szDecimals);
  const action = {
    type: "order",
    orders: [{ a: assetId, b: isBuy, p: px, s: size, r: true, t: { limit: { tif: "Ioc" } } }],
    grouping: "na",
  };
  console.log(
    `\n  CLOSE ${side} ${pos.coin}: size ${size} (entry ${pos.entryPx}, mark ${markPx})` +
      ` → reduce-only IOC ${px}`,
  );
  emitTypedData(`close ${side} ${pos.coin} ${size} @ ${px}`, action, Date.now());
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
    ? roll
    : cmd === "prepare-leverage"
      ? prepareLeverage
      : cmd === "prepare-order"
        ? prepareOrder
        : cmd === "prepare-close"
          ? prepareClose
          : cmd === "send"
            ? send
            : null;

if (!run) {
  console.error(
    `usage: npm run hl <roll|prepare-leverage|prepare-order|prepare-close|send> [...]\n` +
      `  net: ${NET}${IS_MAINNET ? "  ⚠️  MAINNET — real money" : "  (testnet)"}`,
  );
  process.exit(1);
}
run().catch((e) => {
  console.error(`error: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
