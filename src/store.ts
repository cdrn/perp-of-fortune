import Database from "better-sqlite3";

// One row per poll while a position is open → drives the PnL history chart and
// the "time alive" clock. Plus an open-position registry (first-seen ts) and a
// closed log so the saga survives across episodes.
export interface Snapshot {
  ts: number;
  coin: string;
  side: string;
  pnl: number;
  mark: number;
  fundingPaid: number;
  distToLiqPct: number | null;
  accountValue: number;
}

export interface OpenPosition {
  coin: string;
  side: string;
  entryPx: number;
  leverage: number;
  openedTs: number;
}

// A finished saga from the closed log — the unit a replay renders.
export interface ClosedRun {
  coin: string;
  side: string;
  entryPx: number;
  leverage: number;
  openedTs: number;
  closedTs: number;
  finalPnl: number;
  wasLiquidated: number;
}

export class Store {
  private db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS snapshots (
        ts INTEGER NOT NULL,
        coin TEXT NOT NULL,
        side TEXT NOT NULL,
        pnl REAL NOT NULL,
        mark REAL NOT NULL,
        funding_paid REAL NOT NULL,
        dist_liq REAL,
        account_value REAL NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_snap_ts ON snapshots(ts);
      CREATE TABLE IF NOT EXISTS tracking_scope (id INTEGER PRIMARY KEY CHECK (id = 1), scope TEXT NOT NULL);

      CREATE TABLE IF NOT EXISTS open_position (
        coin TEXT PRIMARY KEY,
        side TEXT NOT NULL,
        entry_px REAL NOT NULL,
        leverage REAL NOT NULL,
        opened_ts INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS closed_position (
        coin TEXT NOT NULL,
        side TEXT NOT NULL,
        entry_px REAL NOT NULL,
        leverage REAL NOT NULL,
        opened_ts INTEGER NOT NULL,
        closed_ts INTEGER NOT NULL,
        final_pnl REAL NOT NULL,
        was_liquidated INTEGER NOT NULL
      );
    `);
  }

  // Existing scope is enforced even when an episode file has been removed.
  // Legacy mode may continue reading old, unscoped history, but must not claim
  // that historical data belongs to its current account/network.
  bindScope(scope: string, options: { allowUnscopedHistory?: boolean } = {}): void {
    const previous = this.db.prepare("SELECT scope FROM tracking_scope WHERE id = 1").get() as { scope: string } | undefined;
    if (previous && previous.scope !== scope) throw new Error("Tracker database belongs to another wallet/network; choose a separate UNDERPOD_DB");
    if (!previous) {
      const count = this.db.prepare("SELECT (SELECT COUNT(*) FROM snapshots) + (SELECT COUNT(*) FROM open_position) + (SELECT COUNT(*) FROM closed_position) AS n").get() as { n: number };
      if (count.n > 0) {
        if (options.allowUnscopedHistory) return;
        throw new Error("Legacy tracker history has no wallet/network scope; preserve it and choose a new UNDERPOD_DB for paired episodes");
      }
      this.db.prepare("INSERT INTO tracking_scope (id, scope) VALUES (1, ?)").run(scope);
    }
  }

  insertSnapshot(s: Snapshot): void {
    this.db
      .prepare(
        `INSERT INTO snapshots (ts, coin, side, pnl, mark, funding_paid, dist_liq, account_value)
         VALUES (@ts, @coin, @side, @pnl, @mark, @fundingPaid, @distToLiqPct, @accountValue)`,
      )
      .run(s);
  }

  getOpen(coin: string): OpenPosition | undefined {
    return this.db
      .prepare(`SELECT coin, side, entry_px as entryPx, leverage, opened_ts as openedTs FROM open_position WHERE coin = ?`)
      .get(coin) as OpenPosition | undefined;
  }

  insertOpen(p: OpenPosition): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO open_position (coin, side, entry_px, leverage, opened_ts)
         VALUES (@coin, @side, @entryPx, @leverage, @openedTs)`,
      )
      .run(p);
  }

  // Last recorded snapshot for a coin — the fallback close data when the fills
  // API can't tell us how the position ended.
  lastSnapshot(coin: string): { pnl: number; distToLiqPct: number | null } | undefined {
    return this.db
      .prepare(`SELECT pnl, dist_liq as distToLiqPct FROM snapshots WHERE coin = ? ORDER BY ts DESC LIMIT 1`)
      .get(coin) as { pnl: number; distToLiqPct: number | null } | undefined;
  }

  openCoins(): string[] {
    return (
      this.db.prepare(`SELECT coin FROM open_position`).all() as {
        coin: string;
      }[]
    ).map((r) => r.coin);
  }

  // Position no longer present on-chain → move it to the closed log.
  closePosition(
    coin: string,
    closedTs: number,
    finalPnl: number,
    wasLiquidated: boolean,
  ): void {
    const open = this.db
      .prepare(`SELECT coin, side, entry_px as entryPx, leverage, opened_ts as openedTs FROM open_position WHERE coin = ?`)
      .get(coin) as OpenPosition | undefined;
    if (!open) return;
    this.db
      .prepare(
        `INSERT INTO closed_position (coin, side, entry_px, leverage, opened_ts, closed_ts, final_pnl, was_liquidated)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        open.coin,
        open.side,
        open.entryPx,
        open.leverage,
        open.openedTs,
        closedTs,
        finalPnl,
        wasLiquidated ? 1 : 0,
      );
    this.db.prepare(`DELETE FROM open_position WHERE coin = ?`).run(coin);
  }

  history(coin: string, sinceTs: number): Snapshot[] {
    return this.db
      .prepare(
        `SELECT ts, coin, side, pnl, mark, funding_paid as fundingPaid,
                dist_liq as distToLiqPct, account_value as accountValue
         FROM snapshots WHERE coin = ? AND ts >= ? ORDER BY ts ASC`,
      )
      .all(coin, sinceTs) as Snapshot[];
  }

  // Most recent closed run matching the filters — the default replay target.
  findClosed(coin?: string, closedTs?: number): ClosedRun | undefined {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (coin) {
      where.push("coin = ?");
      params.push(coin);
    }
    if (closedTs) {
      where.push("closed_ts = ?");
      params.push(closedTs);
    }
    return this.db
      .prepare(
        `SELECT coin, side, entry_px as entryPx, leverage, opened_ts as openedTs,
                closed_ts as closedTs, final_pnl as finalPnl, was_liquidated as wasLiquidated
         FROM closed_position ${where.length ? "WHERE " + where.join(" AND ") : ""}
         ORDER BY closed_ts DESC LIMIT 1`,
      )
      .get(...params) as ClosedRun | undefined;
  }

  snapshotsBetween(coin: string, t0: number, t1: number): Snapshot[] {
    return this.db
      .prepare(
        `SELECT ts, coin, side, pnl, mark, funding_paid as fundingPaid,
                dist_liq as distToLiqPct, account_value as accountValue
         FROM snapshots WHERE coin = ? AND ts >= ? AND ts <= ? ORDER BY ts ASC`,
      )
      .all(coin, t0, t1) as Snapshot[];
  }

  closedLog(limit = 50) {
    return this.db
      .prepare(
        `SELECT coin, side, entry_px as entryPx, leverage, opened_ts as openedTs,
                closed_ts as closedTs, final_pnl as finalPnl, was_liquidated as wasLiquidated
         FROM closed_position ORDER BY closed_ts DESC LIMIT ?`,
      )
      .all(limit);
  }
}
