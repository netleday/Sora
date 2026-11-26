/* sittings.ts — your plays put into sittings and weeks, for History's "Your week".
 *
 * Two sources: the tries Fumen saw through tosu (src/lib/attempts.ts: when each really began and
 * ended, fails, quits and retries included) and the plays lazer, stable and osu! keep (only when
 * they ended, and only the ones that got a score). A play that matches a try is that try; the rest
 * last as long as their map at their rate. A break of half an hour starts a new sitting. */
import type { Outcome } from "./attempts";
import type { SkillPoint } from "./skills";
import type { Play } from "./types";

/** a break this long starts a new sitting */
export const GAP = 30 * 60_000;
/** a play this close to the end of a try at the same map is that try */
const MATCH = 90_000;
/** how long a play lasted when its map's length isn't known */
const GUESS = 2 * 60_000;

/** A try in short (src-tauri/src/attempts.rs, TryTime), with the library difficulty when it's there. */
export interface SitTry {
  md5: string;
  mode: number;
  started: number;
  ended: number;
  outcome: Outcome;
  rate: number;
  map: string | null;
}

/** One go at a map: a try Fumen saw, or a play from lazer, stable or osu!. */
export interface SitEvent {
  start: number;
  end: number;
  mode: number;
  outcome: Outcome;
  map?: string;
  /** a difficulty that isn't in the library (index into History.beatmaps) */
  beatmap?: number;
  play?: Play;
  attempt?: SitTry;
}

/** What a go was at: the library difficulty, else osu!'s, else the MD5. */
export const eventKey = (e: SitEvent): string => e.map ?? (e.beatmap !== undefined ? `b${e.beatmap}` : (e.attempt?.md5 ?? ""));

/** The tries and plays between `from` and `to` (unix ms) as one list, oldest first. A play that is
 * one of the tries joins it; `lengthOf` says how long a map is (ms at 1×), null when not known. */
export function sitEvents(
  plays: readonly Play[],
  tries: readonly SitTry[],
  lengthOf: (p: Play) => number | null,
  from: number,
  to: number,
): SitEvent[] {
  const out: SitEvent[] = tries
    .filter((a) => a.started >= from && a.started < to)
    .map((a) => ({ start: a.started, end: Math.max(a.ended, a.started), mode: a.mode, outcome: a.outcome, map: a.map ?? undefined, attempt: a }));
  for (const p of plays) {
    if (p.date < from || p.date >= to) continue;
    const outcome: Outcome = p.failed ? "fail" : "pass";
    const same = out.find(
      (e) => e.attempt && !e.play && e.outcome === outcome && e.mode === p.mode && (!e.map || !p.map || e.map === p.map) && Math.abs(e.end - p.date) <= MATCH,
    );
    if (same) {
      same.play = p;
      same.map ??= p.map;
      same.beatmap ??= p.beatmap;
      continue;
    }
    const length = (lengthOf(p) ?? GUESS) / (p.rate ?? 1);
    out.push({ start: p.date - length, end: p.date, mode: p.mode, outcome, map: p.map, beatmap: p.beatmap, play: p });
  }
  return out.sort((a, b) => a.start - b.start);
}

export interface Sitting {
  start: number;
  end: number;
  /** time spent in maps, overlaps counted once (ms) */
  playing: number;
  events: SitEvent[];
  passes: number;
  fails: number;
  quits: number;
  retries: number;
  /** different difficulties */
  maps: number;
}

/** The events (oldest first) as sittings, oldest first: a gap of `gap` or more starts a new one. */
export function sittings(events: readonly SitEvent[], gap = GAP): Sitting[] {
  const out: Sitting[] = [];
  let cur: SitEvent[] = [];
  let end = -Infinity;
  const close = () => {
    if (cur.length) out.push(sum(cur));
    cur = [];
  };
  for (const e of events) {
    if (cur.length && e.start - end >= gap) close();
    cur.push(e);
    end = Math.max(end, e.end);
  }
  close();
  return out;
}

/** Time in maps, a stretch where goes overlap counted once (events oldest first). */
function playingTime(events: readonly SitEvent[]): number {
  let playing = 0;
  let reach = -Infinity;
  for (const e of events) {
    const from = Math.max(e.start, reach);
    if (e.end > from) playing += e.end - from;
    reach = Math.max(reach, e.end);
  }
  return playing;
}

function sum(events: SitEvent[]): Sitting {
  const count = (o: Outcome) => events.filter((e) => e.outcome === o).length;
  return {
    start: events[0].start,
    end: Math.max(...events.map((e) => e.end)),
    playing: playingTime(events),
    events,
    passes: count("pass"),
    fails: count("fail"),
    quits: count("quit"),
    retries: count("retry"),
    maps: new Set(events.map(eventKey)).size,
  };
}

/** Monday 00:00 (local time) of the week `ms` is in. */
export function weekStart(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
}

/** The Monday `n` weeks after the week of `ms` (n < 0: before), 00:00 local time. */
export function weekShift(ms: number, n: number): number {
  const d = new Date(weekStart(ms));
  d.setDate(d.getDate() + 7 * n);
  return d.getTime();
}

/** Midnight (local time) `n` days after the day `ms` is on. */
export function dayShift(ms: number, n: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + n);
  return d.getTime();
}

export interface WeekSum {
  playing: number;
  sittings: number;
  /** days with a sitting (by when it started) */
  days: number;
  tries: number;
  passes: number;
  fails: number;
  quits: number;
  retries: number;
  maps: number;
  /** the longest sitting's time in maps */
  longest: number;
}

export function weekSum(list: readonly Sitting[]): WeekSum {
  const maps = new Set<string>();
  for (const s of list) for (const e of s.events) maps.add(eventKey(e));
  const add = (k: "playing" | "passes" | "fails" | "quits" | "retries") => list.reduce((n, s) => n + s[k], 0);
  return {
    playing: add("playing"),
    sittings: list.length,
    days: new Set(list.map((s) => new Date(s.start).toDateString())).size,
    tries: list.reduce((n, s) => n + s.events.length, 0),
    passes: add("passes"),
    fails: add("fails"),
    quits: add("quits"),
    retries: add("retries"),
    maps: maps.size,
    longest: Math.max(0, ...list.map((s) => s.playing)),
  };
}

/** Time in maps on each of the seven days from `monday` (a go across midnight counts on both days). */
export function byDay(list: readonly Sitting[], monday: number): number[] {
  const out: number[] = [];
  for (let d = 0; d < 7; d++) {
    const from = dayShift(monday, d);
    const to = dayShift(monday, d + 1);
    const cut = list
      .flatMap((s) => s.events)
      .filter((e) => e.end > from && e.start < to)
      .map((e) => ({ ...e, start: Math.max(e.start, from), end: Math.min(e.end, to) }))
      .sort((a, b) => a.start - b.start);
    out.push(playingTime(cut));
  }
  return out;
}

/** The difficulties gone at, most goes first: how many, the passes, the best pass. */
export function mapsOf(events: readonly SitEvent[]): { key: string; events: SitEvent[]; passes: number; best?: Play }[] {
  const by = new Map<string, SitEvent[]>();
  for (const e of events) {
    const k = eventKey(e);
    const list = by.get(k);
    if (list) list.push(e);
    else by.set(k, [e]);
  }
  return [...by.entries()]
    .map(([key, events]) => {
      let best: Play | undefined;
      for (const e of events) if (e.play && !e.play.failed && (!best || e.play.acc > best.acc)) best = e.play;
      return { key, events, passes: events.filter((e) => e.outcome === "pass").length, best };
    })
    .sort((a, b) => b.events.length - a.events.length || a.events[0].start - b.events[0].start);
}

/** "1 h 35 min", "40 min", "1 h" */
export function spent(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${Math.max(m, ms > 0 ? 1 : 0)} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}

/** What a skill history said just before `at` (null: nothing yet). */
export function valuesAt(points: readonly SkillPoint[], at: number): number[] | null {
  let found: number[] | null = null;
  for (const p of points) {
    if (p.date >= at) break;
    found = p.values;
  }
  return found;
}

/** The skills (indices into SkillPoint.values: overall, then the skillsets) that went up between
 * `from` and `to`, with where they were and where they got to. */
export function skillsMoved(points: readonly SkillPoint[], from: number, to: number): { index: number; before: number | null; after: number }[] {
  const before = valuesAt(points, from);
  const after = valuesAt(points, to);
  if (!after) return [];
  return after
    .map((v, index) => ({ index, before: before ? before[index] : null, after: v }))
    .filter((s) => s.after > 0 && (s.before === null || s.after - s.before >= 0.005));
}
