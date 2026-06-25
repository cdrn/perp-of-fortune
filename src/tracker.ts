import { DEX, POLL_MS, WALLET } from "./config.js";
import { clearinghouseState, markAndFunding, type RawPosition } from "./hyperliquid.js";
import { Store } from "./store.js";

// The derived, dashboard-facing view of the tracked position.
export interface PositionView {
  coin: string;
  side: "LONG" | "SHORT";
  size: number; // absolute units
  entryPx: number;
  markPx: number;
  leverage: number;
  notional: number;
  unrealizedPnl: number;
  roiPct: number; // pnl relative to margin posted
  marginUsed: number;
  liqPx: number | null;
  distToLiqPct: number | null; // |mark - liq| / mark
  drownPct: number; // 0 = just opened, 100 = at liquidation
  fundingPaid: number; // cumulative since open; positive = we paid out
  fundingHourly: number; // current hourly bleed in USD; negative = costing us
  openedTs: number;
  ageMs: number;
}

export interface TrackerState {
  wallet: string;
  updatedTs: number;
  accountValue: number;
  withdrawable: number;
  position: PositionView | null;
  stale: boolean;
}

function derive(
  raw: RawPosition,
  mark: number,
  fundingRate: number,
  openedTs: number,
  now: number,
): PositionView {
  const szi = Number(raw.szi);
  const side = szi < 0 ? "SHORT" : "LONG";
  const size = Math.abs(szi);
  const entryPx = Number(raw.entryPx ?? mark);
  const leverage = raw.leverage?.value ?? 1;
  const notional = Math.abs(Number(raw.positionValue));
  const marginUsed = Number(raw.marginUsed);
  const unrealizedPnl = Number(raw.unrealizedPnl);
  const liqPx = raw.liquidationPx ? Number(raw.liquidationPx) : null;

  const distToLiqPct =
    liqPx && mark > 0 ? (Math.abs(mark - liqPx) / mark) * 100 : null;
  // Drowning = how far the mark has travelled from entry toward liquidation.
  // The cushion is the real entry→liq price distance (constant for the life of
  // the position), so a fresh position sits at ~0% and the seabed (liq) is 100%.
  // In profit, the mark is on the safe side of entry → 0% (ship at the surface).
  let drownPct = 0;
  if (liqPx && entryPx > 0) {
    const cushion = Math.abs(entryPx - liqPx);
    const lossDist = side === "LONG" ? entryPx - mark : mark - entryPx; // >0 = losing
    if (cushion > 0) {
      drownPct = Math.max(0, Math.min(100, (lossDist / cushion) * 100));
    }
  }

  // HL funding is hourly; positive rate => longs pay shorts.
  const fundingHourly =
    fundingRate * notional * (side === "LONG" ? -1 : 1);
  const fundingPaid = raw.cumFunding ? Number(raw.cumFunding.sinceOpen) : 0;

  return {
    coin: raw.coin,
    side,
    size,
    entryPx,
    markPx: mark,
    leverage,
    notional,
    unrealizedPnl,
    roiPct: marginUsed > 0 ? (unrealizedPnl / marginUsed) * 100 : 0,
    marginUsed,
    liqPx,
    distToLiqPct,
    drownPct,
    fundingPaid: -fundingPaid, // store reports paid-out as positive; flip so + = earned
    fundingHourly,
    openedTs,
    ageMs: now - openedTs,
  };
}

export class Tracker {
  private state: TrackerState = {
    wallet: WALLET,
    updatedTs: 0,
    accountValue: 0,
    withdrawable: 0,
    position: null,
    stale: true,
  };

  constructor(private store: Store) {}

  get current(): TrackerState {
    // Mark stale if we haven't refreshed in 3 poll intervals.
    return { ...this.state, stale: Date.now() - this.state.updatedTs > POLL_MS * 3 };
  }

  async tick(): Promise<void> {
    if (!WALLET) return;
    const now = Date.now();
    const [chs, ctx] = await Promise.all([
      clearinghouseState(WALLET, DEX),
      markAndFunding(DEX),
    ]);

    // Pick the largest open position by notional — the show tracks one at a time.
    const positions = chs.assetPositions
      .map((p) => p.position)
      .filter((p) => Number(p.szi) !== 0)
      .sort((a, b) => Math.abs(Number(b.positionValue)) - Math.abs(Number(a.positionValue)));

    const liveCoins = new Set(positions.map((p) => p.coin));
    // Close out any tracked position that vanished from chain.
    for (const coin of this.store.openCoins()) {
      if (!liveCoins.has(coin)) {
        // No position row left → infer liquidation if account value collapsed.
        const wasLiq = Number(chs.marginSummary.accountValue) < 1;
        this.store.closePosition(coin, now, 0, wasLiq);
      }
    }

    const top = positions[0];
    if (!top) {
      this.state = {
        wallet: WALLET,
        updatedTs: now,
        accountValue: Number(chs.marginSummary.accountValue),
        withdrawable: Number(chs.withdrawable),
        position: null,
        stale: false,
      };
      return;
    }

    const m = ctx.get(top.coin);
    const mark = m?.markPx ?? Number(top.entryPx ?? 0);
    const fundingRate = m?.funding ?? 0;
    const side = Number(top.szi) < 0 ? "SHORT" : "LONG";

    const open = this.store.upsertOpen({
      coin: top.coin,
      side,
      entryPx: Number(top.entryPx ?? mark),
      leverage: top.leverage?.value ?? 1,
      openedTs: now,
    });

    const view = derive(top, mark, fundingRate, open.openedTs, now);

    this.store.insertSnapshot({
      ts: now,
      coin: view.coin,
      side: view.side,
      pnl: view.unrealizedPnl,
      mark: view.markPx,
      fundingPaid: view.fundingPaid,
      distToLiqPct: view.distToLiqPct,
      accountValue: Number(chs.marginSummary.accountValue),
    });

    this.state = {
      wallet: WALLET,
      updatedTs: now,
      accountValue: Number(chs.marginSummary.accountValue),
      withdrawable: Number(chs.withdrawable),
      position: view,
      stale: false,
    };
  }

  start(): void {
    const loop = async () => {
      try {
        await this.tick();
      } catch (err) {
        console.error(`[underpod] tick: ${err instanceof Error ? err.message : err}`);
      }
    };
    void loop();
    setInterval(() => void loop(), POLL_MS);
  }
}
