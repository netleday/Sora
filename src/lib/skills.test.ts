import { describe, expect, it } from "vitest";
import {
  aggregate, aimFor, bestPerChart, FEW_PLAYS, foundVibro, keyModes, looksOverrated, MORE_SUGGESTIONS, msdAt, OVERRATED, practice, rateFor, skillHistory, skills, SKILLSETS, suggest,
  type MsdRows, type Skill,
} from "./skills";
import type { MapRow, MsdSkill, Play } from "./types";

const map = (id: string, extra: Partial<MapRow> = {}): MapRow => ({
  set: 0, id, version: id, mode: 3, status: 1, sr: 4, bpm: 180, length: 120_000, objects: 1000, holds: 0,
  hp: 8, cs: 4, od: 8, ar: 0, ...extra,
});

/** an SSR row: overall, then the skillsets (at 0.8× overall unless given) */
const ssrs = (overall: number, skill: Partial<Record<MsdSkill, number>> = {}): number[] => [overall, ...SKILLSETS.map((s) => skill[s] ?? overall * 0.8)];

const play = (mapId: string, overall: number, extra: Partial<Play> = {}, skill: Partial<Record<MsdSkill, number>> = {}): Play => ({
  map: mapId, mode: 3, date: 1_000, rank: 4, acc: 0.96, score: 900_000, combo: 500, source: "lazer", wife: 0.95, ssr: ssrs(overall, skill), ...extra,
});

const K = (s: MsdSkill) => SKILLSETS.indexOf(s);

describe("aggregate", () => {
  it("blends skillsets into overall as Etterna does", () => {
    // a player's seven skillsets and overall as mania-tracker shows them (MinaCalc, Etterna's formula)
    expect(aggregate([33.7, 33.41, 32.87, 32.2, 32.17, 31.82, 23.72], 0.1, 1.125)).toBeCloseTo(32.82, 1);
  });

  it("takes a fair number of good plays to get up to your level", () => {
    const at = (n: number) => aggregate(Array(n).fill(30));
    expect(at(1)).toBeLessThan(at(10));
    expect(at(10)).toBeLessThan(at(50));
    expect(at(1)).toBeCloseTo(23.73, 1);
    expect(at(50)).toBeCloseTo(30.84, 1);
    // an easier play never lowers it
    expect(aggregate([30, 30, 20])).toBeCloseTo(aggregate([30, 30]));
    expect(aggregate([])).toBe(0);
    // sorted or not, the same
    const mixed = [12, 31, 25, 7, 28, 30, 19];
    expect(aggregate(mixed)).toBeCloseTo(aggregate([...mixed].sort((a, b) => b - a), 0.1, 1.05, true), 9);
  });
});

describe("skills", () => {
  const maps = [
    map("a", { notesKey: "k-a" }),
    map("b"),
    map("c"),
    map("seven", { cs: 7 }),
    map("taiko", { mode: 1 }),
    // a rate edit of a: the same notes, faster
    map("a-1.1x", { notesKey: "k-a" }),
  ];
  const ids = new Map(maps.map((m, i) => [m.id, i]));
  const index = (id: string | undefined) => (id === undefined ? undefined : ids.get(id));

  it("counts each chart's best pass per rate in the key mode, without mods that change it", () => {
    const plays = [
      play("a", 20),
      play("a", 22),
      play("a", 25, { mods: ["DT"], rate: 1.5 }),
      play("b", 30, { failed: true, rank: -1 }),
      play("b", 28, { mods: ["HO"] }),
      play("b", 18, { mods: ["HD", "MR"], date: 5_000 }),
      play("c", 15, { ssr: undefined }),
      play("seven", 26),
      play("taiko", 26, { mode: 1 }),
    ];
    const charts = bestPerChart(plays, index, maps, 4);
    expect(charts.map((c) => [c.map.id, c.ssr[0]])).toEqual([
      ["a", 25],
      ["a", 22],
      ["b", 18],
    ]);
    // a point in time: only what was played by then
    expect(bestPerChart(plays, index, maps, 4, { until: 1_000 }).map((c) => c.map.id)).toEqual(["a", "a"]);
  });

  it("counts a chart's best two rates, its rate edits as that chart", () => {
    const plays = [
      play("a", 22),
      play("a", 21, { rate: 1.2, mods: ["DT"] }),
      // the edit at 1×: a rate of a, its best there counts
      play("a-1.1x", 24),
      play("a-1.1x", 23),
      play("a", 26, { rate: 1.5, mods: ["DT"] }),
      play("b", 18),
    ];
    const charts = bestPerChart(plays, index, maps, 4);
    expect(charts.map((c) => [c.map.id, c.ssr[0]])).toEqual([
      ["a", 26],
      ["a-1.1x", 24],
      ["b", 18],
    ]);
    expect(skills(charts).skills[0].plays).toBe(3);
  });

  it("leaves out the charts you left out, with their rate edits", () => {
    const plays = [play("a", 22), play("a-1.1x", 24), play("b", 18), play("c", 16)];
    const left = (keys: string[]) => bestPerChart(plays, index, maps, 4, { leftOut: new Set(keys) }).map((c) => c.map.id);
    expect(left(["k-a"])).toEqual(["b", "c"]);
    // left out by its id (before its notes key was known)
    expect(left(["a"])).toEqual(["a-1.1x", "b", "c"]);
    expect(left(["b"])).toEqual(["a-1.1x", "a", "c"]);
    expect(left([])).toEqual(["a-1.1x", "a", "b", "c"]);
    const points = skillHistory(plays, index, maps, 4, new Set(["k-a"]));
    expect(points[points.length - 1].values[0]).toBeCloseTo(skills(bestPerChart(plays, index, maps, 4, { leftOut: new Set(["k-a"]) })).overall!);
  });

  it("leaves out passes on vibro, and lists the charts", () => {
    const plays = [
      play("a", 22, { vibro: "adjusted" }),
      play("b", 30, { vibro: "vibro", date: 2_000 }),
      play("b", 31, { vibro: "vibro", rate: 1.2, mods: ["DT"], date: 3_000 }),
      play("c", 28, { vibro: "unrateable" }),
      play("c", 18),
    ];
    // adjusted counts (its SSR is on what's left), vibro and unrateable don't
    expect(bestPerChart(plays, index, maps, 4).map((c) => [c.map.id, c.ssr[0]])).toEqual([
      ["a", 22],
      ["c", 18],
    ]);
    expect(foundVibro(plays, index, maps, 4).map((f) => [f.map.id, f.kind, f.rates])).toEqual([
      ["b", "vibro", [1, 1.2]],
      ["c", "unrateable", [1]],
    ]);
    expect(foundVibro(plays, index, maps, 7)).toEqual([]);
  });

  it("marks plays worth far more than the skill once it has filled up", () => {
    expect(looksOverrated(30 * OVERRATED + 0.01, 30, FEW_PLAYS)).toBe(true);
    expect(looksOverrated(30 * OVERRATED - 0.01, 30, FEW_PLAYS)).toBe(false);
    // still filling up: the skill trails the best plays anyway
    expect(looksOverrated(40, 30, FEW_PLAYS - 1)).toBe(false);
    expect(looksOverrated(40, null, 100)).toBe(false);
    // a skillset of even plays with one far above it
    const many = Array.from({ length: 40 }, (_, i) => map(`m${i}`));
    const at = new Map(many.map((m, i) => [m.id, i]));
    const idx = (id: string | undefined) => (id === undefined ? undefined : at.get(id));
    const even = many.slice(1).map((m) => play(m.id, 20, {}, { stream: 20 }));
    const sheet = (top: number) => skills(bestPerChart([play("m0", 20, {}, { stream: top }), ...even], idx, many, 4)).skills[K("stream")];
    expect(sheet(21).overrated).toBe(0);
    const farmed = sheet(30);
    expect(farmed.overrated).toBe(1);
    expect(farmed.top[0].worth).toBe(30);
  });

  it("blends each skillset's SSRs and the seven into overall", () => {
    const plays = [play("a", 22, {}, { jumpstream: 21, jackspeed: 12 }), play("b", 20, {}, { jumpstream: 19, jackspeed: 18 }), play("c", 16)];
    const sheet = skills(bestPerChart(plays, index, maps, 4));
    expect(sheet.plays).toBe(3);
    const js = sheet.skills[K("jumpstream")];
    expect(js.value).toBeCloseTo(aggregate([21, 19, 16 * 0.8]));
    expect(js.top.map((c) => c.worth)).toEqual([21, 19, 16 * 0.8]);
    // the plays above the rating carry it
    expect(js.carrying).toBe([21, 19, 16 * 0.8].filter((v) => v > js.value! / 1.05).length);
    expect(js.carrying).toBeGreaterThan(0);
    // a skillset's best plays are its own
    expect(sheet.skills[K("jackspeed")].top.map((c) => c.map.id)).toEqual(["b", "c", "a"]);
    expect(sheet.overall).toBeCloseTo(aggregate(sheet.skills.map((s) => s.value!), 0.1, 1.125));
    expect(skills([]).overall).toBeNull();
    expect(skills([]).skills[0].value).toBeNull();
  });

  it("follows the skills day by day", () => {
    const at = (d: number, h = 12) => Date.UTC(2026, 9, 1 + d, h);
    const plays = [
      play("a", 20, { date: at(0, 10) }, { jumpstream: 21 }),
      play("b", 18, { date: at(0, 15) }),
      // the next day: a worse play on a (nothing moves), then c
      play("a", 19, { date: at(1) }),
      play("c", 22, { date: at(3) }, { jackspeed: 25 }),
      // a better play on a, at another rate too
      play("a", 24, { date: at(5) }, { jumpstream: 26 }),
      play("a", 23, { date: at(5, 13), rate: 1.1, mods: ["DT"] }),
      play("b", 30, { date: at(6), failed: true }),
    ];
    const points = skillHistory(plays, index, maps, 4);
    expect(points.map((p) => p.date)).toEqual([at(0, 15), at(3), at(5, 13)]);
    expect(points[0].values[1 + K("jumpstream")]).toBeCloseTo(aggregate([21, 18 * 0.8]));
    // the last point is what the skills say now
    const now = skills(bestPerChart(plays, index, maps, 4));
    expect(points[2].values[0]).toBeCloseTo(now.overall!);
    now.skills.forEach((s, k) => expect(points[2].values[k + 1]).toBeCloseTo(s.value!));
    // and every point is what they said then
    const then = skills(bestPerChart(plays, index, maps, 4, { until: at(3) }));
    expect(points[1].values[0]).toBeCloseTo(then.overall!);
    expect(skillHistory(plays, index, maps, 7)).toEqual([]);
  });

  it("follows a chart's best two rates over time", () => {
    const at = (d: number) => Date.UTC(2026, 9, 1 + d, 12);
    const plays = [
      play("a", 20, { date: at(0) }),
      play("a", 22, { date: at(1), rate: 1.1, mods: ["DT"] }),
      // a third rate under the two: nothing moves
      play("a", 19, { date: at(2), rate: 0.9, mods: ["HT"] }),
      // one over them: it takes the place of the lower
      play("a-1.1x", 25, { date: at(3) }),
      play("b", 18, { date: at(4) }),
    ];
    const points = skillHistory(plays, index, maps, 4);
    expect(points.map((p) => p.date)).toEqual([at(0), at(1), at(3), at(4)]);
    for (const [i, d] of [at(0), at(1), at(3), at(4)].entries()) {
      const then = skills(bestPerChart(plays, index, maps, 4, { until: d }));
      expect(points[i].values[0]).toBeCloseTo(then.overall!);
      then.skills.forEach((s, k) => expect(points[i].values[k + 1]).toBeCloseTo(s.value!));
    }
  });

  it("lists key modes by rated plays", () => {
    const plays = [play("a", 20), play("b", 20), play("seven", 20), play("c", 20, { ssr: undefined }), play("taiko", 20, { mode: 1 })];
    expect(keyModes(plays, index, maps)).toEqual([
      { keys: 4, plays: 2 },
      { keys: 7, plays: 1 },
    ]);
  });
});

/** MSD at 0.7× … 2.0× for a chart whose MSD grows with the rate: `base` at 1×, its skillsets at
 * the given shares of it (0.8 unless given) */
const rowsOf = (base: number, share: Partial<Record<MsdSkill, number>> = {}): MsdRows =>
  Array.from({ length: 14 }, (_, i) => {
    const v = base * (0.7 + i * 0.1);
    return [v, ...SKILLSETS.map((s) => v * (share[s] ?? 0.8))];
  });

describe("msdAt", () => {
  it("reads the tenths and the lines between them", () => {
    const rows = rowsOf(20);
    expect(msdAt(rows, 1)![0]).toBeCloseTo(20);
    expect(msdAt(rows, 1.05)![0]).toBeCloseTo(21);
    expect(msdAt(rows, 0.7)![0]).toBeCloseTo(14);
    expect(msdAt(rows, 2)![0]).toBeCloseTo(40);
    expect(msdAt(rows, 0.5)).toBeNull();
    expect(msdAt(rows, 2.1)).toBeNull();
    expect(msdAt(rows.slice(0, 5), 1)).toBeNull();
  });
});

describe("practice", () => {
  const k = K("jackspeed");
  const jack = { jackspeed: 1 };
  const aim = { from: 20, base: 20, lo: 20.2, ideal: 21, hi: 22 };
  const sk = (skillset: MsdSkill, value: number | null): Skill => ({
    skillset, value, plays: value === null ? 0 : 5, carrying: value === null ? 0 : 3, overrated: 0, top: value === null ? [] : [{ worth: value } as never],
  });

  it("aims a little above your best plays, or under the weakest for a skillset without any", () => {
    const all = [sk("stream", 20), sk("jumpstream", 25), sk("jackspeed", null)];
    const a = aimFor(all[0], all)!;
    expect(a.from).toBe(20);
    expect(a.lo).toBeCloseTo(20.2);
    expect(a.ideal).toBeCloseTo(21);
    expect(a.hi).toBeCloseTo(22);
    const first = aimFor(all[2], all)!;
    expect(first.from).toBeNull();
    expect(first.base).toBeCloseTo(20 * 0.92);
    expect(aimFor(sk("stream", null), [sk("stream", null)])).toBeNull();
  });

  it("plays at 1× when that fits, else at the rate nearest the sweet spot", () => {
    expect(rateFor(rowsOf(21, jack), k, aim)).toMatchObject({ rate: 1, msd: 21 });
    // 25 at 1×: 21.25 at 0.85×
    const slow = rateFor(rowsOf(25, jack), k, aim)!;
    expect(slow.rate).toBe(0.85);
    expect(slow.msd).toBeCloseTo(21.25);
    // 15 at 1×: 21 at 1.4×
    expect(rateFor(rowsOf(15, jack), k, aim)!.rate).toBe(1.4);
    // out of reach between 0.75× and 1.5×, or not about jacks
    expect(rateFor(rowsOf(40, jack), k, aim)).toBeNull();
    expect(rateFor(rowsOf(21, { jackspeed: 0.8, stream: 1 }), k, aim)).toBeNull();
  });

  const pool = [
    map("heavy", { set: 1 }),
    map("heavy-hd", { set: 1 }),
    map("slow", { set: 2 }),
    map("far", { set: 3 }),
    map("blurry", { set: 4 }),
    map("thin", { set: 5 }),
    map("seven", { set: 6, cs: 7 }),
    map("hidden", { set: 7, hidden: true }),
  ];
  const rows: Record<string, MsdRows> = {
    heavy: rowsOf(21, jack),
    "heavy-hd": rowsOf(21.5, jack),
    slow: rowsOf(25, jack),
    far: rowsOf(40, jack),
    // jacks is a little under its hardest skillset: still about jacks
    blurry: rowsOf(21, { ...jack, stream: 1.05 }),
    // far under it: not
    thin: rowsOf(21, { ...jack, stream: 1.2 }),
    seven: rowsOf(21, jack),
    hidden: rowsOf(21, jack),
  };
  const msdOf = (i: number) => rows[pool[i].id];
  const ids = new Map(pool.map((m, i) => [m.id, i]));
  const index = (id: string | undefined) => (id === undefined ? undefined : ids.get(id));
  const picks = (charts: ReturnType<typeof bestPerChart>, played?: Set<number>) => suggest(k, aim, charts, pool, 4, msdOf, { played }).map((p) => p.map.id);

  it("suggests charts about the skillset near the sweet spot, one per set", () => {
    // heavy beats its set's other difficulty, a rate costs a little
    expect(picks([])).toEqual(["heavy", "blurry", "slow"]);
    const [first] = suggest(k, aim, [], pool, 4, msdOf);
    expect(first).toMatchObject({ rate: 1, msd: 21, focus: 1 });
    // what a pass at 93% Wife (worth its MSD) makes of the skill
    expect(first.after).toBeCloseTo(aggregate([21]));
    expect(suggest(k, aim, [], pool, 4, msdOf, { exclude: new Set([ids.get("heavy")!, ids.get("heavy-hd")!]) }).map((p) => p.map.id)).toEqual(["blurry", "slow"]);
    // charts without an MSD yet are left out
    expect(suggest(k, aim, [], pool, 4, () => undefined)).toEqual([]);
    // and those left out of the skills
    expect(suggest(k, aim, [], pool, 4, msdOf, { leftOut: new Set(["heavy", "heavy-hd"]) }).map((p) => p.map.id)).toEqual(["blurry", "slow"]);
    // and vibro charts (a new library snapshot: the pool is kept per snapshot)
    const vibroPool = pool.map((m) => (m.id === "blurry" ? { ...m, vibro: 2 } : m.id === "slow" ? { ...m, vibro: 1 } : m));
    expect(suggest(k, aim, [], vibroPool, 4, msdOf).map((p) => p.map.id)).toEqual(["heavy", "slow"]);
  });

  it("works out the skill after a pass with the chart's best two rates", () => {
    const at = (rate: number, jackspeed: number) => play("heavy", 22, { rate, mods: rate === 1 ? [] : ["DT"] }, { jackspeed });
    const onHeavy = (charts: ReturnType<typeof bestPerChart>) =>
      suggest(k, aim, charts, pool, 4, msdOf, { exclude: new Set([ids.get("heavy-hd")!]) }).find((p) => p.map.id === "heavy")!;
    // two rates on it already, both under the pick: a pass at 1× takes the lower one's place
    const two = onHeavy(bestPerChart([at(1.1, 19), at(1.2, 18)], index, pool, 4));
    expect(two).toMatchObject({ rate: 1, msd: 21 });
    expect(two.after).toBeCloseTo(aggregate([21, 19]));
    // at the rate of one of them: in its place, the other stays
    expect(onHeavy(bestPerChart([at(1, 19), at(1.2, 18)], index, pool, 4)).after).toBeCloseTo(aggregate([21, 18]));
  });

  it("puts charts you've played after new ones and leaves out what you've passed at the aim", () => {
    const tried = bestPerChart([play("heavy", 22, {}, { jackspeed: 19 })], index, pool, 4);
    // set 1 now leads with its untouched difficulty
    expect(picks(tried)).toEqual(["blurry", "heavy-hd", "slow"]);
    const passed = bestPerChart([play("heavy", 22, {}, { jackspeed: 21 }), play("heavy-hd", 22, {}, { jackspeed: 21 })], index, pool, 4);
    expect(picks(passed)).toEqual(["blurry", "slow"]);
  });

  it("goes weakest first and suggests a chart once", () => {
    const maps = [map("jk", { set: 1 }), map("tech", { set: 2 }), map("both", { set: 3 })];
    const msd: MsdRows[] = [rowsOf(18.9, { jackspeed: 1 }), rowsOf(22.05, { technical: 1 }), rowsOf(19, { jackspeed: 1, technical: 1 })];
    const values: Record<MsdSkill, number> = { stream: 25, jumpstream: 24, handstream: 23, stamina: 26, jackspeed: 18, chordjack: 22, technical: 21 };
    const now = SKILLSETS.map((s) => sk(s, values[s]));
    const plan = practice(now, [], maps, 4, (i) => msd[i]);
    // those with something in reach first, weakest first; the rest after
    expect(plan.map((p) => p.skill.skillset)).toEqual(["jackspeed", "technical", "chordjack", "handstream", "jumpstream", "stream", "stamina"]);
    expect(plan[0].picks.map((p) => p.map.id)).toEqual(["jk", "both"]);
    expect(plan[1].picks.map((p) => p.map.id)).toEqual(["tech"]);
    // what isn't on screen is still free for the next skillset
    expect(practice(now, [], maps, 4, (i) => msd[i], { shown: () => 0 })[1].picks.map((p) => p.map.id)).toEqual(["tech", "both"]);
    expect(plan[0].picks.length).toBeLessThanOrEqual(MORE_SUGGESTIONS);
  });
});
