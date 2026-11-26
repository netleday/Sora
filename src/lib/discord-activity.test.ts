import { describe, expect, it } from "vitest";
import { chartWords, musicActivity, osuActivity, playWords } from "./discord-activity";
import type { TosuNow } from "./tosu";
import type { MapRow, SetRow } from "./types";

type Step = Partial<Omit<TosuNow, "play">> & { play?: Partial<TosuNow["play"]> };

function msg(s: Step = {}): TosuNow {
  return {
    md5: "174589aaaaaaaaaaaaaaaaaaaaaaaaaa",
    beatmapId: 4210,
    setId: 1984,
    state: 2,
    live: 30_000,
    rate: 1,
    pitch: false,
    artist: "Camellia",
    title: "Dystopia",
    version: "Extreme",
    paused: false,
    client: "lazer",
    mode: 3,
    keys: 4,
    firstObject: 1000,
    lastObject: 120_000,
    mapCombo: null,
    inBreak: false,
    results: null,
    ...s,
    play: { failed: false, accuracy: 98.4167, score: 0, maxCombo: 412, combo: 412, misses: 0, breaks: 0, hits: 900, health: null, rank: "S", pp: 187.4, mods: "", modList: [], judges: { geki: 0, n300: 0, katu: 0, n100: 0, n50: 0, miss: 0 }, player: "DerTesti", me: "DerTesti", ...s.play },
  };
}

const MAP = { set: 0, id: "m", onlineId: 4210, version: "Extreme", mode: 3, status: 1, sr: 5.41, srDt: 7.02, srHt: 4.1, bpm: 200, length: 150_000, objects: 1000, holds: 50, hp: 8, cs: 4, od: 8, ar: 5, category: "Jumpstream", dan: "6 || 4" } as unknown as MapRow;
const SET = { id: "s", onlineId: 1984, status: 1, title: "Dystopia", artist: "Camellia", creator: "x", maps: [0] } as unknown as SetRow;

describe("Discord status", () => {
  it("says the chart in a few words, stars at the rate", () => {
    expect(chartWords(MAP, 1)).toMatch(/^5\.41★ · Jumpstream · /);
    expect(chartWords(MAP, 1.5)).toMatch(/^7\.02★/);
    // no stars it doesn't know (a rate without a number)
    expect(chartWords(MAP, 1.2)).toMatch(/^Jumpstream/);
    expect(chartWords(null, 1)).toBe("");
  });

  it("says the play as it goes, the pulse last", () => {
    expect(playWords(msg(), 142.4)).toBe("98.42% · 412x · 187 pp · ♥ 142");
    expect(playWords(msg({ play: { pp: null } }), null)).toBe("98.42% · 412x");
    // before the first note: only the pulse
    expect(playWords(msg({ play: { hits: 0 } }), 120)).toBe("♥ 120");
  });

  it("shows a play with its mods, cover, chart, time left and both buttons", () => {
    const a = osuActivity(msg({ rate: 1.5, play: { modList: ["HD", "DT"] } }), MAP, SET, 150, 1_000_000)!;
    expect(a.type).toBe(0);
    expect(a.details).toBe("Camellia - Dystopia [Extreme] +HDDT");
    expect(a.state).toBe("98.42% · 412x · 187 pp · ♥ 150");
    expect(a.assets).toEqual({ large_image: "https://assets.ppy.sh/beatmaps/1984/covers/list@2x.jpg", large_text: expect.stringMatching(/^7\.02★ · Jumpstream/) });
    expect(a.timestamps).toEqual({ start: 1_000_000, end: 1_100_000 });
    expect(a.buttons).toEqual([
      { label: "Map", url: "https://osu.ppy.sh/b/4210" },
      { label: "Fumen", url: "https://fumen.dertesti.dev" },
    ]);
  });

  it("song select shows the map being picked, results the result, menus nothing", () => {
    expect(osuActivity(msg({ state: 5 }), MAP, SET, null, null)!.state).toMatch(/^Picking a map · 5\.41★/);
    const r = osuActivity(msg({ state: 7, results: { scoreId: 1, rank: "SS", accuracy: 100, score: 1, maxCombo: 1, pp: 301.2 } }), MAP, SET, null, null)!;
    expect(r.state).toBe("SS · 100.00% · 301 pp");
    expect(r.timestamps).toBeUndefined();
    expect(osuActivity(msg({ state: 0 }), MAP, SET, null, null)).toBeNull();
  });

  it("a map osu! doesn't know online gets no map button and no cover", () => {
    const a = osuActivity(msg({ beatmapId: 0, setId: 0 }), null, null, null, 5)!;
    expect(a.buttons).toEqual([{ label: "Fumen", url: "https://fumen.dertesti.dev" }]);
    expect(a.assets).toBeUndefined();
    expect((a.details as string).length).toBeLessThanOrEqual(128);
  });

  it("Fumen's own music is listening, with the song's time", () => {
    const a = musicActivity(MAP, SET, 30, 150, 1, false, 2_000_000);
    expect(a.type).toBe(2);
    expect(a.details).toBe("Dystopia");
    expect(a.state).toBe("by Camellia");
    expect(a.timestamps).toEqual({ start: 1_970_000, end: 2_120_000 });
    expect(a.buttons).toEqual([
      { label: "Map", url: "https://osu.ppy.sh/beatmapsets/1984" },
      { label: "Fumen", url: "https://fumen.dertesti.dev" },
    ]);
  });
});
