/* discord-activity.ts — what Sora's Discord status says (lib/discord sends it): plain functions of
 * what osu! (tosu) and Sora's player say, so they can be tested. Its words stay English: friends read them. */
import { shortDan } from "./dan";
import { displayArtist, displayTitle, fixed, holdRatio, mapPatternText } from "./format";
import { STATE, type TosuNow } from "./tosu";
import type { MapRow, SetRow } from "./types";

const SITE = "https://fumen.dertesti.dev";
export type Activity = Record<string, unknown>;

/** Discord wants 2 to 128 characters */
const text = (s: string, max = 128): string => {
  const t = s.replace(/\s+/g, " ").trim();
  const cut = t.length > max ? `${t.slice(0, max - 1)}…` : t;
  return cut.length < 2 ? cut.padEnd(2, " ") : cut;
};

const coverOf = (setId: number): string | undefined => (setId > 0 ? `https://assets.ppy.sh/beatmaps/${setId}/covers/list@2x.jpg` : undefined);

/** The chart in a few words: stars at the rate, the pattern and the dan (osu!mania), e.g.
 * "5.41★ · Jumpstream · Dan 6". */
export function chartWords(m: MapRow | null, rate: number): string {
  if (!m) return "";
  const stars = rate === 1 ? m.sr : Math.abs(rate - 1.5) < 0.01 ? m.srDt : Math.abs(rate - 0.75) < 0.01 ? m.srHt : undefined;
  return [stars ? `${fixed(stars, 2)}★` : "", mapPatternText(m), m.dan ? shortDan(m.dan, holdRatio(m)) : ""].filter(Boolean).join(" · ");
}

/** The play as it goes, e.g. "98.42% · 412x · 187 pp · ♥ 142". */
export function playWords(now: TosuNow, pulse: number | null): string {
  const p = now.play;
  const parts = p.hits > 0 ? [`${fixed(p.accuracy, 2)}%`, `${p.combo}x`, p.pp !== null ? `${Math.round(p.pp)} pp` : ""] : [];
  if (pulse !== null) parts.push(`♥ ${Math.round(pulse)}`);
  return parts.filter(Boolean).join(" · ");
}

const modsOf = (now: TosuNow): string => now.play.modList.filter((m) => m !== "CL").join("");

/** What osu! shows, as an activity (null: nothing worth showing). */
export function osuActivity(now: TosuNow, m: MapRow | null, set: SetRow | null, pulse: number | null, start: number | null): Activity | null {
  const playing = now.state === STATE.play;
  const results = now.state === STATE.resultScreen;
  const picking = now.state === STATE.selectPlay || now.state === STATE.selectEdit;
  if (!now.md5 || !(playing || results || picking)) return null;
  const mods = modsOf(now);
  const name = `${now.artist} - ${now.title} [${now.version}]`;
  const chart = chartWords(m, now.rate);
  const beatmapId = now.beatmapId || m?.onlineId || 0;
  const setId = now.setId || set?.onlineId || 0;
  const cover = coverOf(setId);
  const buttons = [
    ...(beatmapId > 0 ? [{ label: "Map", url: `https://osu.ppy.sh/b/${beatmapId}` }] : []),
    { label: "Sora", url: SITE },
  ];
  let state: string;
  if (picking) state = ["Picking a map", chart].filter(Boolean).join(" · ");
  else if (results && now.results) {
    const r = now.results;
    state = [`${r.rank}`, `${fixed(r.accuracy, 2)}%`, r.pp !== null ? `${Math.round(r.pp)} pp` : ""].filter(Boolean).join(" · ");
  } else state = playWords(now, pulse) || chart || "Playing";
  const activity: Activity = {
    type: 0,
    status_display_type: 2,
    details: text(mods ? `${name} +${mods}` : name),
    state: text(state),
    assets: cover ? { large_image: cover, large_text: text(chart || name) } : undefined,
    buttons,
  };
  if (playing && start !== null) {
    const length = (m?.length ?? now.lastObject ?? 0) / now.rate;
    activity.timestamps = length > 0 ? { start, end: start + Math.round(length) } : { start };
  }
  return activity;
}

/** The song Sora plays, as music. */
export function musicActivity(m: MapRow, set: SetRow, at: number, length: number, rate: number, unicode: boolean, wall = Date.now()): Activity {
  const start = wall - Math.round((at * 1000) / rate);
  const cover = coverOf(set.onlineId ?? 0);
  return {
    type: 2,
    status_display_type: 2,
    details: text(displayTitle(set, unicode)),
    state: text(`by ${displayArtist(set, unicode)}`),
    assets: cover ? { large_image: cover, large_text: text([m.version, chartWords(m, rate)].filter(Boolean).join(" · ")) } : undefined,
    timestamps: length > 0 ? { start, end: start + Math.round((length * 1000) / rate) } : { start },
    buttons: [
      ...((set.onlineId ?? 0) > 0 ? [{ label: "Map", url: `https://osu.ppy.sh/beatmapsets/${set.onlineId}` }] : []),
      { label: "Sora", url: SITE },
    ],
  };
}
