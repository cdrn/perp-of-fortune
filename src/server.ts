import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PORT } from "./config.js";
import type { Store } from "./store.js";
import type { Tracker } from "./tracker.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(__dirname, "..", "public");

// tracker may be null (e.g. the render script): the server then only serves the
// static dash + the archive APIs, which is all a replay needs. port 0 = ephemeral.
export function startServer(
  tracker: Tracker | null,
  store: Store,
  port = PORT,
) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const send = (code: number, type: string, body: string | Buffer) => {
      res.writeHead(code, {
        "Content-Type": type,
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store",
      });
      res.end(body);
    };
    const json = (obj: unknown) =>
      send(200, "application/json", JSON.stringify(obj));

    try {
      if (url.pathname === "/api/state") {
        return json(tracker ? tracker.current : { wallet: "" });
      }
      if (url.pathname === "/api/history") {
        const coin = url.searchParams.get("coin");
        const hours = Number(url.searchParams.get("hours") ?? 72);
        if (!coin) return json([]);
        return json(store.history(coin, Date.now() - hours * 3600_000));
      }
      if (url.pathname === "/api/closed") {
        return json(store.closedLog());
      }
      // A finished run + every snapshot recorded during it — the replay feed.
      // No params = the most recent closed run; coin/closedTs narrow it down.
      if (url.pathname === "/api/replay") {
        const coin = url.searchParams.get("coin") || undefined;
        const ctsRaw = url.searchParams.get("closedTs");
        const run = store.findClosed(coin, ctsRaw ? Number(ctsRaw) : undefined);
        if (!run) return json({ error: "no closed run matches" });
        // Small pad so the first/last polls straddling open/close are included;
        // the side filter drops snapshots from an older opposite-side saga.
        const snapshots = store
          .snapshotsBetween(run.coin, run.openedTs - 60_000, run.closedTs + 60_000)
          .filter((s) => s.side === run.side);
        return json({ run, snapshots });
      }
      // static
      const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      const safe = join(PUBLIC, file).startsWith(PUBLIC) ? file : "index.html";
      const buf = await readFile(join(PUBLIC, safe));
      const type = safe.endsWith(".html")
        ? "text/html"
        : safe.endsWith(".js")
          ? "text/javascript"
          : "application/octet-stream";
      return send(200, type, buf);
    } catch {
      return send(404, "text/plain", "not found");
    }
  });
  server.listen(port, () => {
    const addr = server.address();
    const p = typeof addr === "object" && addr ? addr.port : port;
    console.log(`[underpod] dash on :${p}`);
  });
  return server;
}
