/* heart-stats.ts — what the pulse during a try came to, and over many (History's heart rate).
 * The readings come from a heart rate monitor (src-tauri/src/heart.rs, ./heart); a try keeps them
 * against the song (lib/attempts). */

/** The pulse during a try: [song ms, beats per minute], about one a second, and what it came to. */
export interface HeartTrack {
  samples: [number, number][];
  avg: number;
  max: number;
  min: number;
  /** the average in the map's fastest part (null without its chart) */
  fast: number | null;
  /** the beats' spacing: [song ms, ms since the beat before] (straps that send it; none before 1.5) */
  rr?: [number, number][];
  /** RMSSD over the whole try, ms (null with too few beats) */
  hrv?: number | null;
}

/** a try needs this many readings for its pulse to count */
export const MIN_SAMPLES = 3;

/** The average of the readings within song ms a–b; null with fewer than two there. */
export function averageIn(samples: readonly [number, number][], a: number, b: number): number | null {
  const in_ = samples.filter(([t]) => t >= a && t <= b);
  if (in_.length < 2) return null;
  return in_.reduce((s, [, bpm]) => s + bpm, 0) / in_.length;
}

/** What the readings of a try came to; `fast`: the map's fastest part (song ms), if known. Null
 * with too few readings. */
export function summarize(samples: readonly [number, number][], fast: { a: number; b: number } | null = null, rr: readonly [number, number][] = []): HeartTrack | null {
  const ok = samples.filter(([, bpm]) => bpm > 0);
  if (ok.length < MIN_SAMPLES) return null;
  const bpms = ok.map(([, bpm]) => bpm);
  const avg = bpms.reduce((s, v) => s + v, 0) / bpms.length;
  const beats = rr.filter(([, ms]) => ms > 0 && ms <= 5000).map(([t, ms]): [number, number] => [Math.round(t), Math.round(ms)]);
  return {
    samples: ok.map(([t, bpm]) => [Math.round(t), Math.round(bpm)]),
    avg: Math.round(avg * 10) / 10,
    max: Math.max(...bpms),
    min: Math.min(...bpms),
    fast: fast ? round1(averageIn(ok, fast.a, fast.b)) : null,
    rr: beats,
    hrv: round1(rmssd(beats)),
  };
}

// ── HRV: how evenly the heart beats (lower while stressed) ──────────────
//
// RMSSD, the root mean square of the differences between neighbouring beats' spacings. Over half a
// minute it's a tendency, not a measurement: good enough to see where a map got to you.

/** spacings outside this (ms) aren't beats (a strap's glitch) */
const RR_MIN = 300;
const RR_MAX = 2000;
/** a spacing this much off the one before is an artefact, left out */
const RR_JUMP = 0.2;
/** RMSSD needs at least this many differences */
const MIN_DIFFS = 15;

/** The squared differences between neighbouring beats that look real. */
function diffs(rr: readonly [number, number][]): number[] {
  const out: number[] = [];
  for (let i = 1; i < rr.length; i++) {
    const a = rr[i - 1][1];
    const b = rr[i][1];
    if (a < RR_MIN || a > RR_MAX || b < RR_MIN || b > RR_MAX || Math.abs(b - a) > a * RR_JUMP) continue;
    out.push((b - a) * (b - a));
  }
  return out;
}

/** RMSSD of these beats, ms; null with too few. */
export function rmssd(rr: readonly [number, number][]): number | null {
  const d = diffs(rr);
  return d.length < MIN_DIFFS ? null : Math.sqrt(d.reduce((s, v) => s + v, 0) / d.length);
}

/** the HRV curve's window and step, real seconds (song ms = real ms × rate) */
export const HRV_WINDOW = 30_000;
const HRV_STEP = 2000;

/** RMSSD over the half minute around each moment of the song: [song ms, ms], every 2 s. Centred,
 * not trailing: it's drawn after the try, and a drop then shows where it happened, not 15 s on. */
export function hrvCurve(rr: readonly [number, number][], rate = 1): [number, number][] {
  if (rr.length < MIN_DIFFS + 1) return [];
  const half = (HRV_WINDOW * rate) / 2;
  const step = HRV_STEP * rate;
  const out: [number, number][] = [];
  let from = 0;
  for (let at = rr[0][0] + step; at <= rr[rr.length - 1][0] + step / 2; at += step) {
    while (from < rr.length && rr[from][0] < at - half) from++;
    let to = from;
    while (to < rr.length && rr[to][0] <= at + half) to++;
    const v = rmssd(rr.slice(from, to));
    if (v !== null) out.push([Math.round(at), Math.round(v * 10) / 10]);
  }
  return out;
}

/** A stretch where the nerves set in: the pulse climbing fast while the HRV falls away. */
export interface NerveSpot {
  /** song ms */
  a: number;
  b: number;
  /** how far the pulse climbed within the 15 s before, bpm */
  rise: number;
  /** how far the HRV fell below the try's usual, 0–1 */
  drop: number;
}

/** the pulse has to climb this much (bpm) within NERVE_RISE_WINDOW real ms */
const NERVE_RISE = 10;
const NERVE_RISE_WINDOW = 15_000;
/** and the HRV be this far below the try's median */
const NERVE_DROP = 0.35;

/** Where the pulse climbs at least 10 bpm within 15 s while the HRV is a third or more below the
 * try's median: the moments a map got to you. Neighbouring moments are one spot. */
export function nerveSpots(samples: readonly [number, number][], curve: readonly [number, number][], rate = 1): NerveSpot[] {
  if (curve.length < 5 || samples.length < 2) return [];
  const sorted = curve.map(([, v]) => v).sort((x, y) => x - y);
  const median = sorted[Math.floor(sorted.length / 2)];
  if (median <= 0) return [];
  const riseWin = NERVE_RISE_WINDOW * rate;
  const join = HRV_STEP * rate * 2.5;
  const spots: NerveSpot[] = [];
  for (const [at, v] of curve) {
    const drop = 1 - v / median;
    if (drop < NERVE_DROP) continue;
    let now: number | null = null;
    let low = Infinity;
    for (const [t, bpm] of samples) {
      if (t < at - riseWin || t > at) continue;
      low = Math.min(low, bpm);
      now = bpm;
    }
    if (now === null || now - low < NERVE_RISE) continue;
    const rise = now - low;
    const last = spots[spots.length - 1];
    if (last && at - last.b <= join) {
      last.b = at;
      last.rise = Math.max(last.rise, rise);
      last.drop = Math.max(last.drop, drop);
    } else spots.push({ a: at, b: at, rise, drop });
  }
  return spots.map((s) => ({ ...s, drop: Math.round(s.drop * 100) / 100 }));
}

const round1 = (v: number | null): number | null => (v === null ? null : Math.round(v * 10) / 10);

/** A try's pulse in short (the totals' rows, src-tauri/src/attempts.rs). */
export interface HeartTry {
  id: number;
  md5: string;
  mode: number;
  started: number;
  outcome: "pass" | "fail" | "quit" | "retry";
  mods: string;
  avg: number;
  max: number;
  min: number;
  fast: number | null;
  /** RMSSD over the try (null without the beats' spacing) */
  hrv: number | null;
}

/** One difficulty's tries with a pulse, put together. */
export interface HeartMap {
  md5: string;
  mode: number;
  tries: number;
  avg: number;
  max: number;
  min: number;
  fast: number | null;
  /** the HRV over its tries that have one (RMSSD, ms) */
  hrv: number | null;
  last: number;
}

/** Everything with a pulse, put together. */
export interface HeartTotals {
  tries: number;
  /** the average over all tries (each try counts once) */
  avg: number;
  /** the highest and lowest reading of all, with the try they came in */
  max: { bpm: number; md5: string; started: number } | null;
  min: { bpm: number; md5: string; started: number } | null;
  /** the average in the fastest parts (tries with a chart) */
  fast: number | null;
  /** passes against the rest */
  passAvg: number | null;
  restAvg: number | null;
  /** the HRV over the tries that have one (RMSSD, ms), and passes against the rest */
  hrv: number | null;
  passHrv: number | null;
  restHrv: number | null;
  /** per day: the average, the highest and the HRV, oldest first */
  days: { day: string; avg: number; max: number; hrv: number | null; tries: number }[];
  /** per difficulty, the most played first */
  maps: HeartMap[];
}

const mean = (v: number[]): number | null => (v.length ? v.reduce((s, x) => s + x, 0) / v.length : null);

/** "2026-11-14" in local time */
export const dayOf = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** The totals of many tries (any order). Null without any. */
export function totals(list: readonly HeartTry[]): HeartTotals | null {
  if (!list.length) return null;
  let max: HeartTotals["max"] = null;
  let min: HeartTotals["min"] = null;
  const byDay = new Map<string, HeartTry[]>();
  const byMap = new Map<string, HeartTry[]>();
  for (const x of list) {
    if (!max || x.max > max.bpm) max = { bpm: x.max, md5: x.md5, started: x.started };
    if (!min || x.min < min.bpm) min = { bpm: x.min, md5: x.md5, started: x.started };
    const day = dayOf(x.started);
    byDay.set(day, [...(byDay.get(day) ?? []), x]);
    byMap.set(x.md5, [...(byMap.get(x.md5) ?? []), x]);
  }
  const fasts = list.flatMap((x) => (x.fast === null ? [] : [x.fast]));
  /** the tries' HRVs, those without one left out */
  const hrvOf = (xs: readonly HeartTry[]): number | null => mean(xs.flatMap((x) => (x.hrv == null ? [] : [x.hrv])));
  const days = [...byDay.entries()]
    .map(([day, xs]) => ({ day, avg: mean(xs.map((x) => x.avg))!, max: Math.max(...xs.map((x) => x.max)), hrv: hrvOf(xs), tries: xs.length }))
    .sort((a, b) => a.day.localeCompare(b.day));
  const maps = [...byMap.entries()]
    .map(([md5, xs]) => {
      const f = xs.flatMap((x) => (x.fast === null ? [] : [x.fast]));
      return { md5, mode: xs[0].mode, tries: xs.length, avg: mean(xs.map((x) => x.avg))!, max: Math.max(...xs.map((x) => x.max)), min: Math.min(...xs.map((x) => x.min)), fast: mean(f), hrv: hrvOf(xs), last: Math.max(...xs.map((x) => x.started)) };
    })
    .sort((a, b) => b.tries - a.tries || b.last - a.last);
  return {
    tries: list.length,
    avg: mean(list.map((x) => x.avg))!,
    max,
    min,
    fast: mean(fasts),
    passAvg: mean(list.filter((x) => x.outcome === "pass").map((x) => x.avg)),
    restAvg: mean(list.filter((x) => x.outcome !== "pass").map((x) => x.avg)),
    hrv: hrvOf(list),
    passHrv: hrvOf(list.filter((x) => x.outcome === "pass")),
    restHrv: hrvOf(list.filter((x) => x.outcome !== "pass")),
    days,
    maps,
  };
}
