# EXECUTION — the show runbook

## Default show: Bitcoin binary + thematic perp

Research the episode theme and select one listed Hyperliquid perp with a short
thesis. Every episode also includes one **hourly BTC binary on Hyperliquid**
(HIP-4 outcome market) that settles at the end of the episode hour.

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
random if omitted: UP buys YES ("BTC at or above the strike at the cutoff"),
DOWN buys NO. `plan` lists the BTC binaries already listed for that cutoff but
does not pick one. `--limit 0.55` tightens the default 60-cent ceiling.

Planning has no financial effect, even with `HL_NET=mainnet`. Each leg follows
its own approval path. There is no atomic trade across the two legs: if one fails
or partially fills, reconcile it and report the actual state.

### Which binary

Hyperliquid itself lists a recurring **daily** BTC binary (06:00 UTC). Hourly BTC
binaries come from permissionless HIP-4 deployers (e.g. `skew`, `out`), are thin
(often one market maker) and are settled by the deployer against the price source
in their description. `prepare-binary` considers only BTC price binaries settling
in USDC exactly at the episode cutoff, sizes each, and picks the one quoted
closest to 50 cents with enough depth. It prints the deployer and price source;
say them on air. `--outcome N` pins a specific market. If nothing for the hour is
enterable, it says why for each strike, and the episode runs perp-only.

### Binary execution

The binary pays from **spot USDC**, not perp margin. Move enough first (the
preparation prints the exact command if spot is short):

```bash
HL_NET=mainnet npx tsx scripts/xfer.ts prepare --dex spot --amount 50
# sign the typed data with sigil (portal evm:stooge) → HL_NET=mainnet npx tsx scripts/xfer.ts send --sig 0x…
```

Then, from 5 minutes before the hour until 15 minutes after:

```bash
HL_NET=mainnet npm run episode -- prepare-binary
# Review market, deployer, side, shares, limit and maximum cost; sign the printed
# typed data with sigil_eth_sign_typed_data (portal evm:stooge).
HL_NET=mainnet npm run episode -- send-binary --sig 0x…
HL_NET=mainnet npm run episode -- sync-binary
```

Preparation checks the book, spot USDC and existing holdings, and builds one IOC
buy of whole shares at the limit with a client order id; it places no order.
Preparations expire after two minutes. Send rechecks the book, records the send
durably, then posts the signed order. Only confirmed fills produce a position;
partial fills are recorded as such. If the IOC finds no liquidity, nothing filled:
run `prepare-binary` again.

If Hyperliquid refuses the order (bad signature, insufficient spot balance), the
preparation is cleared: fix the cause and prepare again.

If submission times out or crashes, **do not prepare a new order**. Run
`sync-binary`: it finds the order by its client order id. The signed nonce also
means the same payload can never execute twice. If the order is still unknown two
minutes after preparing and the account holds none of the outcome, run
`abandon-binary --confirm EPISODE_ID`, then prepare again. A leftover `.lock`
after a crash requires checking that no operator is running before removing it.

The dashboard reads holdings and settlement from the chain itself, so nothing has
to keep running for it. Run `sync-binary` after the cutoff to record the verified
payout in the episode file (needed before `plan --replace`). If holdings differ
from the receipt, P&L is withheld; a difference that clears on the next read
heals, one still present at the cutoff stays, and a withheld result does not block
`plan --replace` once the hour is over. Use a dedicated position: other trades in
the same outcome break attribution. The bit holds through settlement; manual early
exits are not attributed to the episode.

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
value is what selling into the bids would return now, and needs enough bid depth;
it excludes any closing fee. Stale books, unknown fees or holdings that don't match
the receipt produce no invented P&L. After the cutoff the public result
(`settledOutcome`) can appear before the account's own settlement fill; final P&L
waits for the fill.

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
marketable IOC (`--slippage` defaults to 0.5% for opens and 5% for closes, with a
5% ceiling); it can fill
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
set `UNDERPOD_DEX` to make the tracker watch a builder dex. Without a prefix
(or `--dex`), close searches the main dex and every dex in `UNDERPOD_DEXES` /
`UNDERPOD_DEX`; an episode coin without a prefix always closes on the main dex.

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
