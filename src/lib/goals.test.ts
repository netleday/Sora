import { describe, expect, it } from "vitest";
import { bestAcc, goalContext, goalNow, goalTarget, goalTitle, isReached, isRetired, progress, suggestTarget, type Goal, type GoalSpec } from "./goals";
import { aggregate } from "./skills";
import type { MapRow, Play } from "./types";

const map = (id: string, sr: number, shares: number[]): MapRow => ({
  set: 0, id, version: id, mode: 3, status: 1, sr, bpm: 180, length: 120_000, objects: 1000, holds: 0,
  hp: 8, cs: 4, od: 8, ar: 0, shares, srHt: sr * 0.75, srDt: sr * 1.4,
});
const play = (mapId: string, acc: number, extra: Partial<Play> = {}): Play => ({
  map: mapId, mode: 3, date: 1_000, rank: 4, acc, score: 900_000, combo: 500, source: "lazer", ...extra,
});
const goal = (g: GoalSpec & { start: number | null; done?: number }): Goal => ({ id: "g", created: 0, ...g });

describe("goals", () => {
  const maps = [map("a", 4, [0, 0, 0, 0, 60, 0]), map("b", 5, [0, 70, 0, 0, 0, 0])];
  const ids = new Map(maps.map((m, i) => [m.id, i]));
  const index = (id: string | undefined) => (id === undefined ? undefined : ids.get(id));

  it("takes a chart's best pass at the rate or faster, without mods that change it", () => {
    const plays = [
      play("a", 0.95),
      play("a", 0.99, { failed: true }),
      play("a", 0.98, { mods: ["HO"] }),
      play("a", 0.93, { mods: ["DT"], rate: 1.5 }),
      play("a", 0.97, { mods: ["HT"], rate: 0.75 }),
      play("x", 0.92, { map: undefined, beatmapId: 77 }),
    ];
    expect(bestAcc(plays, { map: "a", rate: 1 })).toBe(0.95);
    expect(bestAcc(plays, { map: "a", rate: 1.2 })).toBe(0.93);
    expect(bestAcc(plays, { map: "a", rate: 0.75 })).toBe(0.97);
    // plays osu! knows, matched on its id
    expect(bestAcc(plays, { map: "gone", beatmapId: 77, rate: 1 })).toBe(0.92);
    expect(bestAcc(plays, { map: "b", rate: 1 })).toBeNull();
  });

  it("measures each kind", () => {
    const ctx = goalContext(
      {
        plays: [
          //                                overall, stream, jumpstream, handstream, stamina, jackspeed, chordjack, technical
          play("a", 0.96, { wife: 0.95, ssr: [20, 15, 18, 12, 14, 19, 10, 13] }),
          play("b", 0.96, { wife: 0.95, ssr: [22, 21, 20, 14, 16, 12, 11, 15] }),
        ],
        stats: { mania: { pp: 2400, rank: 30_000 } as never, osu: { pp: 0, rank: null } as never },
      },
      maps,
      index,
    );
    expect(goalNow({ kind: "skill", keys: 4, skillset: "jumpstream", target: 30 }, ctx)).toBeCloseTo(aggregate([18, 20]));
    const seven = [[15, 21], [18, 20], [12, 14], [14, 16], [19, 12], [10, 11], [13, 15]].map((v) => aggregate(v));
    expect(goalNow({ kind: "skill", keys: 4, skillset: "overall", target: 30 }, ctx)).toBeCloseTo(aggregate(seven, 0.1, 1.125));
    expect(goalNow({ kind: "skill", keys: 7, skillset: "jumpstream", target: 30 }, ctx)).toBeNull();
    expect(goalNow({ kind: "chart", map: "b", title: "B", version: "b", acc: 0.97, rate: 1 }, ctx)).toBe(0.96);
    expect(goalNow({ kind: "profile", ruleset: "mania", metric: "pp", target: 3000 }, ctx)).toBe(2400);
    expect(goalNow({ kind: "profile", ruleset: "mania", metric: "rank", target: 20_000 }, ctx)).toBe(30_000);
    // osu! has no rank for this player: nothing to go by
    expect(goalNow({ kind: "profile", ruleset: "osu", metric: "rank", target: 20_000 }, ctx)).toBeNull();
    expect(goalNow({ kind: "profile", ruleset: "taiko", metric: "pp", target: 20_000 }, ctx)).toBeNull();
  });

  it("knows when one is reached, ranks going down", () => {
    expect(isReached({ kind: "skill", keys: 4, skillset: "jackspeed", target: 24 }, 24)).toBe(true);
    expect(isReached({ kind: "skill", keys: 4, skillset: "jackspeed", target: 24 }, 23.99)).toBe(false);
    expect(isReached({ kind: "chart", map: "a", title: "", version: "", acc: 0.96, rate: 1 }, 0.96)).toBe(true);
    expect(isReached({ kind: "profile", ruleset: "mania", metric: "rank", target: 20_000 }, 19_999)).toBe(true);
    expect(isReached({ kind: "profile", ruleset: "mania", metric: "rank", target: 20_000 }, 20_001)).toBe(false);
    expect(isReached({ kind: "profile", ruleset: "mania", metric: "pp", target: 3000 }, null)).toBe(false);
  });

  it("shows how far along it is", () => {
    const skill = goal({ kind: "skill", keys: 4, skillset: "jackspeed", target: 24, start: 20 });
    expect(progress(skill, 20)).toBe(0);
    expect(progress(skill, 22)).toBeCloseTo(0.5);
    expect(progress(skill, 19)).toBe(0);
    expect(progress(skill, 24.2)).toBe(1);
    expect(progress({ ...skill, done: 5 }, 20)).toBe(1);
    // ranks in proportions: halfway from #40,000 to #10,000 is #20,000
    const rank = goal({ kind: "profile", ruleset: "mania", metric: "rank", target: 10_000, start: 40_000 });
    expect(progress(rank, 20_000)).toBeCloseTo(0.5);
    // a chart not passed when the goal was set: from 10 points under
    const chart = goal({ kind: "chart", map: "a", title: "", version: "", acc: 0.96, rate: 1, start: null });
    expect(progress(chart, 0.91)).toBeCloseTo(0.5);
    expect(progress(chart, null)).toBe(0);
  });

  it("suggests a step up", () => {
    expect(suggestTarget("skill", 25.37)).toBe(26);
    expect(suggestTarget("skill", 25.6)).toBe(26.5);
    expect(suggestTarget("skill", null)).toBe(15);
    expect(suggestTarget("chart", 0.912)).toBe(0.96);
    expect(suggestTarget("chart", 0.962)).toBeCloseTo(0.97);
    expect(suggestTarget("chart", 0.998)).toBe(1);
    expect(suggestTarget("pp", 6205)).toBe(6300);
    expect(suggestTarget("rank", 5026)).toBe(4000);
    expect(suggestTarget("rank", 123_456)).toBe(98_000);
  });

  it("puts it in words", () => {
    expect(goalTitle({ kind: "skill", keys: 4, skillset: "jumpstream", target: 25 })).toBe("Jumpstream 4K");
    expect(goalTitle({ kind: "skill", keys: 7, skillset: "overall", target: 25 })).toBe("Overall 7K");
    expect(goalTitle({ kind: "profile", ruleset: "taiko", metric: "rank", target: 4000 })).toBe("osu!taiko rank");
    expect(goalTarget({ kind: "profile", ruleset: "taiko", metric: "rank", target: 4000 })).toBe("#4,000");
    expect(goalTarget({ kind: "chart", map: "a", title: "T", version: "V", acc: 0.96, rate: 1.1 })).toBe("96.00% at 1.10× or faster");
    expect(goalTarget({ kind: "skill", keys: 4, skillset: "stamina", target: 25 })).toBe("25.00");
  });

  it("leaves skill goals from before Etterna's skillsets alone", () => {
    expect(isRetired({ kind: "skill", keys: 4, pattern: "jacks", target: 4 } as never)).toBe(true);
    expect(isRetired({ kind: "skill", keys: 4, skillset: "jackspeed", target: 24 })).toBe(false);
    expect(isRetired({ kind: "profile", ruleset: "mania", metric: "pp", target: 3000 })).toBe(false);
  });
});
