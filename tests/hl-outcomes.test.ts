import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assetId, balanceCoin, bookCoin, btcBinariesAt, buildBuyAction, depthWithin, exitValue, formatOutcomePrice,
  HLOutcomeClient, parseExchangeResult, parseExpiry, quoteFromBook, settlementFromFills, summariseFills, type HLFill,
} from "../src/hl-outcomes.js";

// Shapes captured from mainnet outcomeMeta on 2026-10-09.
const CUTOFF = Date.UTC(2026, 9, 9, 3, 0);
const META = {
  outcomes: [
    { outcome: 10124, name: "template:binaryPrice", description: "perp:BTC|priceDescription:the Hyperliquid BTC perp trade|seconds:90|threshold:81944|time:20261009-0300", sideSpecs: [{ name: "template:Yes" }, { name: "template:No" }], quoteToken: "USDC", venue: "skew", deployerFeeScale: "1.0" },
    { outcome: 10125, name: "template:binaryPrice", description: "perp:BTC|priceDescription:BTC-USDC perp mark|seconds:60|threshold:81998|time:20261009-0230", sideSpecs: [{ name: "template:Yes" }, { name: "template:No" }], quoteToken: "USDC", venue: "out" },
    { outcome: 9802, name: "Recurring", description: "class:priceBinary|underlying:BTC|expiry:20261009-0300|targetPrice:82638|period:1d", sideSpecs: [{ name: "Yes" }, { name: "No" }], quoteToken: "USDC" },
    { outcome: 7173, name: "template:priceTouch", description: "perp:BTC|priceDescription:BTC-USDC perp mark|seconds:3|target:87500|time:20261009-0300", sideSpecs: [{ name: "Yes" }, { name: "No" }], quoteToken: "USDC", venue: "out" },
    { outcome: 7000, name: "template:binaryPrice", description: "perp:ETH|priceDescription:ETH mark|seconds:60|threshold:3000|time:20261009-0300", sideSpecs: [{ name: "Yes" }, { name: "No" }], quoteToken: "USDC", venue: "out" },
    { outcome: 7001, name: "template:binaryPrice", description: "perp:BTC|priceDescription:BTC mark|seconds:60|threshold:81000|time:20261009-0300", sideSpecs: [{ name: "Yes" }, { name: "No" }], quoteToken: "USDH", venue: "out" },
    { outcome: 1473, name: "template:sportsTournamentParticipant", description: "participant:Arsenal", sideSpecs: [{ name: "Yes" }, { name: "No" }], quoteToken: "USDC", venue: "out" },
  ],
};

test("encodings follow the documented outcome asset ids", () => {
  assert.equal(bookCoin(1, "up"), "#10");
  assert.equal(balanceCoin(1, "up"), "+10");
  assert.equal(bookCoin(10124, "down"), "#101241");
  assert.equal(assetId(1, "up"), 100_000_010);
  assert.equal(parseExpiry("20261009-0300"), CUTOFF);
  assert.equal(parseExpiry("2026-10-09"), null);
});

test("discovery keeps only BTC price binaries settling in USDC exactly at the cutoff", () => {
  const found = btcBinariesAt(META, CUTOFF);
  assert.deepEqual(found.map((m) => m.outcome).sort((a, b) => a - b), [9802, 10124]);
  const community = found.find((m) => m.outcome === 10124)!;
  assert.equal(community.threshold, 81944);
  assert.equal(community.official, false);
  assert.equal(community.deployer, "skew");
  assert.match(community.title, /BTC at or above \$81,944 at 03:00 UTC/);
  const official = found.find((m) => m.outcome === 9802)!;
  assert.equal(official.official, true);
  assert.equal(official.deployer, "hyperliquid");
  assert.deepEqual(btcBinariesAt(META, CUTOFF - 1_800_000).map((m) => m.outcome), [10125]);
  assert.deepEqual(btcBinariesAt({}, CUTOFF), []);
});

test("order books parse both sides, refuse crossed or missing books", () => {
  const q = quoteFromBook({ coin: "#101240", time: 1000, levels: [
    [{ px: "0.45", sz: "100.0", n: 1 }, { px: "0.44", sz: "50.0", n: 1 }],
    [{ px: "0.48", sz: "100.0", n: 1 }, { px: "0.50", sz: "40.0", n: 2 }, { px: "0.62", sz: "500.0", n: 1 }],
  ] });
  assert.equal(q.buyPrice, 0.48);
  assert.equal(q.sellPrice, 0.45);
  assert.equal(q.availableShares, 100);
  assert.equal(q.updatedAt, 1000);
  assert.equal(depthWithin(q.asks, 0.6), 140);
  assert.equal(exitValue(q.bids, 120), 100 * 0.45 + 20 * 0.44);
  assert.equal(exitValue(q.bids, 151), null);
  assert.throws(() => quoteFromBook(null), /unavailable/);
  assert.throws(() => quoteFromBook({ time: 1, levels: [[{ px: "0.5", sz: "1" }], [{ px: "0.49", sz: "1" }]] }), /crossed/);
  assert.equal(quoteFromBook({ time: 1, levels: [[], []] }).status, "empty");
});

test("buy actions are whole-share IOCs with a client id, in signing key order", () => {
  const cloid = "0x" + "ab".repeat(16);
  const action = buildBuyAction({ outcome: 10124, side: "down", shares: 80, limitPrice: 0.6, cloid });
  assert.deepEqual(action, { type: "order", orders: [{ a: 100_101_241, b: true, p: "0.6", s: "80", r: false, t: { limit: { tif: "Ioc" } }, c: cloid }], grouping: "na" });
  assert.deepEqual(Object.keys(action.orders[0]), ["a", "b", "p", "s", "r", "t", "c"]);
  assert.throws(() => buildBuyAction({ outcome: 1, side: "up", shares: 1.5, limitPrice: 0.5, cloid }), /whole/);
  assert.throws(() => buildBuyAction({ outcome: 1, side: "up", shares: 10, limitPrice: 0.5, cloid: "abc" }), /client order id/);
  assert.equal(formatOutcomePrice(0.25996), "0.25996");
  assert.throws(() => formatOutcomePrice(0.123456), /5 decimals/);
  assert.throws(() => formatOutcomePrice(1), /between/);
});

test("exchange responses distinguish fills, misses and rejections", () => {
  assert.deepEqual(parseExchangeResult({ status: "ok", response: { type: "order", data: { statuses: [{ filled: { totalSz: "80.0", avgPx: "0.48", oid: 77 } }] } } }),
    { kind: "filled", oid: 77, filledShares: 80, averagePrice: 0.48 });
  assert.equal(parseExchangeResult({ status: "ok", response: { type: "order", data: { statuses: [{ error: "Order could not immediately match against any resting orders. asset=101012410" }] } } }).kind, "unfilled");
  assert.equal(parseExchangeResult({ status: "ok", response: { type: "order", data: { statuses: [{ error: "Insufficient spot balance" }] } } }).kind, "rejected");
  assert.equal(parseExchangeResult({ status: "err", response: "User or API Wallet does not exist." }).kind, "rejected");
  assert.equal(parseExchangeResult({ status: "ok", response: { type: "order", data: { statuses: [{ resting: { oid: 5 } }] } } }).kind, "resting");
  assert.throws(() => parseExchangeResult({ status: "ok", response: {} }), /Unrecognised/);
});

test("fills give the entry receipt and the account's own settlement", () => {
  // Settlement fill shape captured from a mainnet NO holder at the 02:30 expiry.
  const fills: HLFill[] = [
    { coin: "#101251", px: "0.7", sz: "100.0", side: "B", time: 1, dir: "Buy", oid: 9, fee: "0.0" },
    { coin: "#101251", px: "0.74", sz: "63.0", side: "B", time: 2, dir: "Buy", oid: 9, fee: "0.0" },
    { coin: "#101251", px: "0.5", sz: "5.0", side: "B", time: 2, dir: "Buy", oid: 10, fee: "0.0" },
    { coin: "#101251", px: "1.0", sz: "163.0", side: "A", time: 3, dir: "Settlement", closedPnl: "46.13742", oid: 569395819010, fee: "0.18582" },
  ];
  const bought = summariseFills(fills, "#101251", 9);
  assert.equal(bought.shares, 163);
  assert.equal(bought.costUsd, 70 + 46.62);
  assert.equal(bought.averagePrice, Math.round((116.62 / 163) * 1e8) / 1e8);
  const settled = settlementFromFills(fills, "#101251")!;
  assert.equal(settled.shares, 163);
  assert.equal(settled.price, 1);
  assert.equal(settled.payoutUsd, 162.81418);
  assert.equal(settlementFromFills(fills, "#101250"), null);
});

test("the public settlement read returns the YES fraction, or null before settlement", async () => {
  const responses: Record<number, unknown> = {
    10125: { spec: { outcome: 10125 }, settleFraction: "0.0", details: "template" },
    10124: null,
    1: { spec: { outcome: 2 }, settleFraction: "1.0" },
  };
  const client = new HLOutcomeClient("https://api.example", (async (_url: string, init: { body: string }) =>
    Response.json(responses[JSON.parse(init.body).outcome])) as unknown as typeof fetch);
  assert.equal(await client.getSettlement(10125), 0);
  assert.equal(await client.getSettlement(10124), null);
  await assert.rejects(client.getSettlement(1), /different/);
});
