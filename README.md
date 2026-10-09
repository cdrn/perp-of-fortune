# permanent underpod

> One hourly Bitcoin binary. One thematic perp. Two fortunes to follow live on the podcast.

A read-only **Underwater-o-meter** dashboard for a paired *Permanent Underpod*
episode. Every episode selects exactly one **hourly BTC binary on Hyperliquid
(HIP-4 outcome markets)** and one **Hyperliquid perp tied to the episode's theme**. The
binary supplies the timed result; the perp supplies the story, funding bleed,
and distance to liquidation. The old standalone perp wheel and replay still work.

## Prepare an episode

Choose a listed thematic perp and explain its connection to the episode. Use an
explicit timezone and a full-hour start.

```bash
npm ci
cp .env.example .env
HL_NET=mainnet npm run episode -- plan \
  --theme "Crypto infrastructure" --coin SOL --side long \
  --thesis "Our episode focuses on activity on Solana" \
  --binary-side up --start 2026-10-02T20:00:00-07:00 \
  --binary-budget 50 --perp-margin 50 --lev max
npm run dev
```

Replace the sample date with the actual recording date. Planning only reads
public markets and saves a local pair; it does not place orders. The binary's
strike is chosen at entry (`prepare-binary`), from the BTC binaries expiring at the
end of the hour, picking the one quoted closest to 50 cents with enough depth.
Defaults are **$50 for the binary and $50 of perp margin**, plus perp fees. Opening
an outcome position pays no fee; settlement charges the account's fee tier.
`--lev max` uses the selected perp's current supported maximum. Binary entries must
be quoted at 40–60 cents; the default maximum price is 60 cents. Omitting `--start`
selects the next full hour. The binary side is random unless `--binary-side` is
provided: UP buys YES, DOWN buys NO.

See [EXECUTION.md](EXECUTION.md) for the prepare/sign/send steps. Both legs use
the same Hyperliquid account and sigil key, on the episode's network (`HL_NET`,
default testnet). The binary pays from **spot** USDC, so move margin to spot first.

## The sigil angle

The Hyperliquid key is held by [**sigil**](https://github.com/cdrn/sigil). The perp is opened
through a Hyperliquid **API/agent wallet** that has *trade-only* permission — it
**physically cannot withdraw funds**. So we can hand an AI live trading keys on air
and it cannot rug the show. That's the whole story, and it's literally true.

Both legs are signed by that key. The dashboard holds no keys and submits no
orders; everything it shows is read from Hyperliquid's public API by address.

## Run locally

```bash
npm install
cp .env.example .env      # set UNDERPOD_WALLET to the tracked address
npm run dev               # dash on http://localhost:4749
```

The server binds to loopback (`127.0.0.1`) by default. Set `UNDERPOD_WALLET` to the
account holding the perp. With an episode selected, the tracker pins that exact
coin, direction, network and builder dex. Without an episode it retains its
legacy largest-position view.

The pair and binary receipts persist in ignored `underpod-episode.json`;
`UNDERPOD_EPISODE` overrides the path. `plan --replace` archives the previous
plan in `underpod-episodes/`, refusing unresolved submissions or unsettled filled
tickets. Use a new `UNDERPOD_DB` when starting paired episodes with legacy unscoped
history, or when switching wallet/network; old history is preserved.

For Docker, create `episode-data/` and set
`UNDERPOD_EPISODE=episode-data/underpod-episode.json` for all **host operator**
commands. Compose mounts that directory read-only into the dashboard, so atomic
receipt updates remain visible. Its host port stays bound to loopback. When
migrating legacy Docker history, start Compose with
`UNDERPOD_DB=/app/data/paired-underpod.db` to keep the original database intact.
Keep signing credentials outside the dashboard container.

Laptop note: if the lid closes, the tracker sleeps with it. That's fine — the
chart breaks the line across the gap instead of drawing through it, and on
restart the tracker reconciles against Hyperliquid's fill history (real open
time, real close PnL, liquidations detected from the liquidation fill itself).

## Architecture

- `src/hyperliquid.ts` — read client for HL's public `/info` (`clearinghouseState`, `metaAndAssetCtxs`, `userFills`).
- `src/tracker.ts` — poll loop; derives side / PnL / ROI / liq distance / drown% / funding bleed; closes out the saga log from fill history.
- `src/store.ts` — SQLite: snapshot history (PnL chart), open-position registry, closed-position saga log.
- `src/server.ts` — static dash + `/api/state`, `/api/history`, `/api/closed`.
- `public/index.html` — the Underwater-o-meter.
- `scripts/hl.ts` + `scripts/hllib.ts` — operator CLI: roll the wheel, prepare/send orders via sigil. Never imported by the dash.
- `scripts/episode.ts` — select the pair, prepare/send the binary via sigil, reconcile the account.
- `src/hl-outcomes.ts` — HIP-4 outcome discovery (typed template fields only), books, order actions, fills and settlement reads.
- `src/episode.ts` + `src/episode-tracker.ts` — atomic persistence and binary tracking; selected, filled, awaiting-result and settled states remain distinct.

## Verification

```bash
npm run typecheck
npm test
# Optional browser check (requires Playwright Chromium):
node --import tsx --test tests/dashboard.smoke.ts
```

Order tests use isolated fake exchange responses and never send real trades.
Public venue discovery can be exercised with `episode plan`.
