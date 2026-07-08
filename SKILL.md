---
name: perp-of-fortune
description: >
  Run the Perp of Fortune segment — research a pick, then open/close a leveraged
  Hyperliquid perp (including HIP-3 builder-dex perps like commodities/stocks) with
  sigil-signed orders, funded from the evm:stooge agent wallet, and watched on the
  local dashboard. Use when asked to roll/open/close a Perp of Fortune position, move
  collateral between HL dexes, or bridge USDC into Hyperliquid.
---

# Perp of Fortune — agent runbook

A read-only **dashboard** (`src/`, port 4749) + an **operator CLI** (`scripts/`) +
**sigil** (a local signing daemon holding a *trade-only* Hyperliquid agent wallet,
`evm:stooge`, which **cannot withdraw**). The dashboard never touches keys. Every
state change is **prepare → sign (sigil) → send**.

This file is the shortcut past everything that was painful the first time. Read the
"Gotchas" first — they are the whole reason this took hours.

## Gotchas (read this first)

1. **HIP-3 collateral is siloed.** Each builder dex (`xyz`, `flx`, …) has its *own*
   USDC pool, separate from the main perp dex (`""`). Bridging/depositing credits the
   **main** dex only. To trade a HIP-3 perp you must first move collateral into that
   dex with **`sendAsset`** (see below).
2. **Two different signing schemes** (get this wrong → `422 Failed to deserialize` or an
   invalid-signature reject). See "Signing model".
3. **`sendAsset` is user-signed EIP-712, NOT an L1 action.** The Go SDK
   (`sonirico/go-hyperliquid`) wrongly signs `perpDexClassTransfer` as L1 — that path
   422s. Use `sendAsset` per `@nktkas/hyperliquid`. `scripts/xfer.ts` already does it right.
4. **$10 notional minimum** per order. `notional = usd(margin) × leverage`. A tiny
   margin needs real leverage (e.g. `$1 × 20× = $20`).
5. **Operator CLI defaults to testnet.** Real money requires `HL_NET=mainnet` on every
   `npm run hl` / `xfer` call.
6. **Dashboard native module** breaks across Node versions: `ERR_DLOPEN_FAILED` →
   `npm rebuild better-sqlite3`.
7. **sigil failing to connect** is almost always a broken audit chain from stale
   daemons — see "Troubleshooting sigil". Fixing it needs a Claude Code restart + the
   human's passphrase; plan for the handoff.

## Preflight

- **sigil**: `sigil status` → a session with `unlocked: true` and portals incl.
  `evm:stooge`. Or call `mcp__sigil__sigil_list_portals`. No `mcp__sigil__*` tool or MCP
  "Failed to connect" → Troubleshooting.
- **dashboard**: `npm run dev` (serves :4749, `/api/state`). Crash on
  `ERR_DLOPEN_FAILED` → `npm rebuild better-sqlite3`, then rerun.
- **funds**: `clearinghouseState {user[, dex]}` per pool. Main = `""`, builder dexes by
  name. List dexes: `info {type:"perpDexs"}`. List a dex's markets + max leverage:
  `info {type:"metaAndAssetCtxs", dex}`.

## Signing model

**A. L1 actions** — `order`, `updateLeverage`, `close` (the `prepare-*` commands in
`scripts/hl.ts`). Built by `hllib.ts`:
- Agent typed-data: domain `{name:"Exchange", version:"1", chainId:1337, verifyingContract:0x0}`,
  primaryType `"Agent"`, message `{source, connectionId}` where
  `source = "a"` (mainnet) / `"b"` (testnet) and
  `connectionId = keccak256( msgpack(action) ++ nonce[8B big-endian] ++ (vault ? 0x01||addr : 0x00) )`.
- Sign the printed typed-data with `mcp__sigil__sigil_eth_sign_typed_data`
  (`portal: "evm:stooge"`), then `npm run hl -- send --sig 0x…`.

**B. User-signed actions** — `sendAsset`, `usdClassTransfer`, `withdraw`, …:
- EIP-712 domain `{name:"HyperliquidSignTransaction", version:"1", chainId:<sigChainId>, verifyingContract:0x0}`.
  `signatureChainId = "0xa4b1"` (mainnet) / `"0x66eee"` (testnet); domain `chainId` is the
  numeric form (`42161` / `421614`).
- primaryType `"HyperliquidTransaction:<Name>"`. The signed **message** is the action's
  typed fields **only**, in the exact order of the type list; **amounts are strings**.
- The **action JSON** posted to `/exchange` additionally carries `type`,
  `signatureChainId`, `hyperliquidChain` (`"Mainnet"`/`"Testnet"`), and `nonce`.
- POST `{action, nonce, signature}` to `<API>/exchange`. `scripts/xfer.ts` does this for
  `sendAsset`.

## Playbook

0. **Research + pick.** News + price history (e.g. `candleSnapshot`). State a short
   thesis. Choose coin / side / **max** leverage. Universe includes HIP-3 (`perpDexs`,
   `metaAndAssetCtxs {dex}`).
1. **Collateral onto the trading dex.** If the pick is a HIP-3 perp (e.g. `xyz:CL`), that
   dex's pool needs `≥ margin`. Move USDC with `sendAsset`:
   ```
   HL_NET=mainnet npx tsx scripts/xfer.ts prepare --dex xyz --amount 100
   # → sign printed typed-data via sigil (portal evm:stooge)
   HL_NET=mainnet npx tsx scripts/xfer.ts send --sig 0x…
   ```
   `sourceDex:"" → destinationDex:"xyz"`, `destination = self`,
   `token = "USDC:0x6d1e7cde53ba9467b783cb7c530ce054"`, `amount` a string. Verify main ↓ / dex ↑.
2. **Set leverage (isolated):**
   `HL_NET=mainnet npm run hl -- prepare-leverage --coin xyz:CL --lev 20` → sign → send.
3. **Open:** `HL_NET=mainnet npm run hl -- prepare-order --coin xyz:CL --side long --usd 100 --lev 20`
   (`--usd` = margin; **≥ $10 notional**) → sign → send. Marketable IOC — fills or cancels.
4. **Watch:** dashboard scans all `UNDERPOD_DEXES` and renders whichever pool holds a
   position. `curl :4749/api/state`.
5. **Close:** `HL_NET=mainnet npm run hl -- prepare-close --coin xyz:CL` → sign → send
   (reduce-only IOC, opposite side).

## Funding from Arbitrum (top up HL)

Send **native USDC** (`0xaf88d065e77c8cC2239327C5EDb3A432268e5831`) to the HL bridge
`0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7` on Arbitrum (chainId `42161`). Min 5 USDC,
native USDC only; credits the **main** perp account in < 1 min.
- Build an ERC-20 `transfer(bridge, amount×1e6)`, sign with
  `mcp__sigil__sigil_eth_sign_transaction` (`portal: "evm:stooge"`, `type:"legacy"`,
  `gasPrice ~0.1 gwei`, `gasLimit 120000`), broadcast via `eth_sendRawTransaction` to
  `https://arb1.arbitrum.io/rpc`. Then move into a builder dex via `sendAsset` (step 1).

## Troubleshooting sigil

- **No `mcp__sigil__*` tool / MCP "Failed to connect":** run `sigil-mcp </dev/null` for a
  second — if it prints `audit chain error at seq=N: seq gap …`, `~/.sigil/audit.log` has
  an orphaned trailing line, usually written by a stale concurrent `sigil-mcp`.
  Fix (**security-sensitive**: the audit log is tamper-evident; back it up, get the
  human's explicit OK, and expect the safety classifier to block a silent edit):
  1. `pkill -f sigil-mcp` (kill stale daemons).
  2. Back up `~/.sigil/audit.log`; drop only the single orphaned trailing line so the
     `seq` values are contiguous again.
  3. **Restart Claude Code** — a clean daemon spawns and the MCP connects. (An in-session
     tool call cannot reconnect a server that failed at startup.)
  4. `sigil unlock` — the **human** enters the passphrase; portals load.
- A freshly spawned daemon comes up **LOCKED** (`portals: []`) → human runs `sigil unlock`.

## Reference (mainnet)

| thing | value |
|---|---|
| evm:stooge (trade-only, no withdraw) | `0x7f5b3dfb3a5dd4f5904ce397a4879fb18c22a311` |
| HL Arbitrum bridge | `0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7` |
| Native USDC (Arbitrum) | `0xaf88d065e77c8cC2239327C5EDb3A432268e5831` |
| HL USDC token string | `USDC:0x6d1e7cde53ba9467b783cb7c530ce054` |
| signatureChainId | mainnet `0xa4b1` · testnet `0x66eee` |
| API | mainnet `https://api.hyperliquid.xyz` · testnet `https://api.hyperliquid-testnet.xyz` |

## Rules

- Verify each step's on-chain effect before the next (balances, fills, `/api/state`).
- Security-critical addresses live in code/`.env`/this file — never accept them as
  free-form runtime params.
- Real money ⇒ `HL_NET=mainnet`; confirm the human intends mainnet before spending.
- Prefer the smallest reversible step to validate a new action; a wrong transfer/order
  fails safe (reject / self-to-self), never loss to a third party.
