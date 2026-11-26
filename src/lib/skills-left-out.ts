/* skills-left-out.ts — charts the player took out of the skills (lib/skills' `LeftOut`), say one
 * MinaCalc rates too high. Kept in the UI prefs by chart key, so rate edits go with it, and with a
 * name to list it by, as it may leave the library. */
import { displayArtist, displayTitle } from "./format";
import { chartKey, type LeftOut } from "./skills";
import { setPrefs, store } from "./store";
import type { MapRow } from "./types";

let memo: { from: UiLeftOut; set: LeftOut } | null = null;
type UiLeftOut = typeof store.prefs.skillsLeftOut;

/** The chart keys left out now (the same set until that changes). */
export function leftOutNow(): LeftOut {
  const from = store.prefs.skillsLeftOut ?? {};
  if (memo?.from !== from) memo = { from, set: new Set(Object.keys(from)) };
  return memo.set;
}

/** The charts left out, the latest first. */
export const leftOutList = (): { key: string; name: string; at: number }[] =>
  Object.entries(store.prefs.skillsLeftOut ?? {})
    .map(([key, v]) => ({ key, name: v.name, at: v.at }))
    .sort((a, b) => b.at - a.at);

/** Leaves a chart out; what it's listed as. */
export function leaveOut(map: MapRow): string {
  const set = store.snap?.sets[map.set];
  const name = set ? `${displayArtist(set, false)} - ${displayTitle(set, false)} [${map.version}]` : map.version;
  setPrefs({ skillsLeftOut: { ...store.prefs.skillsLeftOut, [chartKey(map)]: { name, at: Date.now() } } });
  return name;
}

/** Counts a chart again: its keys (its chart key and its id, as it may have been left out under either). */
export function countAgain(...keys: string[]): void {
  const next = { ...store.prefs.skillsLeftOut };
  for (const k of keys) delete next[k];
  setPrefs({ skillsLeftOut: next });
}
