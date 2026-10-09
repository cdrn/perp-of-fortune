# EXECUTION — the show runbook

## Default show: Bitcoin binary + thematic perp

Research the episode theme and select one listed Hyperliquid perp with a short
thesis. Every episode also includes one **hourly BTC up/down contract on
Polymarket US**, selected using the venue's typed BTC/hourly contract metadata.
The episode window is the price-measurement window, not the later market expiry.
Plan close enough to the recording that the venue has listed that window.

```bash
HL_NET=mainnet npm run episode -- plan \
  --theme "Episode theme" --coin SOL --side long \
  --thesis "Explain the connection to this episode" \
  --binary-side up --start 2026-10-02T20:00:00-07:00 \
  --binary-budget 50 --perp-margin 50 --lev max
npm run episode -- show
```

Use the actual recording date/time: a full hour with an explicit timezone.
Omitting it selects the next hour. Defaults are $50 for the binary and $50 of
perp margin, plus perp fees; both can be set independently. The binary side is
random if omitted. Unavailable BTC
hourly markets produce an error; no other asset/duration/contract is substituted.
Future preopen windows can be planned but cannot be traded until open. Entry
preparation needs at least 45 minutes remaining, a 40–60 cent quote and adequate
depth. `--limit 0.55` tightens the default 60-cent ceiling.

Planning has no financial effect, even with `HL_NET=mainnet`. Each leg follows
its own approval path. There is no atomic cross-exchange trade: if one leg fails
or partially fills, reconcile it and report the actual state.

### Binary account and execution

The operator requires an eligible **Polymarket US** account, funds and an API
key/Ed25519 secret from that account's developer settings. Provide
`PM_US_API_KEY` and `PM_US_SECRET_KEY` only in the operator environment through a
secret manager. Never paste them into chat, commands, Git or the dashboard `.env`.
The Hyperliquid/sigil trade-only permission does not apply to this account;
verify its permissions separately. Polymarket US orders use real money;
`HL_NET=testnet` affects only the perp.

```bash
npm run episode -- prepare-binary
# Review exact market, side, shares, max price and total cost.
npm run episode -- send-binary --confirm EPISODE_ID
npm run episode -- sync-binary --watch
```

Preparation checks holdings, reserves fees within the budget, and calls the
venue's preview; it places no order. Preparations expire after 60 seconds. Send
rechecks listing/book/holdings/preview, then submits one IOC limit order. DOWN
orders use the venue's YES-price convention internally. Only confirmed fills
produce a position; partial or zero fills never become a full-budget position.

Keep `sync-binary --watch` running through account settlement. It authenticates
only in the operator and writes receipts for the read-only dashboard. If holdings
differ from this episode's receipt, P&L is withheld. Use a dedicated episode
position; other trades in the same market break attribution. The intended binary
strategy holds through resolution; manual early exits are not automatically
attributed to the episode.

If submission times out or crashes, **do not submit again**. Durable state blocks
a retry. If an ID was recorded, run `sync-binary`; otherwise find the original
order in Polymarket US and use `sync-binary --order-id ID`. A missing receipt does
not prove failure. A leftover `.lock` after a crash requires checking that no
operator is running before removing it; this does not clear an uncertain send.

### Thematic perp

The selected coin, side, margin, leverage and network are pinned:

```bash
HL_NET=mainnet npm run hl -- prepare-leverage --episode
# sigil approval → HL_NET=mainnet npm run hl -- send --sig 0x…
HL_NET=mainnet npm run hl -- prepare-order --episode
# sigil approval → HL_NET=mainnet npm run hl -- send --sig 0x…
```

Use the selected network; mainnet still requires human financial approval.
The operator verifies the account's actual isolated leverage before preparing
the opening order. HIP-3 selections still need collateral on that builder dex.
`prepare-close --episode` targets the thematic coin even if another position is
larger, then follows the same sign/send steps.

### During the show

Run `npm run dev`. Both cards remain independent if one feed fails. Binary exit
value requires sufficient bid depth; live P&L includes entry fees and excludes
future exit fees. Stale account sync, unknown fees or unverified holdings produce
no invented P&L. The price cutoff, estimated venue expiry and confirmed account
settlement are distinct; a public result can appear before verified final P&L.

Plans/receipts are ignored private local files. `plan --replace` archives the
previous pair after submission/settlement checks. Legacy SQLite history has no
wallet/network scope: preserve it and use a separate `UNDERPOD_DB` for paired
episodes. Keep the old database for replays.

## Legacy standalone perp commands

How a position gets opened (and closed) on air. The dash never touches keys;
everything below is the operator CLI (`scripts/hl.ts`) plus **sigil**, which
holds the Hyperliquid API/agent wallet — trade-only, physically cannot withdraw.

Every state-changing call follows the same three beats:

1. **prepare** — the CLI builds the exact Hyperliquid action, stashes
   `{action, nonce}` to a tmp file, and prints the EIP-712 typed-data.
2. **sign** — hand that typed-data to `sigil_eth_sign_typed_data` (portal = the
   trading key). The human approves the signature. This is the bit.
3. **send** — `npm run hl -- send --sig 0x…` posts the *identical* stashed
   bytes with sigil's signature to `/exchange`.

The nonce is `Date.now()` at prepare time; Hyperliquid accepts a generous
window, so a dramatic pause between prepare and send is fine.

## Network

`HL_NET=testnet` is the default — nothing here touches real money unless you
explicitly set `HL_NET=mainnet`. Do a full testnet dress rehearsal first.

```bash
HL_NET=mainnet npm run hl -- roll          # the real thing
```

## 1. Roll

```bash
npm run hl roll                            # Math.random() spin, curated basket
npm run hl -- roll --any                   # spin over every listed perp (~180)
npm run hl -- roll --seed "listener phrase"  # verifiable: keccak256(seed) picks
```

The roll only spins over coins actually listed on the current net (it checks),
and prints the exact next commands. The seeded form is provably fair — anyone
can re-derive coin/side/leverage from the phrase at home. `--any` and `--seed`
compose: a listener phrase can pick from the full universe.

## 2. Set leverage (isolated)

```bash
npm run hl -- prepare-leverage --coin SOL --lev 10
# → sign with sigil → npm run hl -- send --sig 0x…
```

Isolated margin on purpose: the liquidation math is clean, and a liquidation
only eats that position's margin, not the whole purse.

## 3. Open the position

```bash
npm run hl -- prepare-order --coin SOL --side short --usd 50 --lev 10
# → sign with sigil → npm run hl -- send --sig 0x…
```

`--usd` is the **margin** committed; notional = usd × lev. The order is a
marketable IOC (`--slippage` defaults to 0.5%, with a 5% ceiling); it can fill
partially and cancels the unfilled remainder. After `send`, check actual fills and the dash — the position should
appear within one poll (~5s).

## 4. Watch it drown

```bash
npm run dev        # http://localhost:4749
```

`UNDERPOD_WALLET` in `.env` must be the address that *holds* the position (the
master account, not the agent key that signs).

## 5. Cut it loose (or don't)

```bash
npm run close                              # closes the largest open position
npm run close -- --coin SOL                # or name it (npm run hl prepare-close works too)
# → sign with sigil → npm run hl -- send --sig 0x…
```

HIP-3 builder perps are addressed as `dex:COIN` (e.g. `--coin xyz:DRAM`);
set `UNDERPOD_DEX` to make the tracker watch a builder dex.

Reduce-only IOC for the full size in the opposite direction — it can only
close, never flip. Reads the position from `UNDERPOD_WALLET` (or `--wallet`),
so nothing is fat-fingered live. If instead the market cuts it loose for you,
the tracker sees the liquidation fill and logs the ending honestly.

## If something breaks live

- `send` rejects with a signature error → the stash and the signed bytes
  drifted; re-run the `prepare-*` step and sign the fresh typed-data.
- IOC didn't fill (thin testnet book) → re-run `prepare-order` with a bigger
  `--slippage`.
- Wheel picked a coin `prepare-order` rejects → shouldn't happen anymore (the
  roll filters by the live universe), but re-rolling is always canon.
