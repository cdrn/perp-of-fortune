# EXECUTION — the show runbook

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
marketable IOC (crosses the spread by `--slippage`, default 5%) so it fills
immediately or not at all. After `send`, check the dash — the position should
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
