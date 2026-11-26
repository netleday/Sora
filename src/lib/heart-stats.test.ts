import { describe, expect, it } from "vitest";
import { averageIn, dayOf, hrvCurve, nerveSpots, rmssd, summarize, totals, type HeartTry } from "./heart-stats";

/** Beats at a steady pulse with a given unevenness: [song ms, spacing ms], from `from` to `to`. */
function beats(from: number, to: number, spacing: (i: number) => number, rate = 1): [number, number][] {
  const out: [number, number][] = [];
  let at = from;
  for (let i = 0; at <= to; i++) {
    const ms = spacing(i);
    at += ms * rate;
    out.push([Math.round(at), ms]);
  }
  return out;
}

describe("HRV", () => {
  it("is the RMSSD of the beats' spacing, leaving out glitches", () => {
    // spacings alternating 800 / 820: every difference is 20
    const even = beats(0, 30_000, (i) => (i % 2 ? 820 : 800));
    expect(rmssd(even)).toBeCloseTo(20);
    // a missed beat (1620) and a doubled one (400) don't count
    const glitchy: [number, number][] = [...even.slice(0, 20), [16_000, 1620], [16_400, 400], ...even.slice(20)];
    expect(rmssd(glitchy)).toBeCloseTo(20);
    expect(rmssd(even.slice(0, 10))).toBeNull();
  });

  it("comes with the try's summary", () => {
    const h = summarize([[0, 75], [1000, 75], [2000, 76]], null, beats(0, 30_000, (i) => (i % 2 ? 820 : 800)))!;
    expect(h.hrv).toBe(20);
    expect(h.rr!.length).toBeGreaterThan(30);
    expect(summarize([[0, 75], [1000, 75], [2000, 76]])!.hrv).toBeNull();
  });

  it("follows the song as a curve, the window at the rate", () => {
    // calm (differences of 40) for a minute, then tense (differences of 6)
    const rr = [...beats(0, 60_000, (i) => (i % 2 ? 840 : 800)), ...beats(60_000, 120_000, (i) => (i % 2 ? 506 : 500))];
    const curve = hrvCurve(rr);
    expect(curve.length).toBeGreaterThan(40);
    const near = (ms: number) => curve.reduce((a, b) => (Math.abs(b[0] - ms) < Math.abs(a[0] - ms) ? b : a))[1];
    // the half minute around a moment: a quarter minute either side of the change is clean
    expect(near(40_000)).toBeCloseTo(40, 0);
    expect(near(100_000)).toBeCloseTo(6, 0);
    // at 1.5× the half minute is 45 s of song
    const fast = hrvCurve(beats(0, 90_000, (i) => (i % 2 ? 840 : 800), 1.5), 1.5);
    expect(fast[fast.length - 1][0]).toBeGreaterThan(85_000);
  });

  it("finds where the nerves set in: the pulse climbing while the HRV falls", () => {
    const rr = [...beats(0, 60_000, (i) => (i % 2 ? 840 : 800)), ...beats(60_000, 120_000, (i) => (i % 2 ? 506 : 500))];
    const curve = hrvCurve(rr);
    // the pulse: 75, then from 60 s up to 118 within 12 s, staying there
    const samples: [number, number][] = [];
    for (let s = 0; s <= 120; s++) samples.push([s * 1000, s < 60 ? 75 : Math.min(118, 75 + (s - 60) * 4)]);
    const spots = nerveSpots(samples, curve);
    expect(spots).toHaveLength(1);
    expect(spots[0].a).toBeGreaterThanOrEqual(60_000);
    expect(spots[0].a).toBeLessThan(76_000);
    expect(spots[0].rise).toBeGreaterThanOrEqual(10);
    expect(spots[0].drop).toBeGreaterThan(0.35);
    // the same HRV with a pulse that stays put: no nerves, just a calmer song
    expect(nerveSpots(samples.map(([t]) => [t, 75]), curve)).toEqual([]);
  });
});

describe("a try's pulse", () => {
  const samples: [number, number][] = [
    [0, 100],
    [1000, 110],
    [2000, 0], // no reading
    [3000, 150],
    [4000, 160],
    [5000, 120],
  ];

  it("comes to its average, highest and lowest, leaving out empty readings", () => {
    const h = summarize(samples)!;
    expect(h.samples).toHaveLength(5);
    expect(h.avg).toBe(128);
    expect(h.max).toBe(160);
    expect(h.min).toBe(100);
    expect(h.fast).toBeNull();
  });

  it("knows the pulse in the fastest part", () => {
    expect(summarize(samples, { a: 2500, b: 4500 })!.fast).toBe(155);
    expect(averageIn(samples, 2500, 3500)).toBeNull();
  });

  it("needs a few readings", () => {
    expect(summarize([[0, 90], [1000, 95]])).toBeNull();
    expect(summarize([])).toBeNull();
  });
});

describe("the pulse over many tries", () => {
  const at = (day: number, hour: number) => new Date(2026, 10, day, hour).getTime();
  const tri = (id: number, md5: string, started: number, avg: number, max: number, min: number, outcome: HeartTry["outcome"] = "fail", fast: number | null = null): HeartTry => ({
    id,
    md5,
    mode: 3,
    started,
    outcome,
    mods: "",
    avg,
    max,
    min,
    fast,
    hrv: null,
  });
  const list = [
    { ...tri(1, "a", at(12, 20), 120, 150, 90, "pass", 140), hrv: 40 },
    { ...tri(2, "a", at(12, 21), 130, 170, 100), hrv: 20 },
    tri(3, "b", at(13, 19), 110, 130, 80, "fail", 125),
    { ...tri(4, "a", at(13, 22), 140, 181, 110, "pass", null), hrv: 30 },
  ];

  it("puts them together", () => {
    const s = totals(list)!;
    expect(s.tries).toBe(4);
    expect(s.avg).toBe(125);
    expect(s.max).toEqual({ bpm: 181, md5: "a", started: at(13, 22) });
    expect(s.min).toEqual({ bpm: 80, md5: "b", started: at(13, 19) });
    expect(s.fast).toBe(132.5);
    expect(s.passAvg).toBe(130);
    expect(s.restAvg).toBe(120);
    // the HRV only from the tries that have one: passes calmer than the rest here
    expect(s.hrv).toBe(30);
    expect(s.passHrv).toBe(35);
    expect(s.restHrv).toBe(20);
  });

  it("by day, oldest first, and by difficulty, the most played first", () => {
    const s = totals(list)!;
    expect(s.days.map((d) => [d.day, d.avg, d.max, d.tries])).toEqual([
      [dayOf(at(12, 12)), 125, 170, 2],
      [dayOf(at(13, 12)), 125, 181, 2],
    ]);
    expect(s.maps.map((m) => [m.md5, m.tries, m.max, m.min, m.fast, m.hrv])).toEqual([
      ["a", 3, 181, 90, 140, 30],
      ["b", 1, 130, 80, 125, null],
    ]);
    expect(s.days.map((d) => d.hrv)).toEqual([30, 30]);
  });

  it("is nothing without tries", () => {
    expect(totals([])).toBeNull();
  });
});
