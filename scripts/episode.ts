// Paired episode operator. Public planning; private preview/send/reconciliation.
// The dashboard never imports this file and never submits orders.
import "../src/config.js";
import { randomInt, randomUUID } from "node:crypto";
import { mkdirSync, copyFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { assetInfo, NET, validateLeverage } from "./hllib.js";
import { episodePath, positiveNumber, readEpisode, withEpisodeLock, writeEpisode, type Episode } from "../src/episode.js";
import { binaryMarketData, binaryOperator, parseVenue, venueLabel } from "../src/binary-venue.js";
import type { BinaryVenueId } from "../src/binary-types.js";
import { sizeBinaryOrder } from "../src/binary-order.js";

const { values: args, positionals } = parseArgs({ allowPositionals: true, options: {
  theme: { type: "string" }, coin: { type: "string" }, side: { type: "string" }, thesis: { type: "string" },
  start: { type: "string" }, "binary-side": { type: "string" }, "binary-budget": { type: "string" },
  "perp-margin": { type: "string" }, lev: { type: "string" }, limit: { type: "string" },
  venue: { type: "string" }, confirm: { type: "string" }, "order-id": { type: "string" }, replace: { type: "boolean" },
  watch: { type: "boolean" }, json: { type: "boolean" }, help: { type: "boolean" },
} });
// Operator-only credentials file, outside the repo and never read by the dashboard:
// ${XDG_CONFIG_HOME:-~/.config}/perp-of-fortune/operator.env (KALSHI_* / PM_US_* lines only).
// Real environment variables win.
try {
  const file = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "perp-of-fortune", "operator.env");
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*((?:KALSHI|PM_US)_[A-Z0-9_]+)\s*=\s*("?)(.*?)\2\s*$/);
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[3]!;
  }
} catch {}
// Public market data per venue; credentials are read only inside binaryOperator().
const publicData = (venue: BinaryVenueId) => binaryMarketData(venue);
const privateClient = (venue: BinaryVenueId) => binaryOperator(venue, process.env);
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
// Venue order states, any case: Polymarket US (ORDER_STATE_FILLED…) and Kalshi (executed, canceled…).
const TERMINAL = /fill|execut|cancel|reject|expire|unfilled/i;
const UNFILLED_TERMINAL = /cancel|reject|expire|unfilled/i;
const HOLDINGS_MISMATCH = "Account holdings differ from this episode's fill receipt. P&L is unavailable until reconciled.";
/** A 4xx (other than timeout/conflict) means the venue refused the request: no order exists. */
const definitelyRejected = (error: unknown): number | null => {
  const status = (error as { status?: unknown } | null)?.status;
  return error instanceof Error && /HttpError$/.test(error.name) && typeof status === "number" && status >= 400 && status < 500 && status !== 408 && status !== 409 ? status : null;
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
  const venue = parseVenue(args.venue);
  const [asset, market] = await Promise.all([
    assetInfo(coin), publicData(venue).discoverHourlyBitcoin({ episodeStart: startsAt, targetEnd: startsAt + 3_600_000, allowUpcoming: true, side: binarySide }),
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
      if (existing.binary.prepared?.state === "submitted" && (!existing.binary.order || !TERMINAL.test(existing.binary.order.status))) throw new Error("Reconcile the submitted binary order to a terminal state before replacing the episode");
      // A reconciliation error already withholds P&L; after cutoff it must not
      // also strand the operator, so the episode is archived as-is for review.
      const withheld = !!existing.binary.reconciliationError && Date.now() >= existing.endsAt;
      if ((existing.binary.order?.filledShares ?? 0) > 0 && !existing.binary.finalSettlement && !withheld) throw new Error("Confirm the current episode's account settlement before replacing it");
      if (Date.now() < existing.endsAt && (existing.binary.order?.filledShares ?? 0) > 0) throw new Error("The current binary has filled shares; finish this episode before replacing it");
      const archive = join(dirname(episodePath()), "underpod-episodes");
      mkdirSync(archive, { recursive: true, mode: 0o700 });
      copyFileSync(episodePath(), join(archive, `${existing.id}.json`));
    }
    writeEpisode(e);
  });
  if (args.json) return print(e);
  const strike = market.priceToBeat !== null && venue !== "polymarket-us" ? ` · strike $${market.priceToBeat.toLocaleString("en-US")} (re-selected nearest 50¢ at prepare)` : "";
  console.log(`Episode ${e.id}\n${theme}\nBTC ${binarySide.toUpperCase()} · ${venueLabel(venue)}${strike} · up to $${e.binary.budgetUsd} including entry fees\n${side.toUpperCase()} ${coin} · ${leverage}× isolated · $${e.perp.marginUsd} margin · ${NET}\n${new Date(startsAt).toISOString()} → ${new Date(e.endsAt).toISOString()}\n${thesis}\n\nBoth picks saved; no orders submitted.\nNext: npm run episode -- prepare-binary\nPerp: HL_NET=${NET} npm run hl -- prepare-leverage --episode\nThen sign/send, followed by: HL_NET=${NET} npm run hl -- prepare-order --episode`);
}

async function prepare() {
  await withEpisodeLock(async () => {
    const e = current(), b = e.binary, venue = b.market.venue;
    const auth = privateClient(venue), data = publicData(venue);
    // An IOC that found no liquidity is over: record it and allow a fresh preparation.
    if (b.order && b.order.filledShares === 0 && UNFILLED_TERMINAL.test(b.order.status) && b.prepared?.state === "submitted") {
      b.attempts = [...b.attempts ?? [], { orderId: b.order.id, clientOrderId: b.prepared.clientOrderId, preparedAt: b.prepared.preparedAt, outcome: "unfilled" }];
      delete b.order; delete b.prepared; delete b.reconciliationError; delete b.positionCheckedAt;
    }
    if (b.order || b.prepared && b.prepared.state !== "prepared") throw new Error("This episode already has an order/submission; reconcile it instead of preparing a duplicate");
    // Re-discover inside the same hourly event. Polymarket US has one contract per hour, so the slug
    // cannot change; Kalshi strike ladders re-select the strike quoted nearest 50 cents right now.
    const market = await data.discoverHourlyBitcoin({ episodeStart: e.startsAt, targetEnd: e.endsAt, side: b.side });
    if (market.eventSlug !== b.market.eventSlug || market.endsAt !== b.market.endsAt) throw new Error("Binary listing changed; review a new episode plan");
    const quote = await data.getQuote(market.slug, b.side);
    const shares = sizeBinaryOrder(market, quote, b.budgetUsd, b.limitPrice);
    if (await auth.getHoldings(market, b.side) !== 0) throw new Error("This binary market already has an account position; use a separate episode market/account");
    const prepared = await auth.prepareOrder(market, b.side, shares, b.limitPrice, b.budgetUsd);
    b.market = market;
    b.prepared = { shares, limitPrice: b.limitPrice, preparedAt: Date.now(), expiresAt: Math.min(Date.now() + 60_000, market.endsAt), state: "prepared" };
    writeEpisode(e);
    print({ episodeId: e.id, venue: venueLabel(venue), market: market.title, contract: market.slug, side: b.side, shares, maximumEntryPrice: b.limitPrice,
      quotedEntryPrice: quote.buyPrice, maximumCostIncludingFee: prepared.maximumCostUsd, budgetUsd: b.budgetUsd,
      expiresAt: new Date(b.prepared.expiresAt).toISOString(), next: `npm run episode -- send-binary --confirm ${e.id}` });
  });
}

async function send() {
  await withEpisodeLock(async () => {
    const e = current(), b = e.binary, p = b.prepared, venue = b.market.venue;
    const auth = privateClient(venue), data = publicData(venue);
    if (args.confirm !== e.id) throw new Error("Review prepare-binary, then pass --confirm with the exact episode ID");
    if (!p || p.state !== "prepared" || b.order || Date.now() >= p.expiresAt) throw new Error("No fresh, unsubmitted binary preparation; reconcile an existing send or prepare again");
    const market = await data.refreshMarket(b.market);
    if (market.slug !== b.market.slug) throw new Error("Binary market no longer matches the prepared episode");
    const quote = await data.getQuote(market.slug, b.side);
    if (sizeBinaryOrder(market, quote, b.budgetUsd, p.limitPrice) < p.shares) throw new Error("Binary depth or costs changed; prepare again");
    if (await auth.getHoldings(market, b.side) !== 0) throw new Error("Binary account position changed since preview");
    const prepared = await auth.prepareOrder(market, b.side, p.shares, p.limitPrice, b.budgetUsd);
    if (Date.now() >= p.expiresAt || Date.now() >= market.endsAt) throw new Error("Binary preparation expired during the final checks; prepare again");
    if (Date.now() - quote.updatedAt > 15_000) throw new Error("The binary quote expired during preview; prepare again");
    p.state = "sending";
    p.clientOrderId ??= randomUUID();
    writeEpisode(e); // Durable before POST: never retry an ambiguous submission.
    let orderId: string;
    try {
      orderId = await auth.submitOrder(prepared, p.clientOrderId);
    } catch (error) {
      const status = definitelyRejected(error);
      if (status !== null) {
        b.attempts = [...b.attempts ?? [], { clientOrderId: p.clientOrderId, preparedAt: p.preparedAt, outcome: "rejected" }];
        delete b.prepared;
        writeEpisode(e);
        throw new Error(`${venueLabel(venue)} rejected the binary order (HTTP ${status}); nothing was submitted. Fix the cause (e.g. balance), then run prepare-binary again.`);
      }
      p.state = "uncertain";
      writeEpisode(e);
      throw new Error(`Binary submission needs reconciliation; do not resend. Run sync-binary (it looks for client order ID ${p.clientOrderId} in ${venueLabel(venue)}), or abandon-binary --confirm ${e.id} after two minutes if nothing landed. ${error instanceof Error ? error.message : "Unknown submission result"}`);
    }
    try {
      p.orderId = orderId; p.state = "submitted"; writeEpisode(e);
      const receipt = await auth.getReceipt(orderId, prepared);
      b.order = { ...receipt, updatedAt: Date.now() };
      writeEpisode(e);
      print({ episodeId: e.id, order: b.order, next: "npm run episode -- sync-binary --watch" });
    } catch (error) {
      if (!p.orderId) p.state = "uncertain";
      writeEpisode(e);
      throw new Error(`Binary submission needs reconciliation; do not resend. ${p.orderId ? `Order ID: ${p.orderId}. ` : `Find the order in ${venueLabel(venue)} (client order ID ${p.clientOrderId}) and run sync-binary --order-id ID. `}${error instanceof Error ? error.message : "Unknown submission result"}`);
    }
  });
}

async function syncOnce() {
  await withEpisodeLock(async () => {
    const e = current(), b = e.binary, venue = b.market.venue;
    const auth = privateClient(venue), data = publicData(venue);
    if (!b.prepared) throw new Error("No prepared binary order to reconcile against");
    let id = args["order-id"] ?? b.order?.id ?? b.prepared.orderId;
    // An uncertain send carries its client order ID: find it at the venue instead of asking the operator.
    if (!id && b.prepared.clientOrderId) id = await auth.findOrderByClientId(b.market, b.prepared.clientOrderId, b.prepared.preparedAt) ?? undefined;
    if (!id) {
      if (["uncertain", "sending"].includes(b.prepared.state)) return print({ episodeId: e.id, found: false, note: `No order with client order ID ${b.prepared.clientOrderId ?? "(none)"} yet. If it stays missing two minutes after the send, run abandon-binary --confirm ${e.id}.` });
      throw new Error(`No binary order ID. Recover it from ${venueLabel(venue)} and pass --order-id; do not resubmit an uncertain order.`);
    }
    const knownId = b.order?.id ?? b.prepared.orderId;
    if (knownId && knownId !== id) throw new Error("The provided order ID conflicts with the episode's known order");
    if (b.attempts?.some((a) => a.orderId === id)) throw new Error("That order belongs to an earlier attempt for this episode, not the current submission");
    const receipt = await auth.getReceipt(id, { venue, marketSlug: b.market.slug, side: b.side, shares: b.prepared.shares, limitPrice: b.prepared.limitPrice, maximumCostUsd: b.budgetUsd });
    if (receipt.id !== id || receipt.marketSlug !== b.market.slug) throw new Error("Order ID does not match the selected Bitcoin market");
    const settlement = Date.now() >= e.endsAt ? await data.getSettlement(b.market.slug) : null;
    const holdings = { shares: await auth.getHoldings(b.market, b.side) };
    // A resolved public market is not proof that this account held the original
    // shares to settlement. Require the account's own settlement record.
    if (settlement !== null && !b.finalSettlement) {
      const settledShares = await auth.getSettledHoldings(b.market, b.side);
      if (settledShares !== null) {
        if (Math.abs(settledShares - receipt.filledShares) > 1e-8 || b.reconciliationError) {
          b.reconciliationError = "Settled account holdings do not match the episode receipt; review the account activity before attributing P&L.";
        } else {
          b.finalSettlement = { shares: settledShares, yesValue: settlement, payoutUsd: settledShares * (b.side === "up" ? settlement : 1 - settlement), verifiedAt: Date.now() };
        }
      }
    } else if (settlement === null && Date.now() < e.endsAt) {
      // Reflect the latest read: a race between the order and positions reads heals
      // on the next poll, while a real difference at cutoff still sticks.
      if (Math.abs(holdings.shares - receipt.filledShares) > 1e-8) b.reconciliationError = HOLDINGS_MISMATCH;
      else if (b.reconciliationError === HOLDINGS_MISMATCH) delete b.reconciliationError;
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

// Clears an uncertain or crashed send only once the venue proves no order landed:
// two minutes after preparing, no order for the client ID, no holdings, no activity.
async function abandon() {
  await withEpisodeLock(async () => {
    const e = current(), b = e.binary, p = b.prepared, venue = b.market.venue;
    const auth = privateClient(venue);
    if (args.confirm !== e.id) throw new Error("Pass --confirm with the exact episode ID to abandon the uncertain submission");
    if (!p || !["uncertain", "sending"].includes(p.state) || p.orderId || b.order) throw new Error("Only an uncertain submission without an order ID can be abandoned; use sync-binary otherwise");
    if (Date.now() < p.preparedAt + 120_000) throw new Error("Wait two minutes after preparing before abandoning, so an in-flight order can land first");
    if (p.clientOrderId && await auth.findOrderByClientId(b.market, p.clientOrderId, p.preparedAt)) throw new Error("The venue has this order; run sync-binary instead");
    if (await auth.getHoldings(b.market, b.side) !== 0) throw new Error("The account holds this market; run sync-binary instead");
    if (await auth.hasActivity(b.market, p.preparedAt)) throw new Error("The account has activity in this market since the send; recover it with sync-binary --order-id");
    b.attempts = [...b.attempts ?? [], { clientOrderId: p.clientOrderId, preparedAt: p.preparedAt, outcome: "abandoned" }];
    delete b.prepared;
    writeEpisode(e);
    print({ episodeId: e.id, abandoned: true, next: "npm run episode -- prepare-binary" });
  });
}

const usage = `Paired episode: one hourly BTC binary + one thematic perp.\n\n  npm run episode -- plan --theme "Episode theme" --coin SOL --side long --thesis "Why this perp fits" --binary-side up --start 2026-10-02T20:00:00-07:00 [--venue kalshi|kalshi-demo|polymarket-us]\n  npm run episode -- show\n  npm run episode -- prepare-binary\n  npm run episode -- send-binary --confirm EPISODE_ID\n  npm run episode -- sync-binary --watch\n  npm run episode -- abandon-binary --confirm EPISODE_ID   (uncertain send that never landed)\n\nPlanning is public/read-only. --venue defaults to kalshi (hourly BTC above/below strike nearest 50 cents, settled on CF Benchmarks BRTI); kalshi-demo uses Kalshi's paper environment. Binary execution requires KALSHI_API_KEY_ID + KALSHI_PRIVATE_KEY_FILE (or PM_US_API_KEY + PM_US_SECRET_KEY for polymarket-us) in the operator environment. Kalshi and Polymarket US are real money; Hyperliquid defaults to testnet. Budgets default to $50 per leg; --binary-budget includes entry fees. --lev defaults to the perp's venue maximum. Binary limit defaults to $0.60; entries below $0.40 are rejected. No trade is placed by plan or show.`;

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
