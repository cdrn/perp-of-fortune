// One-off: sendAsset (user-signed EIP-712) — move USDC between the caller's own
// perp dexes. sourceDex "" = main USDC perp; destinationDex "xyz" = the builder
// dex. Signed by the principal via the HyperliquidSignTransaction domain, then
// POSTed to /exchange. Schema per @nktkas/hyperliquid.
//   npm run xfer -- prepare --dex xyz --amount 100
//   npm run xfer -- send --sig 0x…
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { splitSig, NET, IS_MAINNET, API } from "./hllib.js";

const STASH = join(tmpdir(), "underpod-xfer-pending.json");
const USDC = "USDC:0x6d1e7cde53ba9467b783cb7c530ce054"; // mainnet canonical USDC (spotMeta)
const SELF = "0x7f5b3dfb3a5dd4f5904ce397a4879fb18c22a311"; // evm:stooge — self-transfer
const SIG_CHAIN = IS_MAINNET ? "0xa4b1" : "0x66eee";
const HL_CHAIN = IS_MAINNET ? "Mainnet" : "Testnet";

const arg = (n: string): string | undefined => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const TYPES = [
  { name: "hyperliquidChain", type: "string" },
  { name: "destination", type: "string" },
  { name: "sourceDex", type: "string" },
  { name: "destinationDex", type: "string" },
  { name: "token", type: "string" },
  { name: "amount", type: "string" },
  { name: "fromSubAccount", type: "string" },
  { name: "nonce", type: "uint64" },
];

async function main() {
  const cmd = process.argv[2];
  if (cmd === "prepare") {
    const destinationDex = arg("dex") ?? "xyz";
    const sourceDex = arg("from") ?? "";
    const amount = arg("amount") ?? "";
    if (!(Number(amount) > 0)) throw new Error("need --amount > 0");
    if (sourceDex === destinationDex) throw new Error("--from and --dex must differ");
    const nonce = Date.now();
    // message = exactly the EIP-712 fields, in order
    const message = {
      hyperliquidChain: HL_CHAIN,
      destination: SELF,
      sourceDex,
      destinationDex,
      token: USDC,
      amount,
      fromSubAccount: "",
      nonce,
    };
    // action posted to /exchange includes type + signatureChainId
    const action = { type: "sendAsset", signatureChainId: SIG_CHAIN, ...message };
    const typedData = {
      domain: {
        name: "HyperliquidSignTransaction",
        version: "1",
        chainId: parseInt(SIG_CHAIN, 16),
        verifyingContract: "0x0000000000000000000000000000000000000000",
      },
      types: { "HyperliquidTransaction:SendAsset": TYPES },
      primaryType: "HyperliquidTransaction:SendAsset",
      message,
    };
    writeFileSync(STASH, JSON.stringify({ action, nonce }));
    console.log(`[${NET}] prepared: sendAsset $${amount} "${sourceDex}" -> "${destinationDex}"  (nonce ${nonce})`);
    console.log(JSON.stringify(typedData));
  } else if (cmd === "send") {
    const sig = arg("sig");
    if (!sig) throw new Error("need --sig");
    const { action, nonce } = JSON.parse(readFileSync(STASH, "utf8"));
    const body = JSON.stringify({ action, nonce, signature: splitSig(sig) });
    const res = await fetch(`${API}/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    console.log(`HTTP ${res.status}: ${await res.text()}`);
  } else {
    throw new Error("usage: xfer <prepare|send>");
  }
}
main().catch((e) => { console.error(`error: ${e instanceof Error ? e.message : e}`); process.exit(1); });
