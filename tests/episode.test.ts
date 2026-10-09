import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readEpisode, writeEpisode, withEpisodeLock, type Episode } from "../src/episode.js";
import { binaryView, EpisodeTracker, type EpisodeQuote } from "../src/episode-tracker.js";
import { maximumEntryCost, sizeBinaryOrder, verifyPreview } from "../src/binary-order.js";
import { buildBuyOrder } from "../src/polymarket-us.js";
import { Store } from "../src/store.js";

const now = Date.now();
function fixture(): Episode {
  return {
    version: 1, id: "test-episode", createdAt: now, theme: "Infrastructure", startsAt: now - 120_000, endsAt: now + 3_480_000,
    perpNetwork: "testnet", perp: { coin: "SOL", side: "long", leverage: 20, marginUsd: 50, thesis: "The episode discusses infrastructure." },
    binary: { side: "down", budgetUsd: 50, limitPrice: 0.6, market: {
      venue: "polymarket-us", slug: "btc-hourly", eventSlug: "btc-event", title: "BTC Up or Down: 60 min",
      startsAt: now - 120_000, endsAt: now + 3_480_000, settlementAt: now + 5_280_000, rules: "Venue rules",
      priceTick: 0.01, minimumShares: 1, feeCoefficient: 0.0695, priceToBeat: 80000, status: "MARKET_STATUS_OPEN",
    } },
  };
}
function quote(): EpisodeQuote {
  return { buyPrice: 0.51, sellPrice: 0.49, availableShares: 1000, sellAvailableShares: 1000, updatedAt: now, status: "MARKET_STATE_OPEN" };
}
function filled(): Episode {
  const e = fixture();
  e.binary.order = { id: "order", marketSlug: e.binary.market.slug, side: "down", filledShares: 80, averagePrice: 0.5, totalCostUsd: 40, feesUsd: 1.39, status: "ORDER_STATE_FILLED", updatedAt: now };
  e.binary.positionCheckedAt = now;
  return e;
}

test("planning requires both legs and atomically preserves a valid pair", async () => {
  const dir = mkdtempSync(join(tmpdir(), "episode-test-")), path = join(dir, "episode.json");
  try {
    assert.equal(readEpisode(path), null);
    writeEpisode(fixture(), path);
    assert.equal(readEpisode(path)?.perp.coin, "SOL");
    const broken = fixture(); broken.perp.thesis = "";
    assert.throws(() => writeEpisode(broken, path), /thesis/);
    assert.equal(readEpisode(path)?.binary.market.slug, "btc-hourly");
    await withEpisodeLock(async () => {
      await assert.rejects(withEpisodeLock(async () => undefined, path), /locked/);
    }, path);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("binary sizing reserves fees, respects depth and rejects late, stale or lopsided markets", () => {
  const m = fixture().binary.market;
  const shares = sizeBinaryOrder(m, quote(), 50, 0.6, now);
  assert.ok(maximumEntryCost(shares, 0.6, m.feeCoefficient!) <= 50);
  assert.equal(sizeBinaryOrder(m, { ...quote(), availableShares: 3 }, 50, 0.6, now), 3);
  for (const q of [{ ...quote(), updatedAt: now - 16_000 }, { ...quote(), buyPrice: 0.9 }, { ...quote(), buyPrice: 0.1 }, { ...quote(), status: "MARKET_STATE_CLOSED" }]) {
    assert.throws(() => sizeBinaryOrder(m, q, 50, 0.6, now));
  }
  assert.throws(() => sizeBinaryOrder({ ...m, feeCoefficient: null }, quote(), 50, 0.6, now), /fee/);
  assert.throws(() => sizeBinaryOrder(m, quote(), 50, 0.6, m.endsAt), /window/);
});

test("preview validates the DOWN YES-price convention and total budget", () => {
  const request = buildBuyOrder({ marketSlug: "btc-hourly", side: "down", shares: 80, maxPrice: 0.6 });
  const response = { order: { ...request, commissionNotionalTotalCollected: { value: "1.39", currency: "USD" } } };
  assert.equal(request.price.value, "0.4");
  verifyPreview(response, request, 50, 0.0695);
  assert.throws(() => verifyPreview({ order: { ...response.order, quantity: 81 } }, request, 50, 0.0695), /match/);
  assert.throws(() => verifyPreview(response, request, 48, 0.0695), /budget/);
});

test("unfilled, stale, shallow or unknown-fee receipts do not fabricate usable P&L", () => {
  assert.equal(binaryView(fixture(), quote(), null, now).pnlUsd, null);
  assert.ok(Math.abs(binaryView(filled(), quote(), null, now).pnlUsd! - (-2.19)) < 1e-8);
  assert.equal(binaryView(filled(), { ...quote(), sellAvailableShares: 79 }, null, now).pnlUsd, null);
  const noFees = filled(); noFees.binary.order!.feesUsd = null;
  assert.equal(binaryView(noFees, quote(), null, now).pnlUsd, null);
  assert.equal(binaryView(filled(), quote(), null, now + 61_000).pnlUsd, null);
});

test("public resolution alone cannot claim an account payout or erase external sales", () => {
  const e = filled();
  assert.equal(binaryView(e, null, 0, now).pnlUsd, null);
  e.binary.finalSettlement = { shares: 80, yesValue: 0, payoutUsd: 80, verifiedAt: now };
  assert.equal(binaryView(e, null, 0, now + 100_000).pnlUsd, 38.61);
  e.binary.reconciliationError = "External sale";
  assert.equal(binaryView(e, null, 0, now).pnlUsd, null);
});

test("quotes cannot claim executable exit value at or after the binary cutoff", () => {
  const e = filled();
  e.binary.positionCheckedAt = e.endsAt;
  const fresh = { ...quote(), updatedAt: e.endsAt };
  assert.notEqual(binaryView(e, fresh, null, e.endsAt - 1).exitValueUsd, null);
  for (const book of [quote(), fresh]) {
    const view = binaryView(e, book, null, e.endsAt);
    assert.equal(view.status, "awaiting_result");
    assert.equal(view.exitValueUsd, null);
    assert.equal(view.pnlUsd, null);
  }
  assert.equal(binaryView(filled(), { ...quote(), status: "MARKET_STATE_HALTED" }, null, now).exitValueUsd, null);
});

test("a retired order book cannot suppress a separately confirmed binary result", async () => {
  const e = filled();
  e.endsAt = e.binary.market.endsAt = now - 1;
  e.binary.finalSettlement = { shares: 80, yesValue: 0, payoutUsd: 80, verifiedAt: now };
  const tracker = new EpisodeTracker({ getQuote: async () => { throw new Error("Book retired"); }, getSettlement: async () => 0 }, () => e);
  await tracker.tick();
  assert.equal(tracker.current.binary?.status, "settled");
  assert.equal(tracker.current.binary?.settlementValue, 1);
  assert.equal(tracker.current.binary?.pnlUsd, 38.61);
});

test("tracker storage cannot mix accounts/networks or reinterpret legacy history", () => {
  const scoped = new Store(":memory:");
  scoped.bindScope("testnet|account-a");
  scoped.bindScope("testnet|account-a");
  assert.throws(() => scoped.bindScope("mainnet|account-a"), /another wallet/);
  assert.throws(() => scoped.bindScope("testnet|account-b"), /another wallet/);
  assert.throws(() => scoped.bindScope("mainnet|account-a", { allowUnscopedHistory: true }), /another wallet/);
  const legacy = new Store(":memory:");
  legacy.insertOpen({ coin: "SOL", side: "LONG", entryPx: 100, leverage: 10, openedTs: now });
  legacy.bindScope("mainnet|account-a", { allowUnscopedHistory: true });
  assert.throws(() => legacy.bindScope("testnet|account-a"), /Legacy/);
  assert.equal(legacy.getOpen("SOL")?.entryPx, 100);
});

test("removing an episode cannot reconcile scoped testnet positions against legacy mainnet", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "tracker-scope-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const wallet = `0x${"1".repeat(40)}`;
  const code = `
    import assert from "node:assert/strict";
    import { Store } from "./src/store.ts";
    import { Tracker } from "./src/tracker.ts";
    const store = new Store(":memory:");
    store.bindScope("https://api.hyperliquid-testnet.xyz|" + process.env.UNDERPOD_WALLET);
    store.insertOpen({ coin: "SOL", side: "LONG", entryPx: 100, leverage: 10, openedTs: 1 });
    let requests = 0;
    globalThis.fetch = async (_url, init) => {
      requests++;
      const request = JSON.parse(init.body);
      if (request.type === "metaAndAssetCtxs") return Response.json([{ universe: [] }, []]);
      if (request.type === "clearinghouseState") return Response.json({ assetPositions: [], marginSummary: { accountValue: "0" }, withdrawable: "0" });
      return Response.json([]);
    };
    await assert.rejects(new Tracker(store).tick(), /another wallet/);
    assert.equal(requests, 0);
    assert.equal(store.getOpen("SOL").entryPx, 100);
    assert.equal(store.closedLog().length, 0);
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
    cwd: process.cwd(), encoding: "utf8",
    env: { ...process.env, UNDERPOD_WALLET: wallet, UNDERPOD_EPISODE: join(directory, "removed-episode.json"), HL_API: "https://api.hyperliquid.xyz" },
  });
  assert.equal(result.status, 0, result.stderr);
});

test("a flipped episode perp stays visible and closes the old side's row", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "tracker-flip-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const wallet = `0x${"2".repeat(40)}`;
  const episodePath = join(directory, "episode.json");
  const startsAt = Date.parse("2026-10-01T20:00:00Z"), endsAt = startsAt + 3_600_000;
  writeFileSync(episodePath, JSON.stringify({
    version: 1, id: "flip", createdAt: startsAt, theme: "theme", startsAt, endsAt, perpNetwork: "testnet",
    perp: { coin: "SOL", side: "long", leverage: 10, marginUsd: 50, thesis: "thesis" },
    binary: { side: "up", budgetUsd: 50, limitPrice: 0.5, market: { venue: "polymarket-us", slug: "s", eventSlug: "e", title: "t",
      startsAt, endsAt, settlementAt: null, rules: "r", priceTick: 0.01, minimumShares: 1, feeCoefficient: 0.07, priceToBeat: null, status: "x" } },
  }));
  const code = `
    import assert from "node:assert/strict";
    import { Store } from "./src/store.ts";
    import { Tracker } from "./src/tracker.ts";
    const store = new Store(":memory:");
    store.bindScope("https://api.hyperliquid-testnet.xyz|" + process.env.UNDERPOD_WALLET);
    store.insertOpen({ coin: "SOL", side: "LONG", entryPx: 100, leverage: 10, openedTs: 1 });
    globalThis.fetch = async (_url, init) => {
      const request = JSON.parse(init.body);
      if (request.type === "metaAndAssetCtxs") return Response.json([{ universe: [{ name: "SOL" }] }, [{ markPx: "150", funding: "0", oraclePx: "150" }]]);
      if (request.type === "clearinghouseState") return Response.json({
        assetPositions: [{ position: { coin: "SOL", szi: "-2", entryPx: "150", positionValue: "300", unrealizedPnl: "0",
          leverage: { type: "isolated", value: 10 }, liquidationPx: "160", marginUsed: "30", cumFunding: { sinceOpen: "0" } } }],
        marginSummary: { accountValue: "100" }, withdrawable: "0" });
      return Response.json([]);
    };
    const tracker = new Tracker(store);
    await tracker.tick();
    assert.equal(tracker.current.position?.side, "SHORT");
    assert.equal(store.getOpen("SOL").side, "SHORT");
    assert.equal(store.closedLog().length, 1);
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
    cwd: process.cwd(), encoding: "utf8",
    env: { ...process.env, UNDERPOD_WALLET: wallet, UNDERPOD_EPISODE: episodePath, UNDERPOD_DEXES: "" },
  });
  assert.equal(result.status, 0, result.stderr);
});
