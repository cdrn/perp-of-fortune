import { DB_PATH, WALLET } from "./config.js";
import { startServer } from "./server.js";
import { Store } from "./store.js";
import { Tracker } from "./tracker.js";
import { EpisodeTracker } from "./episode-tracker.js";

const store = new Store(DB_PATH);
const tracker = new Tracker(store);
tracker.start();
const episodeTracker = new EpisodeTracker();
episodeTracker.start();
startServer(tracker, store, undefined, episodeTracker);

console.log(
  `[underpod] permanent underpod — tracking ${WALLET || "(no wallet set)"}`,
);
