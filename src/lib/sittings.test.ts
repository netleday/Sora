import { describe, expect, it } from "vitest";
import { byDay, dayShift, GAP, mapsOf, sitEvents, sittings, skillsMoved, spent, weekShift, weekStart, weekSum, type SitTry } from "./sittings";
import type { Play } from "./types";

const MIN = 60_000;
/** Wednesday 19 Nov 2025, 18:00 local time */
const AT = new Date(2025, 10, 19, 18, 0).getTime();

const tryAt = (start: number, minutes: number, outcome: SitTry["outcome"], map = "a"): SitTry => ({
  md5: `${map}`.padEnd(32, "0"),
  mode: 3,
  started: start,
  ended: start + minutes * MIN,
  outcome,
  rate: 1,
  map,
});

const play = (date: number, extra: Partial<Play> = {}): Play => ({ map: "a", mode: 3, date, rank: 4, acc: 0.95, score: 900_000, combo: 500, source: "lazer", ...extra });

const twoMinutes = () => 2 * MIN;

describe("sitEvents", () => {
  it("a play that ended with a try is that try", () => {
    const tries = [tryAt(AT, 2, "pass")];
    const events = sitEvents([play(AT + 2 * MIN + 5_000)], tries, twoMinutes, AT - MIN, AT + 60 * MIN);
    expect(events).toHaveLength(1);
    expect(events[0].attempt).toBe(tries[0]);
    expect(events[0].play?.acc).toBe(0.95);
  });

  it("plays without a try last as long as their map at their rate", () => {
    const events = sitEvents([play(AT, { rate: 1.5 })], [], () => 3 * MIN, AT - 10 * MIN, AT + MIN);
    expect(events[0].end - events[0].start).toBe(2 * MIN);
  });

  it("keeps fails, quits and retries that never got a score", () => {
    const tries = [tryAt(AT, 1, "fail"), tryAt(AT + 2 * MIN, 0.5, "retry"), tryAt(AT + 3 * MIN, 2, "pass")];
    const events = sitEvents([], tries, twoMinutes, AT, AT + 60 * MIN);
    expect(events.map((e) => e.outcome)).toEqual(["fail", "retry", "pass"]);
  });

  it("leaves out what's outside the time", () => {
    expect(sitEvents([play(AT - MIN)], [tryAt(AT + 61 * MIN, 1, "pass")], twoMinutes, AT, AT + 60 * MIN)).toEqual([]);
  });

  it("a fail doesn't take a pass's score", () => {
    const events = sitEvents([play(AT + MIN)], [tryAt(AT, 1, "fail")], twoMinutes, AT - 10 * MIN, AT + 60 * MIN);
    expect(events).toHaveLength(2);
  });
});

describe("sittings", () => {
  it("a break of half an hour starts a new one", () => {
    const tries = [tryAt(AT, 2, "pass"), tryAt(AT + 10 * MIN, 2, "fail"), tryAt(AT + 12 * MIN + GAP, 2, "pass", "b")];
    const list = sittings(sitEvents([], tries, twoMinutes, AT, AT + 3 * 3600_000));
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ passes: 1, fails: 1, maps: 1, playing: 4 * MIN });
    expect(list[1]).toMatchObject({ passes: 1, maps: 1 });
  });

  it("counts overlapping goes once", () => {
    // a play from osu! whose length was guessed, over a try
    const events = sitEvents([play(AT + 3 * MIN, { map: "b" })], [tryAt(AT, 2, "pass")], () => 2 * MIN, AT - MIN, AT + 60 * MIN);
    expect(sittings(events)[0].playing).toBe(3 * MIN);
  });
});

describe("weeks", () => {
  it("start on Monday at midnight", () => {
    const monday = weekStart(AT);
    expect(new Date(monday).getDay()).toBe(1);
    expect(new Date(monday).getHours()).toBe(0);
    expect(new Date(monday).getDate()).toBe(17);
    expect(new Date(weekShift(AT, -1)).getDate()).toBe(10);
    expect(weekStart(monday)).toBe(monday);
    expect(new Date(dayShift(monday, 6)).getDate()).toBe(23);
  });

  it("sum up and split by day", () => {
    const monday = weekStart(AT);
    const late = dayShift(monday, 1) - 10 * MIN;
    const tries = [tryAt(late, 20, "pass"), tryAt(AT, 5, "quit", "b"), tryAt(AT + 6 * MIN, 5, "pass", "b")];
    const list = sittings(sitEvents([], tries, twoMinutes, monday, weekShift(monday, 1)));
    const sum = weekSum(list);
    expect(sum).toMatchObject({ sittings: 2, days: 2, tries: 3, passes: 2, quits: 1, maps: 2, playing: 30 * MIN, longest: 20 * MIN });
    // the late one goes past midnight: ten minutes on Monday, ten on Tuesday
    expect(byDay(list, monday)).toEqual([10 * MIN, 10 * MIN, 10 * MIN, 0, 0, 0, 0]);
  });

  it("lists a sitting's maps, most goes first, with the best pass", () => {
    const tries = [tryAt(AT, 1, "fail", "b"), tryAt(AT + 2 * MIN, 2, "pass", "a"), tryAt(AT + 5 * MIN, 2, "pass", "b")];
    const plays = [play(AT + 4 * MIN, { acc: 0.9 }), play(AT + 7 * MIN, { map: "b", acc: 0.97 })];
    const maps = mapsOf(sittings(sitEvents(plays, tries, twoMinutes, AT - MIN, AT + 60 * MIN))[0].events);
    expect(maps.map((m) => [m.key, m.events.length, m.passes, m.best?.acc])).toEqual([
      ["b", 2, 1, 0.97],
      ["a", 1, 1, 0.9],
    ]);
  });
});

describe("skillsMoved", () => {
  const points = [
    { date: 100, values: [20, 19, 18] },
    { date: 200, values: [20.5, 19, 18.004] },
    { date: 300, values: [21, 19.2, 18.004] },
  ];

  it("names the skills that went up", () => {
    expect(skillsMoved(points, 150, 250)).toEqual([{ index: 0, before: 20, after: 20.5 }]);
    expect(skillsMoved(points, 150, 350).map((s) => s.index)).toEqual([0, 1]);
  });

  it("a first week has everything new", () => {
    expect(skillsMoved(points, 50, 150).map((s) => s.before)).toEqual([null, null, null]);
    expect(skillsMoved(points, 10, 50)).toEqual([]);
  });
});

it("says time in hours and minutes", () => {
  expect(spent(0)).toBe("0 min");
  expect(spent(20_000)).toBe("1 min");
  expect(spent(40 * MIN)).toBe("40 min");
  expect(spent(60 * MIN)).toBe("1 h");
  expect(spent(95 * MIN)).toBe("1 h 35 min");
});
