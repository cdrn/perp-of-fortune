// Paired episode operator. Planning reads public data; the binary is a
// Hyperliquid HIP-4 outcome order signed by sigil (prepare → sign → send),
// exactly like the perp. The dashboard never imports this file.
import "../src/config.js";
import { randomInt, randomUUID } from "node:crypto";
import { mkdirSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { agentTypedData, assetInfo, NET, postExchange, splitSig, validateLeverage } from "./hllib.js";
import { episodePath, positiveNumber, readEpisode, withEpisodeLock, writeEpisode, type Episode } from "../src/episode.js";
import {
  apiFor, balanceCoin, bookCoin, buildBuyAction, HLOutcomeClient, newCloid, parseExchangeResult,
  settlementFromFills, summariseFills, type BinaryMarket, type BinarySide,
} from "../src/hl-outcomes.js";
import { ENTRY_CEILING, ENTRY_FLOOR, maximumEntryCost, sizeBinaryOrder, sizeRestingOrder } from "../src/binary-order.js";

const { values: args, positionals } = parseArgs({ allowPositionals: true, options: {
  theme: { type: "string" }, coin: { type: "string" }, side: { type: "string" }, thesis: { type: "string" },
  start: { type: "string" }, "binary-side": { type: "string" }, "binary-budget": { type: "string" },
  "perp-margin": { type: "string" }, lev: { type: "string" }, limit: { type: "string" }, outcome: { type: "string" },
  confirm: { type: "string" }, sig: { type: "string" }, replace: { type: "boolean" }, rest: { type: "boolean" }, price: { type: "string" },
  watch: { type: "boolean" }, json: { type: "boolean" }, help: { type: "boolean" },
} });
const PREPARATION_MS = 120_000;
const UNFILLED_TERMINAL = /cancel|reject|expire|unfilled/i;
const HOLDINGS_MISMATCH = "Account holdings differ from this episode's fill receipt. P&L is unavailable until reconciled.";

const required = (name: keyof typeof args): string => {
  const value = args[name];
  if (typeof value !== "string" || !value.trim()) throw new Error(`--${name} is required`);
  return value.trim();
};
const current = (): Episode => {
  const e = readEpisode();
  if (!e) throw new Error("No episode selected. Run episode plan first.");
  return e;
};
const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));
const wallet = (): string => {
  const w = (process.env.UNDERPOD_WALLET ?? "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(w)) throw new Error("UNDERPOD_WALLET must be the trading account's address");
  return w;
};
// Signing hashes the network into the payload, so the operator must run on the episode's network.
const venue = (e: Episode) => {
  if (e.perpNetwork !== NET) throw new Error(`episode trades on ${e.perpNetwork}; rerun with HL_NET=${e.perpNetwork}`);
  return new HLOutcomeClient(apiFor(e.perpNetwork));
};

async function plan() {
  const theme = required("theme"), coin = required("coin"), thesis = required("thesis"), side = required("side");
  if (side !== "long" && side !== "short") throw new Error("--side must be long or short");
  const binarySide = args["binary-side"] ?? (randomInt(2) === 0 ? "up" : "down");
  if (binarySide !== "up" && binarySide !== "down") throw new Error("--binary-side must be up or down");
  const now = Date.now();
  const startsAt = args.start ? Date.parse(args.start) : Math.ceil(now / 3_600_000) * 3_600_000;
  if (!Number.isFinite(startsAt) || (args.start && !/(Z|[+-]\d\d:\d\d)$/.test(args.start))) throw new Error("--start must be an ISO date with timezone, e.g. 2026-10-02T20:00:00-07:00");
  if (startsAt % 3_600_000 !== 0) throw new Error("Episode start must match a full-hour boundary");
  const endsAt = startsAt + 3_600_000;
  if (endsAt <= now) throw new Error("That hour has already finished");
  const limitPrice = Number(args.limit ?? ENTRY_CEILING);
  const [asset, listed] = await Promise.all([assetInfo(coin), new HLOutcomeClient(apiFor(NET as Episode["perpNetwork"])).binariesAt(endsAt)]);
  const leverage = args.lev && args.lev !== "max" ? Number(args.lev) : asset.maxLeverage;
  validateLeverage(leverage, asset.maxLeverage);
  const e: Episode = {
    version: 1, id: randomUUID(), createdAt: now, theme, startsAt, endsAt,
    perpNetwork: NET as Episode["perpNetwork"],
    perp: { coin, side, leverage, marginUsd: positiveNumber(args["perp-margin"] ?? 50, "Perp margin"), thesis },
    binary: { side: binarySide, budgetUsd: positiveNumber(args["binary-budget"] ?? 50, "Binary budget"), limitPrice },
  };
  await withEpisodeLock(async () => {
    const existing = readEpisode();
    if (existing) {
      if (!args.replace) throw new Error("An episode already exists. Use --replace to archive it and select another pair.");
      if (["sending", "uncertain"].includes(existing.binary.prepared?.state ?? "")) throw new Error("Reconcile the uncertain binary submission before replacing the episode");
      if ((existing.binary.order?.filledShares ?? 0) > 0) {
        // A reconciliation error already withholds P&L; after cutoff it must not
        // also strand the operator, so the episode is archived as-is for review.
        const withheld = !!existing.binary.reconciliationError && Date.now() >= existing.endsAt;
        if (!existing.binary.finalSettlement && !withheld) throw new Error("Confirm the current episode's account settlement (sync-binary) before replacing it");
      }
      const archive = join(dirname(episodePath()), "underpod-episodes");
      mkdirSync(archive, { recursive: true, mode: 0o700 });
      copyFileSync(episodePath(), join(archive, `${existing.id}.json`));
    }
    writeEpisode(e);
  });
  if (args.json) return print(e);
  const strikes = listed.map((m) => `$${m.threshold.toLocaleString("en-US")} (${m.official ? "Hyperliquid" : m.deployer})`).join(", ");
  console.log(`Episode ${e.id}\n${theme}\nBTC ${binarySide.toUpperCase()} · Hyperliquid outcome · up to $${e.binary.budgetUsd}, entry ${ENTRY_FLOOR.toFixed(2)}–${limitPrice.toFixed(2)}\n${side.toUpperCase()} ${coin} · ${leverage}× isolated · $${e.perp.marginUsd} margin · ${NET}\n${new Date(startsAt).toISOString()} → ${new Date(endsAt).toISOString()}\n${thesis}\n\nBTC binaries listed for that cutoff so far: ${strikes || "none yet"}. The strike is chosen at entry.\nBoth picks saved; no orders submitted.\nFrom 5 minutes before the hour: HL_NET=${NET} npm run episode -- prepare-binary\nPerp: HL_NET=${NET} npm run hl -- prepare-leverage --episode, sign/send, then prepare-order --episode`);
}

interface Candidate { market: BinaryMarket; shares: number; buyPrice: number; depth: number }

async function prepare() {
  await withEpisodeLock(async () => {
    const e = current(), b = e.binary, hl = venue(e), user = wallet();
    // An IOC that found no liquidity is over: record it and allow a fresh preparation.
    if (b.order && b.order.filledShares === 0 && UNFILLED_TERMINAL.test(b.order.status) && b.prepared?.state === "submitted") {
      b.attempts = [...b.attempts ?? [], { orderId: b.order.id, cloid: b.prepared.cloid, preparedAt: b.prepared.preparedAt, outcome: "unfilled" }];
      delete b.order; delete b.prepared; delete b.reconciliationError; delete b.positionCheckedAt;
    }
    if (b.order || b.prepared && b.prepared.state !== "prepared") throw new Error("This episode already has an order/submission; reconcile it instead of preparing a duplicate");
    let markets = await hl.binariesAt(e.endsAt);
    if (args.outcome) markets = markets.filter((m) => m.outcome === Number(args.outcome));
    if (!markets.length) throw new Error(args.outcome ? `Outcome ${args.outcome} is not a BTC binary expiring at this episode's cutoff` : "No BTC binary is listed for this episode's cutoff yet");
    const candidates: Candidate[] = [], skipped: string[] = [];
    // --rest: nobody is offering, so post a bid at --price on one named market and wait for a seller.
    const resting = args.rest === true;
    if (resting && (!args.outcome || !args.price)) throw new Error("--rest needs --outcome N and --price P");
    const restPrice = Number(args.price);
    if (resting) candidates.push({ market: markets[0]!, shares: sizeRestingOrder(e, b.budgetUsd, restPrice, b.limitPrice), buyPrice: restPrice, depth: 0 });
    for (const market of resting ? [] : markets) {
      try {
        const quote = await hl.getQuote(market.outcome, b.side);
        const shares = sizeBinaryOrder(e, quote, b.budgetUsd, b.limitPrice);
        candidates.push({ market, shares, buyPrice: quote.buyPrice!, depth: quote.availableShares });
      } catch (err) {
        skipped.push(`  #${market.outcome} $${market.threshold}: ${err instanceof Error ? err.message : err}`);
      }
    }
    // The closest to a coin flip makes the best hour; depth breaks ties.
    candidates.sort((x, y) => Math.abs(x.buyPrice - 0.5) - Math.abs(y.buyPrice - 0.5) || y.depth - x.depth);
    const pick = candidates[0];
    if (!pick) throw new Error(`No listed BTC binary for this cutoff is enterable right now:\n${skipped.join("\n")}`);
    const balances = await hl.spotBalances(user);
    for (const side of ["up", "down"] as BinarySide[]) {
      if ((balances.get(balanceCoin(pick.market.outcome, side))?.total ?? 0) !== 0) throw new Error("The account already holds this outcome; use a separate market or account");
    }
    const usdc = balances.get("USDC");
    const orderPrice = resting ? restPrice : b.limitPrice;
    const maxCost = maximumEntryCost(pick.shares, orderPrice);
    if (!usdc || usdc.total - usdc.hold < maxCost) {
      throw new Error(`Spot USDC ${usdc ? (usdc.total - usdc.hold).toFixed(2) : "0.00"} is below the $${maxCost.toFixed(2)} maximum cost. Move it from perp margin first:\n  HL_NET=${NET} npx tsx scripts/xfer.ts prepare --dex spot --amount ${Math.ceil(maxCost)}`);
    }
    const cloid = newCloid(), nonce = Date.now();
    const action = buildBuyAction({ outcome: pick.market.outcome, side: b.side, shares: pick.shares, limitPrice: orderPrice, cloid, tif: resting ? "Gtc" : "Ioc" });
    b.market = pick.market;
    b.prepared = { outcome: pick.market.outcome, shares: pick.shares, limitPrice: orderPrice, preparedAt: nonce, expiresAt: Math.min(nonce + PREPARATION_MS, e.endsAt), state: "prepared", cloid, action, nonce };
    writeEpisode(e);
    print({
      episodeId: e.id, market: pick.market.title, outcome: pick.market.outcome, deployer: pick.market.official ? "Hyperliquid" : pick.market.deployer,
      resolves: pick.market.priceSource, side: b.side === "up" ? "YES (up)" : "NO (down)", bestAsk: pick.buyPrice, shares: pick.shares,
      order: resting ? `resting bid at ${restPrice}` : `IOC up to ${b.limitPrice}`, maximumCost: maxCost, budgetUsd: b.budgetUsd, expiresAt: new Date(b.prepared.expiresAt).toISOString(),
      ...(skipped.length ? { skipped } : {}),
    });
    console.log(`\n  ── sign with sigil_eth_sign_typed_data (portal = the trading key) ──\n`);
    console.log(JSON.stringify(agentTypedData(action, nonce, null), null, 2));
    console.log(`\n  then: HL_NET=${NET} npm run episode -- send-binary --sig 0x<signature>\n`);
  });
}

async function send() {
  const sig = required("sig");
  await withEpisodeLock(async () => {
    const e = current(), b = e.binary, p = b.prepared, hl = venue(e);
    if (!p || p.state !== "prepared" || b.order || !b.market) throw new Error("No fresh, unsubmitted binary preparation; reconcile an existing send or prepare again");
    if (Date.now() >= p.expiresAt) throw new Error("Binary preparation expired; prepare again");
    if (p.action.orders[0].t.limit.tif === "Gtc") sizeRestingOrder(e, b.budgetUsd, p.limitPrice, b.limitPrice);
    else {
      const quote = await hl.getQuote(p.outcome, b.side);
      if (sizeBinaryOrder(e, quote, b.budgetUsd, p.limitPrice) < p.shares) throw new Error("Binary depth or price changed; prepare again");
    }
    p.state = "sending";
    writeEpisode(e); // Durable before POST: an ambiguous send is reconciled by client order id.
    let body: unknown;
    try {
      body = await postExchange(p.action, p.nonce, splitSig(sig), null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A 4xx is the exchange refusing the request (bad signature, malformed), so no order exists.
      if (/^\/exchange 4\d\d/.test(message)) {
        b.attempts = [...b.attempts ?? [], { cloid: p.cloid, preparedAt: p.preparedAt, outcome: "rejected" }];
        delete b.prepared;
        writeEpisode(e);
        throw new Error(`Hyperliquid rejected the binary order; nothing was submitted. ${message}`);
      }
      p.state = "uncertain";
      writeEpisode(e);
      throw new Error(`Binary submission needs reconciliation; do not prepare a new order. Run sync-binary (it looks the order up by client id ${p.cloid}), or abandon-binary after two minutes if it never landed. ${message}`);
    }
    const result = parseExchangeResult(body);
    if (result.kind === "rejected" || result.kind === "unfilled") {
      b.attempts = [...b.attempts ?? [], { cloid: p.cloid, preparedAt: p.preparedAt, outcome: result.kind }];
      delete b.prepared;
      writeEpisode(e);
      throw new Error(result.kind === "unfilled"
        ? `The IOC found no liquidity at or below $${p.limitPrice}; nothing filled. Prepare again. (${result.message})`
        : `Hyperliquid rejected the binary order; nothing was submitted. ${result.message}`);
    }
    p.state = "submitted"; p.orderId = String(result.oid);
    const filledShares = result.kind === "filled" ? result.filledShares : 0;
    const averagePrice = result.kind === "filled" && filledShares > 0 ? result.averagePrice : null;
    b.order = {
      id: String(result.oid), outcome: p.outcome, side: b.side, filledShares, averagePrice,
      totalCostUsd: averagePrice === null ? 0 : Math.round(filledShares * averagePrice * 1e8) / 1e8,
      // Opening fills pay no fee; sync-binary confirms from the account's fills.
      feesUsd: null, status: result.kind === "filled" ? filledShares >= p.shares ? "filled" : "partially filled" : "resting", updatedAt: Date.now(),
    };
    writeEpisode(e);
    print({ episodeId: e.id, order: b.order, next: "npm run episode -- sync-binary" });
  });
}

async function syncOnce() {
  await withEpisodeLock(async () => {
    const e = current(), b = e.binary, p = b.prepared, hl = venue(e), user = wallet();
    if (!p || !b.market) throw new Error("No binary order to reconcile");
    const status = await hl.orderStatus(user, p.cloid);
    if (!status) {
      if (p.state === "submitted") throw new Error("Hyperliquid does not know this episode's order; check the account");
      return print({ episodeId: e.id, found: false, note: "Order not found by client id. If it stays missing two minutes after the send, run abandon-binary." });
    }
    const order = status.order as Record<string, unknown> | undefined;
    const oid = Number(order?.oid);
    if (!order || !Number.isInteger(oid) || order.coin !== bookCoin(p.outcome, b.side) || order.side !== "B"
      || Number(order.origSz) !== p.shares || Number(order.limitPx) !== p.limitPrice || order.cloid !== p.cloid) {
      throw new Error("The order found by client id does not match the prepared binary order");
    }
    if (b.attempts?.some((a) => a.orderId === String(oid))) throw new Error("That order belongs to an earlier attempt for this episode");
    const coin = bookCoin(p.outcome, b.side);
    const fills = await hl.fills(user, p.preparedAt - 60_000);
    const bought = summariseFills(fills, coin, oid);
    const terminal = /filled|canceled|rejected/i.test(String(status.status));
    b.order = {
      id: String(oid), outcome: p.outcome, side: b.side, filledShares: bought.shares, averagePrice: bought.averagePrice,
      totalCostUsd: bought.costUsd, feesUsd: bought.count || terminal ? bought.feesUsd : null,
      status: bought.shares === 0 && terminal ? "unfilled" : String(status.status), updatedAt: Date.now(),
    };
    p.state = "submitted"; p.orderId = String(oid);
    const holdings = await hl.holdings(user, p.outcome, b.side);
    const settleFraction = Date.now() >= e.endsAt ? await hl.getSettlement(p.outcome) : null;
    const settled = settlementFromFills(fills, coin);
    if (settleFraction !== null && settled && !b.finalSettlement) {
      if (Math.abs(settled.shares - bought.shares) > 1e-8 || b.reconciliationError) {
        b.reconciliationError = "Settled account holdings do not match the episode receipt; review the account fills before attributing P&L.";
      } else {
        b.finalSettlement = { shares: settled.shares, yesValue: settleFraction, payoutUsd: settled.payoutUsd, verifiedAt: Date.now() };
      }
    } else if (settleFraction === null && Date.now() < e.endsAt) {
      // Reflect the latest read: a race between reads heals on the next poll,
      // while a real difference at cutoff still sticks.
      if (Math.abs(holdings - bought.shares) > 1e-8) b.reconciliationError = HOLDINGS_MISMATCH;
      else if (b.reconciliationError === HOLDINGS_MISMATCH) delete b.reconciliationError;
    }
    b.positionCheckedAt = Date.now();
    writeEpisode(e);
    print({ episodeId: e.id, order: b.order, holdings, reconciliationError: b.reconciliationError ?? null, settleFraction, finalSettlement: b.finalSettlement ?? null });
  });
}

// Clears an uncertain or crashed send only once Hyperliquid proves no order
// landed: past the send window, the client id is unknown and nothing is held.
async function abandon() {
  await withEpisodeLock(async () => {
    const e = current(), b = e.binary, p = b.prepared, hl = venue(e), user = wallet();
    if (args.confirm !== e.id) throw new Error("Pass --confirm with the exact episode ID to abandon the uncertain submission");
    if (!p || !["uncertain", "sending"].includes(p.state) || p.orderId || b.order) throw new Error("Only an uncertain submission without an order can be abandoned; use sync-binary otherwise");
    if (Date.now() < p.preparedAt + PREPARATION_MS) throw new Error("Wait two minutes after preparing before abandoning, so an in-flight order can land first");
    if (await hl.orderStatus(user, p.cloid)) throw new Error("Hyperliquid has this order; run sync-binary instead");
    if (await hl.holdings(user, p.outcome, b.side) !== 0) throw new Error("The account holds this outcome; run sync-binary instead");
    b.attempts = [...b.attempts ?? [], { cloid: p.cloid, preparedAt: p.preparedAt, outcome: "abandoned" }];
    delete b.prepared;
    writeEpisode(e);
    print({ episodeId: e.id, abandoned: true, next: "npm run episode -- prepare-binary" });
  });
}

const usage = `Paired episode: one hourly BTC binary + one thematic perp, both on Hyperliquid.

  HL_NET=mainnet npm run episode -- plan --theme "Episode theme" --coin SOL --side long --thesis "Why this perp fits" --binary-side up --start 2026-10-02T20:00:00-07:00
  npm run episode -- show
  HL_NET=mainnet npm run episode -- prepare-binary [--outcome N]      (from 5 minutes before the hour)
  # sign the printed typed data with sigil
  HL_NET=mainnet npm run episode -- send-binary --sig 0x…
  HL_NET=mainnet npm run episode -- sync-binary [--watch]
  HL_NET=mainnet npm run episode -- abandon-binary --confirm EPISODE_ID  (uncertain send that never landed)

Budgets default to $50 per leg. --lev defaults to the perp's venue maximum. The binary buys whole YES (up) or NO (down)
shares with an IOC at --limit (default $0.60); entries quoted below $0.40 are rejected. It pays from spot USDC, so move
margin to spot first (scripts/xfer.ts --dex spot). plan and show place no trades.`;

async function main() {
  if (args.help) return console.log(usage);
  const command = positionals[0] ?? "show";
  if (command === "plan") return plan();
  if (command === "show") return print(current());
  if (command === "prepare-binary") return prepare();
  if (command === "send-binary") return send();
  if (command === "abandon-binary") return abandon();
  if (command === "sync-binary") {
    if (!args.watch) return syncOnce();
    // Watching runs through the show: one failed poll must not end it.
    for (;;) {
      try { await syncOnce(); } catch (e) { console.error(`sync failed, retrying: ${e instanceof Error ? e.message : e}`); }
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  throw new Error(usage);
}
main().catch((e) => { console.error(e instanceof Error ? e.message : "Episode command failed"); process.exitCode = 1; });
