// Paired episode operator. Public planning; private preview/send/reconciliation.
// The dashboard never imports this file and never submits orders.
import "../src/config.js";
import { randomInt, randomUUID } from "node:crypto";
import { mkdirSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { assetInfo, NET, validateLeverage } from "./hllib.js";
import { episodePath, positiveNumber, readEpisode, withEpisodeLock, writeEpisode, type Episode } from "../src/episode.js";
import { PolymarketUSClient, buildBuyOrder, normalizeOrder, normalizePosition } from "../src/polymarket-us.js";
import { maximumEntryCost, sizeBinaryOrder, verifyPreview } from "../src/binary-order.js";

const { values: args, positionals } = parseArgs({ allowPositionals: true, options: {
  theme: { type: "string" }, coin: { type: "string" }, side: { type: "string" }, thesis: { type: "string" },
  start: { type: "string" }, "binary-side": { type: "string" }, "binary-budget": { type: "string" },
  "perp-margin": { type: "string" }, lev: { type: "string" }, limit: { type: "string" },
  confirm: { type: "string" }, "order-id": { type: "string" }, replace: { type: "boolean" },
  watch: { type: "boolean" }, json: { type: "boolean" }, help: { type: "boolean" },
} });
const client = new PolymarketUSClient();
const privateClient = () => {
  if (!process.env.PM_US_API_KEY || !process.env.PM_US_SECRET_KEY) throw new Error("Set PM_US_API_KEY and PM_US_SECRET_KEY in the operator environment; no order has been submitted");
  return new PolymarketUSClient({ keyId: process.env.PM_US_API_KEY, secretKey: process.env.PM_US_SECRET_KEY });
};
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

async function plan() {
  const theme = required("theme"), coin = required("coin"), thesis = required("thesis"), side = required("side");
  if (side !== "long" && side !== "short") throw new Error("--side must be long or short");
  const binarySide = args["binary-side"] ?? (randomInt(2) === 0 ? "up" : "down");
  if (binarySide !== "up" && binarySide !== "down") throw new Error("--binary-side must be up or down");
  const now = Date.now();
  const startsAt = args.start ? Date.parse(args.start) : Math.ceil(now / 3_600_000) * 3_600_000;
  if (!Number.isFinite(startsAt) || (args.start && !/(Z|[+-]\d\d:\d\d)$/.test(args.start))) throw new Error("--start must be an ISO date with timezone, e.g. 2026-10-02T20:00:00-07:00");
  if (startsAt % 3_600_000 !== 0) throw new Error("Episode start must match a full-hour boundary");
  const [asset, market] = await Promise.all([
    assetInfo(coin), client.discoverHourlyBitcoin({ episodeStart: startsAt, targetEnd: startsAt + 3_600_000, allowUpcoming: true }),
  ]);
  const leverage = args.lev && args.lev !== "max" ? Number(args.lev) : asset.maxLeverage;
  validateLeverage(leverage, asset.maxLeverage);
  const e: Episode = {
    version: 1, id: randomUUID(), createdAt: now, theme, startsAt, endsAt: market.endsAt,
    perpNetwork: NET as Episode["perpNetwork"],
    perp: { coin, side, leverage, marginUsd: positiveNumber(args["perp-margin"] ?? 50, "Perp margin"), thesis },
    binary: { market, side: binarySide, budgetUsd: positiveNumber(args["binary-budget"] ?? 50, "Binary budget"), limitPrice: Number(args.limit ?? 0.6) },
  };
  await withEpisodeLock(async () => {
    const existing = readEpisode();
    if (existing) {
      if (!args.replace) throw new Error("An episode already exists. Use --replace to archive it and select another pair.");
      if (["sending", "uncertain"].includes(existing.binary.prepared?.state ?? "")) throw new Error("Reconcile the uncertain binary submission before replacing the episode");
      if (existing.binary.prepared?.state === "submitted" && (!existing.binary.order || !/FILLED|CANCELED|CANCELLED|REJECTED|EXPIRED/.test(existing.binary.order.status))) throw new Error("Reconcile the submitted binary order to a terminal state before replacing the episode");
      if ((existing.binary.order?.filledShares ?? 0) > 0 && !existing.binary.finalSettlement) throw new Error("Confirm the current episode's account settlement before replacing it");
      if (Date.now() < existing.endsAt && (existing.binary.order?.filledShares ?? 0) > 0) throw new Error("The current binary has filled shares; finish this episode before replacing it");
      const archive = join(dirname(episodePath()), "underpod-episodes");
      mkdirSync(archive, { recursive: true, mode: 0o700 });
      copyFileSync(episodePath(), join(archive, `${existing.id}.json`));
    }
    writeEpisode(e);
  });
  if (args.json) return print(e);
  console.log(`Episode ${e.id}\n${theme}\nBTC ${binarySide.toUpperCase()} · Polymarket US · up to $${e.binary.budgetUsd} including entry fees\n${side.toUpperCase()} ${coin} · ${leverage}× isolated · $${e.perp.marginUsd} margin · ${NET}\n${new Date(startsAt).toISOString()} → ${new Date(e.endsAt).toISOString()}\n${thesis}\n\nBoth picks saved; no orders submitted.\nNext: npm run episode -- prepare-binary\nPerp: HL_NET=${NET} npm run hl -- prepare-leverage --episode\nThen sign/send, followed by: HL_NET=${NET} npm run hl -- prepare-order --episode`);
}

async function prepare() {
  const auth = privateClient();
  await withEpisodeLock(async () => {
    const e = current(), b = e.binary;
    if (b.order || b.prepared && b.prepared.state !== "prepared") throw new Error("This episode already has an order/submission; reconcile it instead of preparing a duplicate");
    const market = await client.discoverHourlyBitcoin({ episodeStart: e.startsAt, targetEnd: e.endsAt });
    if (market.slug !== b.market.slug) throw new Error("Binary listing changed; review a new episode plan");
    const quote = await client.getQuote(market.slug, b.side);
    const shares = sizeBinaryOrder(market, quote, b.budgetUsd, b.limitPrice);
    const holdings = normalizePosition(await auth.getPositions(market.slug), market.slug, b.side);
    if (holdings.shares !== 0) throw new Error("This binary market already has an account position; use a separate episode market/account");
    const request = buildBuyOrder({ marketSlug: market.slug, side: b.side, shares, maxPrice: b.limitPrice, priceTick: market.priceTick, minimumShares: market.minimumShares });
    verifyPreview(await auth.previewOrder(request), request, b.budgetUsd, market.feeCoefficient!);
    b.market = market;
    b.prepared = { shares, limitPrice: b.limitPrice, preparedAt: Date.now(), expiresAt: Math.min(Date.now() + 60_000, market.endsAt), state: "prepared" };
    writeEpisode(e);
    print({ episodeId: e.id, market: market.title, side: b.side, shares, maximumEntryPrice: b.limitPrice,
      maximumCostIncludingFee: maximumEntryCost(shares, b.limitPrice, market.feeCoefficient!), budgetUsd: b.budgetUsd,
      expiresAt: new Date(b.prepared.expiresAt).toISOString(), next: `npm run episode -- send-binary --confirm ${e.id}` });
  });
}

async function send() {
  const auth = privateClient();
  await withEpisodeLock(async () => {
    const e = current(), b = e.binary, p = b.prepared;
    if (args.confirm !== e.id) throw new Error("Review prepare-binary, then pass --confirm with the exact episode ID");
    if (!p || p.state !== "prepared" || b.order || Date.now() >= p.expiresAt) throw new Error("No fresh, unsubmitted binary preparation; reconcile an existing send or prepare again");
    const market = await client.discoverHourlyBitcoin({ episodeStart: e.startsAt, targetEnd: e.endsAt });
    if (market.slug !== b.market.slug) throw new Error("Binary market no longer matches the prepared episode");
    const quote = await client.getQuote(market.slug, b.side);
    if (sizeBinaryOrder(market, quote, b.budgetUsd, p.limitPrice) < p.shares) throw new Error("Binary depth or costs changed; prepare again");
    if (normalizePosition(await auth.getPositions(market.slug), market.slug, b.side).shares !== 0) throw new Error("Binary account position changed since preview");
    const request = buildBuyOrder({ marketSlug: market.slug, side: b.side, shares: p.shares, maxPrice: p.limitPrice, priceTick: market.priceTick, minimumShares: market.minimumShares });
    verifyPreview(await auth.previewOrder(request), request, b.budgetUsd, market.feeCoefficient!);
    if (Date.now() >= p.expiresAt || Date.now() >= market.endsAt) throw new Error("Binary preparation expired during the final checks; prepare again");
    if (Date.now() - quote.updatedAt > 15_000) throw new Error("The binary quote expired during preview; prepare again");
    p.state = "sending";
    writeEpisode(e); // Durable before POST: never retry an ambiguous submission.
    try {
      const response = await auth.createOrder(request);
      if (!response.id) throw new Error("Venue did not return an order ID");
      p.orderId = response.id; p.state = "submitted"; writeEpisode(e);
      const receipt = normalizeOrder(await auth.getOrder(response.id), b.side);
      if (receipt.id !== response.id || receipt.marketSlug !== market.slug) throw new Error("Received a different binary order");
      b.order = { ...receipt, updatedAt: Date.now() };
      writeEpisode(e);
      print({ episodeId: e.id, order: b.order, next: "npm run episode -- sync-binary --watch" });
    } catch (error) {
      if (!p.orderId) p.state = "uncertain";
      writeEpisode(e);
      throw new Error(`Binary submission needs reconciliation; do not resend. ${p.orderId ? `Order ID: ${p.orderId}. ` : "Find the order in Polymarket US and run sync-binary --order-id ID. "}${error instanceof Error ? error.message : "Unknown submission result"}`);
    }
  });
}

async function syncOnce() {
  const auth = privateClient();
  await withEpisodeLock(async () => {
    const e = current(), b = e.binary;
    const id = args["order-id"] ?? b.order?.id ?? b.prepared?.orderId;
    if (!id) throw new Error("No binary order ID. Recover it from Polymarket US and pass --order-id; do not resubmit an uncertain order.");
    const knownId = b.order?.id ?? b.prepared?.orderId;
    if (knownId && knownId !== id) throw new Error("The provided order ID conflicts with the episode's known order");
    const orderResponse = await auth.getOrder(id);
    const receipt = normalizeOrder(orderResponse, b.side);
    if (receipt.id !== id || receipt.marketSlug !== b.market.slug) throw new Error("Order ID does not match the selected Bitcoin market");
    if (!b.prepared || receipt.filledShares > b.prepared.shares + 1e-8 || receipt.averagePrice !== null && receipt.averagePrice > b.prepared.limitPrice + 1e-8) throw new Error("Order does not match the prepared share/price limits");
    const expected = buildBuyOrder({ marketSlug: b.market.slug, side: b.side, shares: b.prepared.shares, maxPrice: b.prepared.limitPrice, priceTick: b.market.priceTick, minimumShares: b.market.minimumShares });
    if (orderResponse.order.quantity !== expected.quantity || orderResponse.order.price?.currency !== "USD" || Number(orderResponse.order.price.value) !== Number(expected.price.value)) throw new Error("Recovered order differs from the prepared request");
    const settlement = Date.now() >= e.endsAt ? await client.getSettlement(b.market.slug) : null;
    const holdings = normalizePosition(await auth.getPositions(b.market.slug), b.market.slug, b.side);
    // A resolved public market is not proof that this account held the original
    // shares to settlement. Require the account's position-resolution event.
    if (settlement !== null && !b.finalSettlement) {
      const activities = await auth.getActivities(b.market.slug);
      const resolution = activities.activities.map((a) => a.positionResolution).find((r) => r?.marketSlug === b.market.slug && r.beforePosition);
      if (resolution?.beforePosition) {
        const settledShares = normalizePosition({ positions: { [b.market.slug]: resolution.beforePosition }, eof: true }, b.market.slug, b.side).shares;
        if (Math.abs(settledShares - receipt.filledShares) > 1e-8 || b.reconciliationError) {
          b.reconciliationError = "Settled account holdings do not match the episode receipt; review the account activity before attributing P&L.";
        } else {
          b.finalSettlement = { shares: settledShares, yesValue: settlement, payoutUsd: settledShares * (b.side === "up" ? settlement : 1 - settlement), verifiedAt: Date.now() };
        }
      }
    } else if (settlement === null && Date.now() < e.endsAt && Math.abs(holdings.shares - receipt.filledShares) > 1e-8) {
      b.reconciliationError = "Account holdings differ from this episode's fill receipt. P&L is unavailable until reconciled.";
    }
    // After cutoff, account clearing can remove inventory before the public
    // gateway publishes the result. Await the position-resolution record above
    // instead of turning that normal sequencing into a permanent mismatch.
    // Any mismatch actually observed during trading remains disqualifying.
    b.order = { ...receipt, updatedAt: Date.now() };
    b.positionCheckedAt = Date.now();
    b.prepared.state = "submitted"; b.prepared.orderId = id;
    writeEpisode(e);
    print({ episodeId: e.id, order: b.order, reconciliationError: b.reconciliationError ?? null, resolved: settlement !== null });
  });
}

const usage = `Paired episode: one hourly BTC binary + one thematic perp.\n\n  npm run episode -- plan --theme "Episode theme" --coin SOL --side long --thesis "Why this perp fits" --binary-side up --start 2026-10-02T20:00:00-07:00\n  npm run episode -- show\n  npm run episode -- prepare-binary\n  npm run episode -- send-binary --confirm EPISODE_ID\n  npm run episode -- sync-binary --watch\n\nPlanning is public/read-only. Binary execution requires PM_US_API_KEY and PM_US_SECRET_KEY in the operator environment. Polymarket US is real money; Hyperliquid defaults to testnet. Budgets default to $50 per leg; --binary-budget includes entry fees. --lev defaults to the perp's venue maximum. Binary limit defaults to $0.60; entries below $0.40 are rejected. No trade is placed by plan or show.`;

async function main() {
  if (args.help) return console.log(usage);
  const command = positionals[0] ?? "show";
  if (command === "plan") return plan();
  if (command === "show") return print(current());
  if (command === "prepare-binary") return prepare();
  if (command === "send-binary") return send();
  if (command === "sync-binary") {
    do {
      await syncOnce();
      if (args.watch) await new Promise((r) => setTimeout(r, 5000));
    } while (args.watch);
    return;
  }
  throw new Error(usage);
}
main().catch((e) => { console.error(e instanceof Error ? e.message : "Episode command failed"); process.exitCode = 1; });
