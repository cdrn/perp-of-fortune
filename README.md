# permanent underpod

> One hourly Bitcoin binary. One thematic perp. Two fortunes to follow live on the podcast.

A read-only **Underwater-o-meter** dashboard for a paired *Permanent Underpod*
episode. Every episode selects exactly one **BTC hourly up/down binary on
Polymarket US** and one **Hyperliquid perp tied to the episode's theme**. The
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
public markets and saves a local pair; it does not place orders. Both markets
must be found before anything is saved. Defaults are **$50 for the binary and $50
of perp margin**, plus perp fees. The binary budget includes entry fees. `--lev max`
uses the selected perp's current supported maximum. Binary entries must be quoted
at 40–60 cents; the default maximum price is 60 cents. Omitting `--start` selects
the next full hour. The binary side is random unless `--binary-side` is provided.

See [EXECUTION.md](EXECUTION.md) for separate preview/approval/send steps. Public
planning and quotes need no binary credentials. Real orders require an eligible
Polymarket US account; international Polymarket credentials are incompatible.
There is no simulated-fill fallback or binary testnet mode. Hyperliquid defaults
to testnet unless explicitly selected with `HL_NET=mainnet`.

## The sigil angle

The Hyperliquid key is held by [**sigil**](https://github.com/cdrn/sigil). The perp is opened
through a Hyperliquid **API/agent wallet** that has *trade-only* permission — it
**physically cannot withdraw funds**. So we can hand an AI live trading keys on air
and it cannot rug the show. That's the whole story, and it's literally true.

That permission claim applies to the Hyperliquid agent key only. Polymarket US
uses its own authenticated API; verify that key's permissions separately. The
dashboard submits no orders and never loads binary credentials from `.env`.
Only the operator receives binary credentials through its environment.

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
- `scripts/episode.ts` — select the pair, preview/submit the binary, reconcile the account.
- `src/polymarket-us.ts` — exact BTC contract validation, public quotes/settlement and explicit authenticated API client.
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
