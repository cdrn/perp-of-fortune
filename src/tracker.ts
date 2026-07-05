import { POLL_MS, WALLET } from "./config.js";
import {
  clearinghouseState,
  markAndFunding,
  userFills,
  type Fill,
  type RawPosition,
} from "./hyperliquid.js";
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

// The fill that opened the current streak: newest fill where the position size
// going in was zero. Null when fills don't reach back that far (or the fetch failed).
function openFillTs(fills: Fill[], coin: string): number | null {
  const f = fills
    .filter((f) => f.coin === coin && Number(f.startPosition) === 0 && /open/i.test(f.dir))
    .sort((a, b) => b.time - a.time)[0];
  return f ? f.time : null;
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
  // Once per process start we reconcile the stored open row against fills, in
  // case the position was closed and re-rolled while the tracker was down.
  private reconciled = false;

  constructor(private store: Store) {}

  // Retire a tracked position using its closing fills: real final PnL, real
  // close time, and liquidation detected from the fill itself (isolated-margin
  // liquidations don't dent accountValue, so that's the only reliable signal).
  private closeTracked(coin: string, now: number, fills: Fill[]): void {
    const open = this.store.getOpen(coin);
    if (!open) return;
    const closing = fills.filter(
      (f) =>
        f.coin === coin &&
        f.time >= open.openedTs &&
        (f.liquidation != null || /close|liquidat|>/i.test(f.dir)),
    );
    let wasLiq = closing.some((f) => f.liquidation != null || /liquidat/i.test(f.dir));
    let finalPnl = closing.reduce((sum, f) => sum + Number(f.closedPnl || 0), 0);
    let closedTs = closing.length ? Math.max(...closing.map((f) => f.time)) : now;
    if (!closing.length) {
      // Fills unavailable → fall back to the last thing the tracker saw.
      const snap = this.store.lastSnapshot(coin);
      finalPnl = snap?.pnl ?? 0;
      wasLiq = snap?.distToLiqPct != null && snap.distToLiqPct < 1.5;
    }
    this.store.closePosition(coin, closedTs, finalPnl, wasLiq);
  }

  get current(): TrackerState {
    // Mark stale if we haven't refreshed in 3 poll intervals.
    return { ...this.state, stale: Date.now() - this.state.updatedTs > POLL_MS * 3 };
  }

  async tick(): Promise<void> {
    if (!WALLET) return;
    const now = Date.now();
    const [chs, ctx] = await Promise.all([
      clearinghouseState(WALLET),
      markAndFunding(),
    ]);

    // Pick the largest open position by notional — the show tracks one at a time.
    const positions = chs.assetPositions
      .map((p) => p.position)
      .filter((p) => Number(p.szi) !== 0)
      .sort((a, b) => Math.abs(Number(b.positionValue)) - Math.abs(Number(a.positionValue)));

    // Fills are only fetched on ticks where something opened, closed, or
    // flipped — one lazy request shared by everything below.
    let fillsCache: Fill[] | null = null;
    const getFills = async (): Promise<Fill[]> => {
      if (fillsCache === null) {
        try {
          fillsCache = await userFills(WALLET);
        } catch {
          fillsCache = [];
        }
      }
      return fillsCache;
    };

    const liveCoins = new Set(positions.map((p) => p.coin));
    // Close out any tracked position that vanished from chain.
    for (const coin of this.store.openCoins()) {
      if (!liveCoins.has(coin)) {
        this.closeTracked(coin, now, await getFills());
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

    let open = this.store.getOpen(top.coin);
    // Same coin, opposite side → the old saga ended and a new roll began.
    if (open && open.side !== side) {
      this.closeTracked(top.coin, now, await getFills());
      open = undefined;
    }
    // First tick after a restart: if fills show a fresh open newer than the
    // stored row, the coin was closed and re-rolled while we were dark.
    if (open && !this.reconciled) {
      const ts = openFillTs(await getFills(), top.coin);
      if (ts && ts > open.openedTs + 60_000) {
        this.closeTracked(top.coin, ts, await getFills());
        open = undefined;
      }
    }
    this.reconciled = true;
    if (!open) {
      open = {
        coin: top.coin,
        side,
        entryPx: Number(top.entryPx ?? mark),
        leverage: top.leverage?.value ?? 1,
        // Age from the actual open fill, not from when the tracker first looked.
        openedTs: openFillTs(await getFills(), top.coin) ?? now,
      };
      this.store.insertOpen(open);
    }

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
