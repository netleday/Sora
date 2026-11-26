/* discord.ts — Sora's status in Discord (Rich Presence, 1.4 Live; src-tauri/src/discord.rs keeps
 * the connection and the pace). While osu! plays a map (tosu, lib/tosu-follow): the map with its
 * mods, accuracy, combo and pp as they go, the pulse (lib/heart), the chart's stars at the rate,
 * patterns and dan, its cover, and buttons to the map and to Sora's site. In song select, the map
 * being picked. Without osu!, the song Sora itself plays, as music. Nothing otherwise.
 *
 * Built once a second and handed over when it changed; Discord takes an update every few seconds,
 * so the numbers are a few seconds behind. What it says: lib/discord-activity. */
import { api, isTauri } from "./api";
import { musicActivity, osuActivity, type Activity } from "./discord-activity";
import { heart } from "./heart";
import { events, store } from "./store";
import { STATE, type TosuNow } from "./tosu";
import { follow } from "./tosu-follow";
import type { MapRow, SetRow } from "./types";
import { player } from "../player";

/** ms between looks at what to show */
const EVERY = 1000;
/** a play's start moves only when it's off by more than this (a retry, a seek), ms */
const JUMP = 2500;

class Presence {
  private timer = 0;
  private sent = "";
  private maps = new Map<string, string | null>();
  private playStart: number | null = null;
  private playMd5 = "";

  init(): void {
    if (!isTauri) return;
    const apply = () => (store.prefs.discord ? this.start() : this.stop());
    apply();
    events.on("prefs", (p) => ("discord" in p || "discordPulse" in p) && apply());
  }

  private start(): void {
    if (this.timer) return;
    this.timer = window.setInterval(() => void this.look(), EVERY);
    void this.look();
  }

  private stop(): void {
    clearInterval(this.timer);
    this.timer = 0;
    this.send(null);
  }

  private send(a: Activity | null): void {
    const json = JSON.stringify(a);
    if (json === this.sent) return;
    this.sent = json;
    void api.discordSet(a).catch(() => {});
  }

  /** the library's difficulty with this MD5 (looked up once) */
  private async map(md5: string): Promise<{ m: MapRow; set: SetRow } | null> {
    let id = this.maps.get(md5);
    if (id === undefined) {
      id = await api.mapByMd5(md5).catch(() => null);
      this.maps.set(md5, id);
    }
    const snap = store.snap;
    const m = id && snap ? snap.maps.find((x) => x.id === id) : undefined;
    return m && snap ? { m, set: snap.sets[m.set] } : null;
  }

  private async look(): Promise<void> {
    const now = follow.connected ? follow.latest : null;
    if (now && now.md5 && now.state !== STATE.menu) {
      const found = await this.map(now.md5);
      if (!this.timer) return;
      this.send(osuActivity(now, found?.m ?? null, found?.set ?? null, store.prefs.discordPulse ? heart.bpm : null, this.started(now)));
      return;
    }
    this.playMd5 = "";
    // osu! isn't on a map: Sora's own music, if it plays
    const np = player.now;
    const snap = store.snap;
    if (np && player.playing && !follow.alongside && snap?.maps[np.map]) {
      const m = snap.maps[np.map];
      const a = player.audio;
      const len = Number.isFinite(a.duration) ? a.duration : m.length / 1000;
      const act = musicActivity(m, snap.sets[m.set], a.currentTime, len, player.rate, store.prefs.unicode);
      // the start moves with every look (it's reckoned from now): keep it unless the song jumped
      const before = this.sent ? (JSON.parse(this.sent) as Activity | null) : null;
      const was = (before?.timestamps as { start?: number } | undefined)?.start;
      const is = (act.timestamps as { start: number; end?: number }).start;
      if (was !== undefined && before?.details === act.details && Math.abs(was - is) < JUMP) {
        const shift = was - is;
        const ts = act.timestamps as { start: number; end?: number };
        act.timestamps = { start: was, ...(ts.end !== undefined ? { end: ts.end + shift } : {}) };
      }
      this.send(act);
      return;
    }
    this.send(null);
  }

  /** when the play under way began (wall clock), steady through the play: null outside one */
  private started(now: TosuNow): number | null {
    if (now.state !== STATE.play) {
      this.playMd5 = "";
      return null;
    }
    const begun = Date.now() - Math.round(Math.max(0, now.live) / now.rate);
    if (this.playMd5 !== now.md5 || this.playStart === null || Math.abs(begun - this.playStart) > JUMP) {
      this.playMd5 = now.md5;
      this.playStart = begun;
    }
    return this.playStart;
  }
}

export const presence = new Presence();
