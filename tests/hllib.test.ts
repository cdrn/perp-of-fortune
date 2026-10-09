import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import type { Episode } from "../src/episode.js";
import {
  assetInfo,
  universe,
  validateLeverage,
  validateMargin,
  validateSlippage,
  verifyIsolatedLeverage,
} from "../scripts/hllib.js";

const user = `0x${"1".repeat(40)}`;

test("leverage, margin and price tolerance reject invalid money inputs", () => {
  for (const invalid of [0, -1, 1.5, 11, NaN, Infinity]) {
    assert.throws(() => validateLeverage(invalid, 10));
  }
  assert.throws(() => validateLeverage(1, NaN));
  validateLeverage(10, 10);
  for (const invalid of [0, -1, NaN, Infinity]) assert.throws(() => validateMargin(invalid));
  validateMargin(50);
  for (const invalid of [-0.01, 0.051, NaN, Infinity]) assert.throws(() => validateSlippage(invalid));
  validateSlippage(0);
  validateSlippage(0.005);
});

test("asset resolution retains exchange leverage caps and rejects unavailable assets", async (t) => {
  const entries = [
    { name: "WIF", szDecimals: 1, maxLeverage: 5 },
    { name: "OLD", szDecimals: 1, maxLeverage: 5, isDelisted: true },
    { name: "ZERO", szDecimals: 1, maxLeverage: 5 },
    { name: "BAD", szDecimals: 1, maxLeverage: 5 },
    { name: "NOLEV", szDecimals: 1, maxLeverage: 0 },
  ];
  t.mock.method(globalThis, "fetch", async () => Response.json([
    { universe: entries },
    [{ markPx: "2" }, { markPx: "2" }, { markPx: "0" }, { markPx: "NaN" }, { markPx: "1" }],
  ]));
  assert.deepEqual(await assetInfo("WIF"), { assetId: 0, szDecimals: 1, markPx: 2, maxLeverage: 5 });
  assert.deepEqual(await universe(), ["WIF"]);
  await assert.rejects(assetInfo("OLD"), /delisted/);
  await assert.rejects(assetInfo("ZERO"), /no valid mark price/);
  await assert.rejects(assetInfo("BAD"), /no valid mark price/);
  await assert.rejects(assetInfo("MISSING"), /unknown perp/);
  await assert.rejects(assetInfo("NOLEV"), /maximum leverage/);
});

test("order verification accepts only the account's actual isolated leverage", async (t) => {
  let actual: { type: string; value: number } | undefined = { type: "isolated", value: 5 };
  t.mock.method(globalThis, "fetch", async () => Response.json({
    assetPositions: [{ position: { coin: "WIF", leverage: actual } }],
  }));
  await verifyIsolatedLeverage(user, "WIF", 5);
  actual = { type: "cross", value: 5 };
  await assert.rejects(verifyIsolatedLeverage(user, "WIF", 5), /cross 5/);
  actual = { type: "isolated", value: 3 };
  await assert.rejects(verifyIsolatedLeverage(user, "WIF", 5), /isolated 3/);
  actual = undefined;
  await assert.rejects(verifyIsolatedLeverage(user, "WIF", 5), /unknown/);
});

test("a coin with no position verifies active asset settings, including HIP-3 routing", async (t) => {
  const requests: Record<string, unknown>[] = [];
  let activeCoin = "xyz:DRAM";
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    const request = JSON.parse(String(init.body)) as Record<string, unknown>;
    requests.push(request);
    return Response.json(request.type === "clearinghouseState"
      ? { assetPositions: [] }
      : { user, coin: activeCoin, leverage: { type: "isolated", value: 10 } });
  });
  await verifyIsolatedLeverage(user, "xyz:DRAM", 10);
  assert.deepEqual(requests, [
    { type: "clearinghouseState", user, dex: "xyz" },
    { type: "activeAssetData", user, coin: "xyz:DRAM" },
  ]);
  activeCoin = "BTC";
  await assert.rejects(verifyIsolatedLeverage(user, "xyz:DRAM", 10), /different account or asset/);
});

test("an account lookup failure cannot produce an order approval", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("unavailable", { status: 503 }));
  await assert.rejects(verifyIsolatedLeverage(user, "BTC", 10), /503/);
});

test("episode commands preserve the selected perp, reject overrides and pin the close", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "underpod-hl-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "episode.json");
  const mock = join(directory, "mock.mjs");
  const startsAt = 1_000_000;
  const endsAt = startsAt + 3_600_000;
  const episode: Episode = {
    version: 1, id: "test-episode", createdAt: startsAt, theme: "test theme", startsAt, endsAt,
    perpNetwork: "testnet", perp: { coin: "SOL", side: "short", leverage: 10, marginUsd: 50, thesis: "test thesis" },
    binary: {
      side: "up", budgetUsd: 50, limitPrice: 0.5,
      market: { venue: "polymarket-us", slug: "test-btc", eventSlug: "test-event", title: "BTC Up or Down",
        startsAt, endsAt, settlementAt: null, rules: "test rules", priceTick: 0.01, minimumShares: 1,
        feeCoefficient: 0.07, priceToBeat: 100_000, status: "active" },
    },
  };
  writeFileSync(path, JSON.stringify(episode));
  // This child process has no live API: unexpected requests fail the test.
  writeFileSync(mock, `globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(init.body);
    if (request.type === "metaAndAssetCtxs") return Response.json([
      { universe: [{ name: "BTC", szDecimals: 5, maxLeverage: 40 }, { name: "SOL", szDecimals: 2, maxLeverage: 20 }] },
      [{ markPx: "100000" }, { markPx: "200" }]
    ]);
    // Builder dexes are empty: the episode's SOL lives on the main dex.
    if (request.type === "clearinghouseState" && request.dex) return Response.json({ assetPositions: [] });
    if (request.type === "clearinghouseState") return Response.json({ assetPositions: [
      { position: { coin: "BTC", szi: "1", entryPx: "100000", positionValue: "100000", leverage: { type: "isolated", value: 40 } } },
      { position: { coin: "SOL", szi: "-2.5", entryPx: "200", positionValue: "500", leverage: { type: "isolated", value: 10 } } }
    ] });
    throw new Error("Unexpected live API request: " + request.type);
  };`);
  const run = (...args: string[]) => spawnSync(process.execPath,
    ["--import", "tsx", "--import", mock, resolve("scripts/hl.ts"), ...args],
    { cwd: process.cwd(), env: { ...process.env, TMPDIR: directory, UNDERPOD_EPISODE: path, UNDERPOD_WALLET: user, HL_NET: "testnet", UNDERPOD_DEX: "xyz" }, encoding: "utf8" });
  const pending = () => JSON.parse(readFileSync(join(directory, "underpod-hl-pending.json"), "utf8"));

  let result = run("prepare-leverage", "--episode");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(pending().action, { type: "updateLeverage", asset: 1, isCross: false, leverage: 10 });
  assert.equal(pending().network, "testnet");

  result = run("prepare-order", "--episode");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(pending().action.orders[0], { a: 1, b: false, p: "199", s: "2.5", r: false, t: { limit: { tif: "Ioc" } } });

  for (const [flag, value] of [["coin", "BTC"], ["lev", "5"], ["usd", "100"], ["side", "long"]]) {
    result = run("prepare-order", "--episode", `--${flag}`, value!);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /conflicts with the saved episode/);
  }

  // UNDERPOD_DEX=xyz must not redirect the close of a main-dex episode coin,
  // and closes keep the wide 5% band so they fill on air.
  result = run("prepare-close", "--episode", path);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(pending().action.orders[0], { a: 1, b: true, p: "210", s: "2.5", r: true, t: { limit: { tif: "Ioc" } } });

  episode.perpNetwork = "mainnet";
  writeFileSync(path, JSON.stringify(episode));
  result = run("prepare-leverage", "--episode");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /rerun with HL_NET=mainnet/);
});
