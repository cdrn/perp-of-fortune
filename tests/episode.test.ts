import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readEpisode, writeEpisode, withEpisodeLock, type Episode } from "../src/episode.js";
import { binaryView, EpisodeTracker, type EpisodeQuote } from "../src/episode-tracker.js";
import { maximumEntryCost, sizeBinaryOrder } from "../src/binary-order.js";
import { Store } from "../src/store.js";

const HOUR = 3_600_000;
const start = Math.floor(Date.now() / HOUR) * HOUR;
const now = start + 120_000;
function fixture(): Episode {
  return {
    version: 1, id: "test-episode", createdAt: now, theme: "Infrastructure", startsAt: start, endsAt: start + HOUR,
    perpNetwork: "testnet", perp: { coin: "SOL", side: "long", leverage: 20, marginUsd: 50, thesis: "The episode discusses infrastructure." },
    binary: { side: "down", budgetUsd: 50, limitPrice: 0.6, market: {
      venue: "hyperliquid", outcome: 10124, title: "BTC at or above $81,944", underlying: "BTC", threshold: 81944,
      endsAt: start + HOUR, deployer: "skew", official: false, priceSource: "the Hyperliquid BTC perp trade", rules: "perp:BTC|threshold:81944", quoteToken: "USDC",
    } },
  };
}
function quote(at = now): EpisodeQuote {
  return { buyPrice: 0.51, sellPrice: 0.49, availableShares: 1000, sellAvailableShares: 1000,
    asks: [{ price: 0.51, size: 1000 }], bids: [{ price: 0.49, size: 1000 }], updatedAt: at, status: "open" };
}
function filled(): Episode {
  const e = fixture();
  e.binary.order = { id: "77", outcome: 10124, side: "down", filledShares: 80, averagePrice: 0.5, totalCostUsd: 40, feesUsd: 0, status: "filled", updatedAt: now };
  return e;
}
const held = (holdings: number | null = 80) => ({ holdings, settlement: null });

test("planning requires both legs and atomically preserves a valid pair", async () => {
  const dir = mkdtempSync(join(tmpdir(), "episode-test-")), path = join(dir, "episode.json");
  try {
    assert.equal(readEpisode(path), null);
    writeEpisode(fixture(), path);
    assert.equal(readEpisode(path)?.perp.coin, "SOL");
    const broken = fixture(); broken.perp.thesis = "";
    assert.throws(() => writeEpisode(broken, path), /thesis/);
    const late = fixture(); late.binary.market!.endsAt += HOUR;
    assert.throws(() => writeEpisode(late, path), /expiring at the episode cutoff/);
    const unpicked = fixture(); delete unpicked.binary.market;
    writeEpisode(unpicked, path);
    assert.equal(readEpisode(path)?.binary.market, undefined);
    await withEpisodeLock(async () => {
      await assert.rejects(withEpisodeLock(async () => undefined, path), /locked/);
    }, path);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("binary sizing buys whole shares within budget and depth, and rejects late, stale or lopsided books", () => {
  const e = fixture();
  const shares = sizeBinaryOrder(e, quote(), 50, 0.6, now);
  assert.equal(shares, 83);
  assert.ok(maximumEntryCost(shares, 0.6) <= 50);
  assert.equal(sizeBinaryOrder(e, { ...quote(), asks: [{ price: 0.51, size: 30 }] }, 50, 0.6, now), 30);
  for (const q of [quote(now - 16_000), { ...quote(), buyPrice: 0.9 }, { ...quote(), buyPrice: 0.3 }, { ...quote(), status: "empty" as const }]) {
    assert.throws(() => sizeBinaryOrder(e, q, 50, 0.6, now));
  }
  assert.throws(() => sizeBinaryOrder(e, { ...quote(), asks: [{ price: 0.51, size: 15 }] }, 50, 0.6, now), /\$10 minimum/);
  assert.throws(() => sizeBinaryOrder(e, quote(start + 16 * 60_000), 50, 0.6, start + 16 * 60_000), /entry window/);
  assert.throws(() => sizeBinaryOrder(e, quote(start - 6 * 60_000), 50, 0.6, start - 6 * 60_000), /entry window/);
  assert.throws(() => sizeBinaryOrder(e, quote(), 50, 0.7, now), /limit/);
});

test("unfilled, stale, shallow or unheld receipts do not fabricate usable P&L", () => {
  assert.equal(binaryView(fixture(), quote(), null, now).pnlUsd, null);
  assert.equal(binaryView(filled(), quote(), null, now, held()).pnlUsd, -0.8);
  assert.equal(binaryView(filled(), { ...quote(), bids: [{ price: 0.49, size: 79 }] }, null, now, held()).pnlUsd, null);
  const noFees = filled(); noFees.binary.order!.feesUsd = null;
  assert.equal(binaryView(noFees, quote(), null, now, held()).pnlUsd, null);
  assert.equal(binaryView(filled(), quote(), null, now, held(null)).pnlUsd, null);
  const sold = binaryView(filled(), quote(), null, now, held(40));
  assert.equal(sold.pnlUsd, null);
  assert.equal(sold.stale, true);
  assert.match(sold.error!, /holdings differ/);
});

test("public resolution alone cannot claim an account payout or erase external sales", () => {
  const e = filled();
  assert.equal(binaryView(e, null, 0, now).pnlUsd, null);
  assert.equal(binaryView(e, null, 0, now, { holdings: 0, settlement: { shares: 80, payoutUsd: 79.9 } }).pnlUsd, 39.9);
  assert.equal(binaryView(e, null, 0, now, { holdings: 0, settlement: { shares: 40, payoutUsd: 39.95 } }).pnlUsd, null);
  e.binary.finalSettlement = { shares: 80, yesValue: 0, payoutUsd: 80, verifiedAt: now };
  assert.equal(binaryView(e, null, 0, now).pnlUsd, 40);
  e.binary.reconciliationError = "External sale";
  assert.equal(binaryView(e, null, 0, now).pnlUsd, null);
});

test("quotes cannot claim executable exit value at or after the binary cutoff", () => {
  const e = filled();
  const fresh = quote(e.endsAt);
  assert.notEqual(binaryView(e, fresh, null, e.endsAt - 1, held()).exitValueUsd, null);
  for (const book of [quote(), fresh]) {
    const view = binaryView(e, book, null, e.endsAt, held());
    assert.equal(view.status, "awaiting_result");
    assert.equal(view.exitValueUsd, null);
    assert.equal(view.pnlUsd, null);
  }
});

test("the tracker reads holdings and settlement from the chain without keys", async () => {
  const e = filled();
  e.startsAt -= HOUR; e.endsAt -= HOUR; e.binary.market!.endsAt -= HOUR;
  const tracker = new EpisodeTracker({
    getQuote: async () => { throw new Error("Book retired"); },
    getSettlement: async () => 0,
    spotBalances: async () => new Map([["USDC", { total: 120 }]]),
    fills: async () => [{ coin: "#101241", px: "1.0", sz: "80.0", side: "A", time: now, dir: "Settlement", oid: 1, fee: "0.1" }],
  }, () => e, "0x" + "1".repeat(40));
  await tracker.tick();
  assert.equal(tracker.current.binary?.status, "settled");
  assert.equal(tracker.current.binary?.settlementValue, 1);
  assert.equal(tracker.current.binary?.pnlUsd, 39.9);
});

test("before entry the dashboard shows the plan without a market", async () => {
  const e = fixture(); delete e.binary.market;
  const tracker = new EpisodeTracker({ getQuote: async () => { throw new Error("unused"); }, getSettlement: async () => null }, () => e);
  await tracker.tick();
  assert.equal(tracker.current.binary?.status, "planned");
  assert.equal(tracker.current.binary?.marketTitle, null);
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
    binary: { side: "up", budgetUsd: 50, limitPrice: 0.5 },
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
