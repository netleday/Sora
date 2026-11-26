/* cloud-scores.ts — the player's scores, replays and map list in the cloud
 * (src-tauri/src/cloud_scores.rs), once they turn it on in Settings › osu! account. Saved a little
 * while after a play or a library update, and at the start, when the plays saved from other PCs
 * come in too. Only what the cloud doesn't have yet goes up. */
import { api, asApiError, onCloudProgress, onLivePlay } from "./api";
import { Emitter, events, store } from "./store";
import type { CloudSync } from "./types";

export interface CloudState {
  busy: boolean;
  /** replays sent so far, of how many */
  done?: number;
  of?: number;
  /** the last sync this session, and when */
  last?: CloudSync;
  at?: number;
  error?: string;
}

export const cloudEvents = new Emitter<{ state: CloudState }>();

let state: CloudState = { busy: false };
let running: Promise<CloudSync> | null = null;
let timer: number | undefined;

export const cloudState = (): CloudState => state;
/** turned on, with the online features on */
export const cloudOn = (): boolean => !!store.settings?.cloudScores && !!store.settings?.online;

function set(s: Partial<CloudState>): void {
  state = { ...state, ...s };
  cloudEvents.emit("state", state);
}

/** Saves what's new and takes in the plays from elsewhere (`fetch`: all of them again). Calls while
 * one runs get that one. */
export function syncCloud(fetch = false): Promise<CloudSync> {
  if (running) return running;
  window.clearTimeout(timer);
  running = (async () => {
    set({ busy: true, done: 0, of: 0, error: undefined });
    try {
      const r = await api.cloudScoresSync(fetch);
      set({ busy: false, last: r, at: Date.now() });
      return r;
    } catch (e) {
      set({ busy: false, error: asApiError(e).message });
      throw e;
    } finally {
      running = null;
    }
  })();
  return running;
}

/** A sync in `ms`, unless another comes first (a run of plays makes one sync). */
function later(ms: number): void {
  window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    if (cloudOn()) syncCloud().catch((e) => console.warn("[cloud] scores:", asApiError(e).message));
  }, ms);
}

let started = false;

export function initCloudScores(): void {
  if (started) return;
  started = true;
  void onCloudProgress((p) => state.busy && set({ done: p.done, of: p.of }));
  void onLivePlay(() => later(2 * 60_000));
  events.on("library", () => later(60_000));
  later(20_000);
}
