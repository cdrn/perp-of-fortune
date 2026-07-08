// Render a finished run into a video artifact — no screen recording, no tabs.
//
//   npm run render                          # latest closed run, 30s highlight
//   npm run render -- --coin xyz:GOLD       # latest closed run for a coin
//   npm run render -- --closedTs 1751999435754 --duration 45
//   npm run render -- --duration real       # full-length 1:1 video for splicing
//
// Spins up its own ephemeral server over the snapshot archive (the live
// dashboard doesn't need to be running), plays the run back in headless
// Chromium via the dash's ?replay mode, and records it with Playwright.
// Output: videos/<coin>-<closed>.mp4 (+ a poster .png of the verdict frame).
//
// --duration real produces a video exactly as long as the run itself, but it
// does NOT record in realtime: it captures at --turbo× fast-forward (default
// 20×) and stretches the timestamps back, so an hour-long run renders in ~3
// minutes. The dash only changes once per poll (~5s), so nothing is lost.
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, renameSync, unlinkSync } from "node:fs";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { DB_PATH } from "../src/config.js";
import { startServer } from "../src/server.js";
import { Store } from "../src/store.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const durArg = arg("duration");
const realtime = durArg === "real" || durArg === "realtime";
const outDir = resolve(arg("out") ?? "videos");
const width = Number(arg("width")) || 1920;
const height = Number(arg("height")) || 1080;

const store = new Store(arg("db") ?? DB_PATH);
const run = store.findClosed(arg("coin"), arg("closedTs") ? Number(arg("closedTs")) : undefined);
if (!run) {
  console.error("no closed run matches. runs on record:");
  for (const r of store.closedLog(20) as { coin: string; side: string; closedTs: number }[]) {
    console.error(`  ${r.side} ${r.coin} closed ${new Date(r.closedTs).toISOString()}  (--coin '${r.coin}' --closedTs ${r.closedTs})`);
  }
  process.exit(1);
}
console.log(
  `[render] ${run.side} ${run.coin} ${run.leverage}× · ${new Date(run.openedTs).toISOString()} → ${new Date(run.closedTs).toISOString()} · final ${run.finalPnl.toFixed(4)}${run.wasLiquidated ? " · LIQUIDATED" : ""}`,
);

// The playback timeline runs first→last snapshot; mirror that here so a 1:1
// video comes out exactly that long and we can report what t=0 corresponds to.
const snaps = store
  .snapshotsBetween(run.coin, run.openedTs - 60_000, run.closedTs + 60_000)
  .filter((s) => s.side === run.side);
if (!snaps.length) {
  console.error("[render] that run left no snapshots behind — nothing to replay");
  process.exit(1);
}
const runSecs = Math.max(1, (snaps[snaps.length - 1]!.ts - snaps[0]!.ts) / 1000);
// Fast-forward factor for 1:1 mode, limited so the capture is never under the
// page's 5s floor (which would break the stretch-back ratio).
const turbo = realtime
  ? Math.min(Math.max(1, Number(arg("turbo")) || 20), runSecs / 5)
  : 1;
const captureSecs = realtime ? runSecs / turbo : Math.max(5, Number(durArg) || 30);

mkdirSync(outDir, { recursive: true });
const server = startServer(null, store, 0);
await once(server, "listening");
const port = (server.address() as AddressInfo).port;

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width, height },
  recordVideo: { dir: outDir, size: { width, height } },
});
const captureT0 = Date.now(); // ≈ when the recording starts (page creation)
const page = await context.newPage();
const url =
  `http://127.0.0.1:${port}/?replay=${encodeURIComponent(run.coin)}` +
  `&closedTs=${run.closedTs}&duration=${captureSecs}&stretch=${turbo.toFixed(4)}`;
console.log(
  realtime
    ? `[render] capturing ${Math.round(captureSecs)}s at ×${turbo.toFixed(1)} → stretching to a ${Math.round(runSecs)}s 1:1 video`
    : `[render] recording a ${Math.round(captureSecs)}s highlight`,
);
await page.goto(url);
await page.waitForFunction(
  `window.__replayDone === true || document.title === "replay-error"`,
  undefined,
  { timeout: (captureSecs + 90) * 1000 },
);
const failed = await page.evaluate("document.title") === "replay-error";
// Capture-time offset of frame 0, used to trim the page-load lead-in so the
// finished video starts exactly on the run's first snapshot.
const replayT0 = failed ? null : ((await page.evaluate("window.__replayT0")) as number);

const stamp = new Date(run.closedTs).toISOString().slice(0, 16).replace(/[:T]/g, "-");
const base = `${run.coin.replace(/[^a-zA-Z0-9]+/g, "-")}-${stamp}`;
const posterPath = join(outDir, `${base}.png`);
if (!failed) await page.screenshot({ path: posterPath });

const video = page.video();
await context.close(); // flushes the recording to disk
await browser.close();
server.close();
if (failed) {
  try {
    unlinkSync(await video!.path());
  } catch {}
  console.error("[render] the replay page reported an error — no video kept");
  process.exit(1);
}

const webmPath = join(outDir, `${base}.webm`);
renameSync(await video!.path(), webmPath);

// webm → mp4 (H.264) so it drops straight into any editor. ffmpeg-static ships
// its own binary; if it's somehow absent, the webm still stands on its own.
// 1:1 mode also trims the lead-in and stretches timestamps back to true speed.
let finalPath = webmPath;
const ffmpeg = createRequire(import.meta.url)("ffmpeg-static") as string | null;
if (ffmpeg) {
  const leadSecs = Math.max(0, ((replayT0 ?? captureT0) - captureT0) / 1000);
  const vf = realtime
    ? `trim=start=${leadSecs.toFixed(3)},setpts=(PTS-STARTPTS)*${turbo.toFixed(4)}`
    : null;
  const mp4Path = join(outDir, `${base}.mp4`);
  const r = spawnSync(ffmpeg, [
    "-y", "-i", webmPath,
    // the stretched verdict hold + teardown would otherwise trail for minutes;
    // cap the 1:1 cut at the run itself plus a 3s beat on the verdict card
    ...(vf ? ["-vf", vf, "-r", "25", "-t", (runSecs + 3).toFixed(3)] : []),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
    "-pix_fmt", "yuv420p", "-movflags", "+faststart",
    mp4Path,
  ]);
  if (r.status === 0) {
    unlinkSync(webmPath);
    finalPath = mp4Path;
  } else {
    console.error(`[render] mp4 conversion failed (${r.status}); keeping webm`);
  }
}
console.log(`[render] video  ${finalPath}`);
console.log(`[render] poster ${posterPath}`);
if (realtime) {
  console.log(
    `[render] splice sync: video t=0 = ${new Date(snaps[0]!.ts).toISOString()} ` +
      `(position opened ${new Date(run.openedTs).toISOString()}); ` +
      `the "Time afloat" tile is the on-screen alignment ruler`,
  );
}
