/* history.ts — your plays: osu!'s numbers for a ruleset (or totals from the plays themselves), a
 * year of activity, and your recent plays, top plays and most played difficulties.
 *
 * Plays are lazer's local scores plus, logged in, what osu! has (other computers, stable, pp),
 * merged in src-tauri/src/osu_scores.rs.
 */
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, asApiError, osuCoverUrl, osuMapUrl, osuScoreUrl, thumbUrl } from "../lib/api";
import { date, displayArtist, displayTitle, esc, fixed, MODE_LABEL, MODE_SHORT, num, pct, rankInfo, relativeTime, srChip } from "../lib/format";
import { bestAcc, goalTarget, goalTitle, goalValue, progress, skillName, type Goal } from "../lib/goals";
import { goalEvents, goalsNow, loadGoals } from "../lib/goals-store";
import {
  historyEvents, historyNow, isSyncing, loadHistory, mapIndexOf, modsText, playScoreTip, playTarget, playWhen, playWhenTip, syncHistory,
  timeOfDay,
} from "../lib/history";
import { totals, type HeartTotals, type HeartTry } from "../lib/heart-stats";
import {
  byDay, dayShift, mapsOf, sitEvents, sittings, skillsMoved, spent, valuesAt, weekShift, weekStart, weekSum, type SitTry, type Sitting,
} from "../lib/sittings";
import { keysOf, SKILL_LABEL, SKILLSETS, skillHistory, type LeftOut, type SkillPoint } from "../lib/skills";
import { leftOutNow } from "../lib/skills-left-out";
import { go, goSection } from "../lib/router";
import { follow } from "../lib/tosu-follow";
import { events, setPrefs, store } from "../lib/store";
import type { History, MapRow, OsuAccount, OsuModeStats, Play } from "../lib/types";
import { attachSegIndicator, openMenu, toast, type MenuEntry } from "../ui/controls";
import { icon } from "../ui/icons";
import { openSet } from "./actions";
import { openImport } from "./import";
import { loginWithOsu } from "./settings";
import { locale, t, tn } from "../lib/i18n";

/** rows per "Show more" */
const PAGE = 50;
const MOST_PLAYED = 100;
const RULESET_NAMES = ["osu", "taiko", "fruits", "mania"] as const;
const MODES = [
  { mode: -1, label: t("All") },
  { mode: 0, label: "osu!" },
  { mode: 1, label: "taiko" },
  { mode: 2, label: "catch" },
  { mode: 3, label: "mania" },
];

type Tab = "recent" | "week" | "top" | "most" | "heart";
/** difficulties listed in the pulse tab at most */
const PULSE_MAPS = 50;
/** days in the pulse tab's chart at most */
const PULSE_DAYS = 30;

/** What a list row stands for (rows point here by index). */
interface Row {
  map?: string;
  beatmap?: number;
  beatmapId?: number;
  mode: number;
  play?: Play;
}

interface Most extends Row {
  count: number;
  last?: number;
  best?: Play;
}

export class HistoryView {
  readonly el: HTMLElement;
  private offs: (() => void)[] = [];
  private tab: Tab = "recent";
  private shownRows = PAGE;
  private account: OsuAccount | null = null;
  private rows: Row[] = [];
  private failed: string | null = null;
  /** weeks the activity grid has room for */
  private weeks = WEEKS;
  /** every try with its pulse (null until read) */
  private pulseTries: HeartTry[] | null = null;
  /** a difficulty's library id by its MD5 (null: not in the library) */
  private pulseIds = new Map<string, string | null>();
  /** the Monday of the week "Your week" shows */
  private weekAt = weekStart(Date.now());
  /** the tries by the Monday of their week, read a week and the one before at a time */
  private weekTries = new Map<number, SitTry[]>();
  /** the sitting opened in "Your week" (when it started) */
  private openSitting: number | null = null;
  /** how the skills grew per key mode, for "Your week" (worked out again when the plays change) */
  private points: { plays: Play[]; maps: MapRow[]; leftOut: LeftOut; byKeys: Map<number, SkillPoint[]> } | null = null;

  constructor() {
    this.el = document.createElement("section");
    this.el.className = "view hist-view";
    this.el.innerHTML = `
      <header class="view-head hist-head">
        <div class="hist-head-text">
          <h1 class="view-title">${t("History")}</h1>
          <div class="view-sub hist-sub meta-line num"></div>
        </div>
        <div class="hist-sync"></div>
      </header>
      <div class="hist-toolbar">
        <div class="seg-pill hist-modes" role="tablist" aria-label="${t("Ruleset")}">
          ${MODES.map((m) => `<button type="button" data-mode="${m.mode}">${m.label}</button>`).join("")}
        </div>
      </div>
      <div class="hist-body"></div>`;
    attachSegIndicator(this.el.querySelector(".hist-modes")!);
    this.bind();
    new ResizeObserver(() => this.fitActivity()).observe(this.el);
    this.offs.push(
      historyEvents.on("history", () => void this.refresh()),
      historyEvents.on("sync", () => this.renderSync()),
      events.on("prefs", (p) => {
        if ("unicode" in p || "mode" in p) this.render();
      }),
      // a try with a pulse came in: the pulse tab counts it
      follow.bus.on("attempt", (a) => {
        if (a.heart) void this.loadPulse().then(() => this.tab === "heart" && this.renderList());
        // and the week it's in
        const monday = weekStart(a.started);
        if (this.tab === "week" && this.weekAt === monday) void this.loadWeek(monday, true).then(() => this.tab === "week" && this.renderList());
        else this.weekTries.delete(monday);
      }),
      goalEvents.on("goals", () => this.tab === "week" && this.renderList()),
    );
    void this.refresh();
  }

  /** The account (logged in or not) and the plays, then everything. */
  private async refresh(): Promise<void> {
    void this.loadPulse().then(() => this.tab === "heart" && this.renderList());
    this.account = await api.osuAccount().catch(() => null);
    try {
      await loadHistory();
      this.failed = null;
    } catch (e) {
      this.failed = asApiError(e).message;
    }
    this.render();
  }

  private async loadPulse(): Promise<void> {
    this.pulseTries = await api.heartTries().catch(() => []);
  }

  shown(): void {
    // "synced … ago" moves on while the view is hidden (the rest stays, scroll position too)
    this.renderSync();
    if (this.tab === "heart") void this.loadPulse().then(() => this.renderList());
    if (this.tab === "week") void this.loadWeek(this.weekAt, true).then(() => this.tab === "week" && this.renderList());
  }

  // ── rendering ─────────────────────────────────────────────────────────

  private plays(h: History): Play[] {
    const mode = store.prefs.mode;
    return mode < 0 ? h.plays : h.plays.filter((p) => p.mode === mode);
  }

  private render(): void {
    const h = historyNow();
    const mode = store.prefs.mode;
    this.renderSync();
    this.el.querySelectorAll<HTMLElement>(".hist-modes button").forEach((b) => b.classList.toggle("active", +b.dataset.mode! === mode));
    const body = this.el.querySelector<HTMLElement>(".hist-body")!;
    const sub = this.el.querySelector<HTMLElement>(".hist-sub")!;
    if (!h) {
      sub.textContent = "";
      body.innerHTML = this.failed
        ? `<div class="empty-state">${icon("alert")}<div class="empty-title">${t("Couldn't read your plays")}</div><div class="empty-sub">${esc(this.failed)}</div></div>`
        : `<div class="hist-loading"><div class="skeleton" style="height:92px"></div><div class="skeleton" style="height:150px"></div><div class="skeleton" style="height:280px"></div></div>`;
      return;
    }
    const plays = this.plays(h);
    const first = plays.length ? plays[plays.length - 1].date : 0;
    sub.innerHTML = [h.player?.name ? esc(h.player.name) : "", tn(plays.length, "{n} play", "{n} plays"), first ? t("since {date}", { date: monthYear(first) }) : ""]
      .filter(Boolean)
      .map((w) => `<span>${w}</span>`)
      .join("");
    if (!h.plays.length) {
      body.innerHTML = `
        <div class="empty-state hist-empty">${icon("clock")}
          <div class="empty-title">${t("No plays yet")}</div>
          <div class="empty-sub">${t("Your plays in osu!lazer show up here after the next library update.")}${this.account ? "" : ` ${t("Log in with osu! to bring in your scores from other computers too.")}`}</div>
        </div>`;
      return;
    }
    body.innerHTML = `
      <div class="hist-tiles">${this.tiles(h, plays)}</div>
      ${activity(plays, this.weeks)}
      <section class="section hist-lists">
        <div class="seg-tabs hist-tabs" role="tablist" aria-label="${t("Plays")}">
          <button type="button" data-tab="recent">${t("Recent")}</button>
          <button type="button" data-tab="week">${t("Your week")}</button>
          <button type="button" data-tab="top">${t("Top plays")}</button>
          <button type="button" data-tab="most">${t("Most played")}</button>
          <button type="button" data-tab="heart">${t("Heart rate")}</button>
        </div>
        <div class="hist-list"></div>
      </section>`;
    attachSegIndicator(body.querySelector(".hist-tabs")!);
    this.renderList();
  }

  /** Fewer weeks when the grid's cells would get smaller than 11 px. */
  private fitActivity(): void {
    const body = this.el.querySelector<HTMLElement>(".hist-body");
    if (!body?.clientWidth) return;
    // panel padding and the day labels; a cell and its gap take 14 px at least
    const weeks = Math.max(13, Math.min(WEEKS, Math.floor((body.clientWidth - 2 * 18 - 36 + 3) / 14)));
    if (weeks === this.weeks) return;
    this.weeks = weeks;
    const h = historyNow();
    const old = this.el.querySelector(".hist-activity");
    if (h && old) old.outerHTML = activity(this.plays(h), weeks);
  }

  private renderSync(): void {
    const host = this.el.querySelector<HTMLElement>(".hist-sync")!;
    if (!this.account) {
      host.innerHTML = `<button class="btn btn-sm hist-login" type="button">${icon("user")}<span>${t("Log in with osu!")}</span></button>`;
      return;
    }
    const busy = isSyncing();
    const at = historyNow()?.syncedAt;
    const state = busy ? t("Reading your scores from osu!…") : at ? t("Synced with osu! {when}", { when: relativeTime(at) }) : t("Not synced with osu! yet");
    host.innerHTML = `
      <span class="hist-synced">${state}</span>
      <button class="icon-btn hist-sync-btn${busy ? " busy" : ""}" type="button" data-tip="${busy ? state : `${t("Sync with osu!")} · ${state}`}" aria-label="${t("Sync with osu!")}"${busy ? " disabled" : ""}>${icon("refresh")}</button>`;
  }

  /** osu!'s numbers for the ruleset when it has them, else totals from the plays. */
  private tiles(h: History, plays: Play[]): string {
    const mode = store.prefs.mode;
    const st = mode >= 0 ? h.stats[RULESET_NAMES[mode]] : undefined;
    return st?.playCount ? osuTiles(st, this.account) : playTiles(plays);
  }

  private renderList(): void {
    const h = historyNow();
    const list = this.el.querySelector<HTMLElement>(".hist-list");
    if (!h || !list) return;
    this.el.querySelectorAll<HTMLElement>(".hist-tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === this.tab));
    const plays = this.plays(h);
    list.innerHTML =
      this.tab === "recent"
        ? this.recent(plays)
        : this.tab === "week"
          ? this.week(h, plays)
          : this.tab === "top"
            ? this.top(plays)
            : this.tab === "heart"
              ? this.pulse()
              : this.most(h, plays);
  }

  /** Your pulse over every try with it: what it comes to, by day and by difficulty. */
  private pulse(): string {
    if (!this.pulseTries) return `<div class="skeleton" style="height:220px"></div>`;
    const mode = store.prefs.mode;
    const all = mode < 0 ? this.pulseTries : this.pulseTries.filter((x) => x.mode === mode);
    const sum = totals(all);
    if (!sum)
      return `<div class="empty-state">${icon("heart")}
        <div class="empty-title">${this.pulseTries.length ? t("No pulse in {mode} yet", { mode: MODE_LABEL[mode as 0] }) : t("No pulse yet")}</div>
        <div class="empty-sub">${t("Connect a heart rate monitor in Settings, While you play. Every try at a map with it on shows up here: your average, your highest, your lowest and your pulse in each map's fastest part.")}</div>
        ${store.prefs.heart?.id ? "" : `<button class="btn btn-primary btn-sm hist-heart-setup" type="button">${t("Connect one")}</button>`}
      </div>`;
    // the difficulties' names come from the library: ask for those not known yet
    const listed = sum.maps.slice(0, PULSE_MAPS);
    const missing = [...new Set([...listed.map((m) => m.md5), sum.max?.md5, sum.min?.md5])].filter((md5): md5 is string => !!md5 && !this.pulseIds.has(md5));
    if (missing.length)
      void Promise.all(missing.map((md5) => api.mapByMd5(md5).then((id) => this.pulseIds.set(md5, id), () => this.pulseIds.set(md5, null)))).then(() => {
        if (this.tab === "heart") this.renderList();
      });
    this.rows = listed.map((m) => ({ map: this.pulseIds.get(m.md5) ?? undefined, mode: m.mode }));
    return `
      <div class="hist-tiles hr-tiles">${this.pulseTiles(sum)}</div>
      ${pulseDays(sum)}
      <div class="prow hrow hrow-head label-caps">
        <span class="hrow-title">${t("By difficulty")}</span><span></span>
        <span class="hr-val">${t("Average")}</span><span class="hr-val">${t("Highest")}</span><span class="hr-val">${t("Fastest part")}</span><span class="hr-val">HRV</span><span class="prow-when"></span>
      </div>
      ${listed
        .map(
          (m, i) => `${this.rowStart(this.rows[i], i, "", "prow hrow").replace('class="prow hrow', `data-md5="${m.md5}" class="prow hrow`)}
            <span class="prow-count num">${tn(m.tries, "<b>{n}</b> try", "<b>{n}</b> tries")}</span>
            <span class="hr-val num" data-tip="${t("Average")}">${Math.round(m.avg)}</span>
            <span class="hr-val hr-max num" data-tip="${t("Highest")}">${m.max}</span>
            <span class="hr-val num" data-tip="${t("In the fastest part")}">${m.fast === null ? "–" : Math.round(m.fast)}</span>
            <span class="hr-val hr-hrv num" data-tip="${t("HRV over these tries, in ms. Lower means more tense.")}">${m.hrv === null ? "–" : Math.round(m.hrv)}</span>
            <span class="prow-when">${playWhen(m.last)}</span>
          </div>`,
        )
        .join("")}`;
  }

  private pulseTiles(s: HeartTotals): string {
    const where = (md5: string, at: number): string => {
      const id = this.pulseIds.get(md5);
      const idx = id ? mapIndexOf(id) : undefined;
      const map = idx !== undefined ? store.snap!.maps[idx] : null;
      const set = map ? store.snap!.sets[map.set] : null;
      return [set ? esc(displayTitle(set, store.prefs.unicode)) : "", playWhen(at)].filter(Boolean).join(" · ");
    };
    const bpm = (v: number): string => `${Math.round(v)}<small> bpm</small>`;
    return [
      tile(t("Average pulse"), bpm(s.avg), tn(s.tries, "over {n} try", "over {n} tries")),
      tile(t("Highest"), s.max ? bpm(s.max.bpm) : "–", s.max ? where(s.max.md5, s.max.started) : ""),
      tile(t("Lowest"), s.min ? bpm(s.min.bpm) : "–", s.min ? where(s.min.md5, s.min.started) : ""),
      tile(
        t("In the fastest parts"),
        s.fast === null ? "–" : bpm(s.fast),
        s.passAvg !== null && s.restAvg !== null ? t("passes {a}, the rest {b} on average", { a: Math.round(s.passAvg), b: Math.round(s.restAvg) }) : t("on average"),
      ),
      tile(
        `<span class="hr-tip" data-tip="${t("How evenly your heart beats, as RMSSD. It drops when you're tense, so a higher number on passes means you play better calm.")}">HRV</span>`,
        s.hrv === null ? "–" : `${Math.round(s.hrv)}<small> ms</small>`,
        s.hrv === null
          ? t("needs a strap that sends the beats' spacing")
          : s.passHrv !== null && s.restHrv !== null
            ? t("passes {a}, the rest {b}", { a: Math.round(s.passHrv), b: Math.round(s.restHrv) })
            : t("how evenly your heart beats"),
      ),
    ].join("");
  }

  // ── your week ─────────────────────────────────────────────────────────

  /** The tries of a week and of the week before (read again with `fresh`). */
  private async loadWeek(monday: number, fresh = false): Promise<void> {
    const before = weekShift(monday, -1);
    if (!fresh && this.weekTries.has(monday) && this.weekTries.has(before)) return;
    const list = await api.triesBetween(before, weekShift(monday, 1)).catch(() => [] as SitTry[]);
    this.weekTries.set(before, list.filter((a) => a.started < monday));
    this.weekTries.set(monday, list.filter((a) => a.started >= monday));
  }

  /** How the skills grew in a key mode, kept until the plays, the library or what's left out change. */
  private skillPoints(h: History, keys: number): SkillPoint[] {
    const maps = store.snap!.maps;
    const leftOut = leftOutNow();
    let m = this.points;
    if (!m || m.plays !== h.plays || m.maps !== maps || m.leftOut !== leftOut) this.points = m = { plays: h.plays, maps, leftOut, byKeys: new Map() };
    let p = m.byKeys.get(keys);
    if (!p) m.byKeys.set(keys, (p = skillHistory(h.plays, mapIndexOf, maps, keys, leftOut)));
    return p;
  }

  /** A week: when you played, in sittings, and what it did for your skills and goals. */
  private week(h: History, plays: Play[]): string {
    const from = this.weekAt;
    const to = weekShift(from, 1);
    const prev = weekShift(from, -1);
    const tries = this.weekTries.get(from);
    const triesBefore = this.weekTries.get(prev);
    const oldest = plays.length ? plays[plays.length - 1].date : Date.now();
    const nav = weekNav(from, from > weekStart(oldest));
    if (!tries || !triesBefore) {
      void this.loadWeek(from).then(() => this.tab === "week" && this.weekAt === from && this.renderList());
      return `${nav}<div class="skeleton" style="height:280px"></div>`;
    }
    const mode = store.prefs.mode;
    const ofMode = (l: SitTry[]) => (mode < 0 ? l : l.filter((a) => a.mode === mode));
    const lengthOf = (p: Play): number | null => {
      const i = mapIndexOf(p.map);
      if (i !== undefined) return store.snap!.maps[i].length || null;
      return (p.beatmap !== undefined ? h.beatmaps[p.beatmap]?.length : undefined) || null;
    };
    const list = sittings(sitEvents(plays, ofMode(tries), lengthOf, from, to));
    if (!list.length) {
      this.rows = [];
      return `${nav}<div class="empty-state wk-empty">${icon("clock")}
        <div class="empty-title">${from === weekStart(Date.now()) ? t("Nothing played this week yet") : t("Nothing played that week")}</div>
        <div class="empty-sub">${t("Every map you play shows up here in sittings, with the time it took and what it did for your skills.")}</div>
      </div>`;
    }
    const sum = weekSum(list);
    const last = weekSum(sittings(sitEvents(plays, ofMode(triesBefore), lengthOf, prev, from)));
    const diff = sum.playing - last.playing;
    const vsLast = !last.playing
      ? t("nothing the week before")
      : Math.abs(diff) < 5 * 60_000
        ? t("about as much as the week before")
        : diff > 0
          ? t("{time} more than the week before", { time: spent(diff) })
          : t("{time} less than the week before", { time: spent(-diff) });
    const left = sum.quits + sum.retries;
    const top = mapsOf(list.flatMap((s) => s.events))[0];
    const topName = top ? this.describe({ map: top.events[0].map, beatmap: top.events[0].beatmap, mode: top.events[0].mode }).title : "";
    const tiles = [
      tile(t("Time played"), spent(sum.playing), vsLast),
      tile(t("Sittings"), num(sum.sittings), tn(sum.days, "on {n} day, longest {time}", "on {n} days, longest {time}", { time: spent(sum.longest) })),
      tile(
        t("Tries"),
        num(sum.tries),
        [tn(sum.passes, "{n} pass", "{n} passes"), sum.fails ? tn(sum.fails, "{n} fail", "{n} fails") : "", left ? t("{n} left early", { n: num(left) }) : ""].filter(Boolean).join(", "),
      ),
      tile(t("Difficulties"), num(sum.maps), top && top.events.length > 1 ? t("most: {title}", { title: esc(topName) }) : ""),
    ].join("");
    const note = !ofMode(tries).length
      ? `<p class="hist-note">${t("Fails and restarts count too while Fumen follows osu! through tosu (Settings, While you play).")}</p>`
      : "";
    return `${nav}
      <div class="hist-tiles wk-tiles">${tiles}</div>
      <div class="label-caps hist-day">${t("When you played")}</div>
      ${weekChart(list, from)}
      ${this.weekSkills(h, list, from, to)}
      ${this.weekGoals(h, from, to)}
      <div class="label-caps hist-day">${t("Sittings")}</div>
      ${this.sittingsList(list)}
      ${note}`;
  }

  /** The skills a week's passes moved, per key mode played. */
  private weekSkills(h: History, list: Sitting[], from: number, to: number): string {
    const mode = store.prefs.mode;
    if (mode >= 0 && mode !== 3) return "";
    const maps = store.snap!.maps;
    const keys = new Set<number>();
    for (const s of list)
      for (const e of s.events) {
        const i = e.outcome === "pass" && e.mode === 3 ? mapIndexOf(e.map) : undefined;
        if (i !== undefined && maps[i].mode === 3) keys.add(keysOf(maps[i]));
      }
    const moved = [...keys].sort((a, b) => a - b).flatMap((k) => skillsMoved(this.skillPoints(h, k), from, to).map((s) => ({ ...s, keys: k })));
    if (!moved.length) return "";
    return `
      <div class="label-caps hist-day">${t("Skills that went up")}</div>
      <div class="wk-moves">${moved
        .map(
          (m) => `<div class="panel wk-move">
            <span class="wk-move-name">${esc(m.index === 0 ? skillName("overall") : SKILL_LABEL[SKILLSETS[m.index - 1]])} ${m.keys}K</span>
            <span class="wk-move-vals num">${m.before === null ? "" : `${fixed(m.before, 2)} → `}<b>${fixed(m.after, 2)}</b></span>
            <span class="wk-move-up num">${m.before === null ? t("new") : `+${fixed(m.after - m.before, 2)}`}</span>
          </div>`,
        )
        .join("")}</div>`;
  }

  /** The goals a week brought closer or reached. */
  private weekGoals(h: History, from: number, to: number): string {
    const goals = goalsNow();
    if (!goals) {
      void loadGoals().catch(() => {});
      return "";
    }
    const mode = store.prefs.mode;
    const cards: string[] = [];
    for (const g of goals) {
      if (g.created >= to || (g.done && g.done < from)) continue;
      let before: number | null = null;
      let after: number | null = null;
      if (g.kind === "skill") {
        if (mode >= 0 && mode !== 3) continue;
        const points = this.skillPoints(h, g.keys);
        const k = g.skillset === "overall" ? 0 : SKILLSETS.indexOf(g.skillset) + 1;
        before = valuesAt(points, from)?.[k] ?? null;
        after = valuesAt(points, to)?.[k] ?? null;
      } else if (g.kind === "chart") {
        const i = mapIndexOf(g.map);
        if (mode >= 0 && i !== undefined && store.snap!.maps[i].mode !== mode) continue;
        before = bestAcc(h.plays.filter((p) => p.date < from), g);
        after = bestAcc(h.plays.filter((p) => p.date < to), g);
      } else if (mode >= 0 && RULESET_NAMES.indexOf(g.ruleset) !== mode) continue;
      const reached = !!g.done && g.done >= from && g.done < to;
      if (!reached && (after === null || (before !== null && after <= before + 1e-9))) continue;
      const open: Goal = { ...g, done: undefined };
      const p0 = before === null ? 0 : progress(open, before);
      const p1 = reached ? 1 : progress(open, after);
      const values = after === null ? "" : before === null ? esc(goalValue(g, after)) : `${esc(goalValue(g, before))} → ${esc(goalValue(g, after))}`;
      cards.push(`
        <div class="panel goal wk-goal">
          <div class="goal-head">${icon(reached ? "check" : "flag", reached ? "goal-ic wk-goal-done" : "goal-ic")}<span class="goal-title">${esc(goalTitle(g))}</span></div>
          <div class="goal-bar wk-goal-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(p1 * 100)}"><span style="--p:${p1.toFixed(3)}"></span><i style="--p:${p0.toFixed(3)}"></i></div>
          <div class="goal-line num"><span>${reached ? t("Reached") : values}</span><span class="goal-to">${esc(goalTarget(g))}</span></div>
        </div>`);
    }
    if (!cards.length) return "";
    return `<div class="label-caps hist-day">${t("Goals that came closer")}</div><div class="goals-grid wk-goals">${cards.join("")}</div>`;
  }

  /** The week's sittings, the latest first; the open one with its difficulties. */
  private sittingsList(list: Sitting[]): string {
    const rows: Row[] = [];
    const html = [...list]
      .reverse()
      .map((s) => {
        const open = this.openSitting === s.start;
        const left = s.quits + s.retries;
        const out = [s.passes ? tn(s.passes, "{n} pass", "{n} passes") : "", s.fails ? tn(s.fails, "{n} fail", "{n} fails") : "", left ? t("{n} left early", { n: num(left) }) : ""]
          .filter(Boolean)
          .join(", ");
        const maps = open
          ? `<div class="wk-sit-maps">${mapsOf(s.events)
              .map((m) => {
                const e = m.events[0];
                const play = m.best ?? m.events.find((x) => x.play)?.play;
                const i = rows.push({ map: e.map, beatmap: e.beatmap, beatmapId: play?.beatmapId, mode: e.mode, play: m.best }) - 1;
                return `${this.rowStart(rows[i], i, "", "prow srow")}
                  <span class="prow-count num">${tn(m.events.length, "<b>{n}</b> try", "<b>{n}</b> tries")}</span>
                  <span class="prow-count num">${tn(m.passes, "<b>{n}</b> pass", "<b>{n}</b> passes")}</span>
                  <span class="prow-acc num">${m.best ? pct(m.best.acc) : ""}</span>
                ${this.rowEnd(rows[i], mapIndexOf(e.map) !== undefined)}`;
              })
              .join("")}</div>`
          : "";
        return `
          <div class="wk-sitting${open ? " open" : ""}" data-sitting="${s.start}">
            <button type="button" class="wk-sit-head" aria-expanded="${open}">
              <span class="wk-sit-when"><b>${esc(dayLabel(s.start))}</b> <span class="num">${timeOfDay(s.start)}–${timeOfDay(s.end)}</span></span>
              <span class="wk-sit-time num">${spent(s.playing)}</span>
              <span class="wk-sit-out"><span class="num">${tn(s.events.length, "<b>{n}</b> try", "<b>{n}</b> tries")}</span><span>${out}</span></span>
              <span class="wk-sit-maps-n num">${tn(s.maps, "{n} difficulty", "{n} difficulties")}</span>
              ${icon("chevron-down", "wk-sit-chev")}
            </button>${maps}
          </div>`;
      })
      .join("");
    this.rows = rows;
    return `<div class="wk-sittings">${html}</div>`;
  }

  private recent(plays: Play[]): string {
    const shown = plays.slice(0, this.shownRows);
    this.rows = shown.map((p) => ({ map: p.map, beatmap: p.beatmap, beatmapId: p.beatmapId, mode: p.mode, play: p }));
    let out = "";
    let day = "";
    shown.forEach((p, i) => {
      const d = dayLabel(p.date);
      if (d !== day) {
        out += `<div class="label-caps hist-day">${d}</div>`;
        day = d;
      }
      out += this.playRow(p, i, false, true);
    });
    const left = plays.length - shown.length;
    if (left > 0) out += `<button class="btn btn-ghost btn-sm hist-more" type="button">${t("Show {n} more", { n: num(Math.min(PAGE, left)) })}</button>`;
    return out;
  }

  private top(plays: Play[]): string {
    const mode = store.prefs.mode;
    // per ruleset osu!'s order; across rulesets by pp
    const top = plays.filter((p) => p.top !== undefined).sort((a, b) => (mode < 0 ? (b.pp ?? 0) - (a.pp ?? 0) : a.top! - b.top!));
    if (!top.length) {
      return this.account
        ? `<div class="empty-state">${icon("star")}<div class="empty-title">${mode >= 0 ? t("No top plays in {mode} yet", { mode: MODE_LABEL[mode as 0] }) : t("No top plays yet")}</div><div class="empty-sub">${t("osu! lists your best plays on ranked and approved beatmaps here, by pp.")}</div></div>`
        : `<div class="empty-state">${icon("star")}<div class="empty-title">${t("Your top plays come from osu!")}</div><div class="empty-sub">${t("Log in with osu! to see them with their pp, from every computer you play on.")}</div><button class="btn btn-primary btn-sm hist-login" type="button">${t("Log in with osu!")}</button></div>`;
    }
    const shown = top.slice(0, this.shownRows);
    this.rows = shown.map((p) => ({ map: p.map, beatmap: p.beatmap, beatmapId: p.beatmapId, mode: p.mode, play: p }));
    const left = top.length - shown.length;
    return shown.map((p, i) => this.playRow(p, i, true)).join("") + (left > 0 ? `<button class="btn btn-ghost btn-sm hist-more" type="button">${t("Show {n} more", { n: num(Math.min(PAGE, left)) })}</button>` : "");
  }

  private most(h: History, plays: Play[]): string {
    const mode = store.prefs.mode;
    const entries = new Map<string, Most>();
    const keyOf = (r: { map?: string; beatmapId?: number }) => r.map ?? (r.beatmapId ? `b${r.beatmapId}` : null);
    for (const p of plays) {
      const key = keyOf(p);
      if (!key) continue;
      let e = entries.get(key);
      if (!e) entries.set(key, (e = { map: p.map, beatmap: p.beatmap, beatmapId: p.beatmapId, mode: p.mode, count: 0 }));
      e.count++;
      e.beatmapId ??= p.beatmapId;
      e.last = Math.max(e.last ?? 0, p.date);
      if (!p.failed && (!e.best || p.score > e.best.score)) e.best = p;
    }
    // osu!'s counts include every try, so they win where they're higher
    for (const m of h.mostPlayed) {
      const key = keyOf(m);
      if (!key) continue;
      const e = entries.get(key);
      if (e) {
        e.count = Math.max(e.count, m.count);
        continue;
      }
      const target = playTarget(m);
      const mapMode = target.map?.mode ?? target.online?.mode ?? -1;
      if (mode >= 0 && mapMode !== mode) continue;
      entries.set(key, { map: m.map, beatmap: m.beatmap, beatmapId: m.beatmapId, mode: mapMode, count: m.count });
    }
    const list = [...entries.values()].sort((a, b) => b.count - a.count || (b.last ?? 0) - (a.last ?? 0)).slice(0, MOST_PLAYED);
    if (!list.length) return `<div class="empty-state">${icon("music")}<div class="empty-title">${t("Nothing played here yet")}</div></div>`;
    this.rows = list;
    const note = h.mostPlayed.length ? "" : `<p class="hist-note">${t("Counts are the scores osu!lazer kept on this computer.")}${this.account ? "" : ` ${t("Logged in, osu!'s play counts (every try, every computer) come in too.")}`}</p>`;
    return note + list.map((e, i) => this.mostRow(e, i)).join("");
  }

  /** Title, artist and art of what a row is on. */
  private describe(r: Row): { title: string; sub: string; art: string | null; sr?: number; inLib: boolean } {
    const { map, online } = playTarget(r);
    const unicode = store.prefs.unicode;
    const set = map ? store.snap!.sets[map.set] : undefined;
    const title = set ? displayTitle(set, unicode) : online ? (unicode && online.titleUnicode) || online.title : t("Not in your library");
    const artist = set ? displayArtist(set, unicode) : online ? (unicode && online.artistUnicode) || online.artist : "";
    const version = map?.version ?? online?.version ?? (r.beatmapId ? t("osu! difficulty {id}", { id: r.beatmapId }) : t("a difficulty that's gone"));
    const ruleset = store.prefs.mode < 0 ? (MODE_SHORT[r.mode as 0] ?? r.play?.ruleset ?? "") : "";
    const bg = map ? (map.bg ?? set!.bg) : undefined;
    return {
      title,
      sub: [ruleset, version, artist].filter(Boolean).map(esc).join(" · "),
      art: bg ? thumbUrl(bg, 160) : online?.setId ? osuCoverUrl(online.setId) : null,
      sr: map?.sr ?? online?.sr,
      inLib: !!map,
    };
  }

  private rowStart(r: Row, i: number, extra: string, cls: string): string {
    const d = this.describe(r);
    return `
      <div class="${cls}${d.inLib ? " in-lib" : ""}" data-i="${i}"${d.inLib ? ` role="button" tabindex="0"` : ""}>
        ${extra}
        <span class="t-art${d.art ? "" : " img-missing"}">${d.art ? `<img src="${d.art}" alt="" loading="lazy" decoding="async" />` : ""}</span>
        <div class="prow-text"><div class="t-title">${esc(d.title)}</div><div class="t-sub">${d.sub}</div></div>
        <span class="prow-sr">${d.sr !== undefined ? srChip(d.sr) : ""}</span>`;
  }

  private rowEnd(r: Row, inLib: boolean): string {
    return `<span class="prow-act">${!inLib && r.beatmapId ? `<button class="icon-btn prow-add" type="button" data-tip="${t("Add to your library")}" aria-label="${t("Add to your library")}">${icon("download")}</button>` : ""}</span>
      </div>`;
  }

  /** `clock`: the day is in a heading above, the row says the time */
  private playRow(p: Play, i: number, withTop = false, clock = false): string {
    const g = rankInfo(p.rank);
    const mods = modsText(p);
    const when = clock ? timeOfDay(p.date) : playWhen(p.date);
    return `${this.rowStart(p, i, withTop ? `<span class="prow-pos num">#${p.top}</span>` : "", `prow${withTop ? " has-pos" : ""}${p.failed ? " failed" : ""}`)}
        <span class="prow-mods" ${mods.length > 14 ? `data-tip="${esc(mods)}"` : ""}>${esc(mods)}</span>
        <span class="grade" style="--c:${g.color}" data-tip="${playScoreTip(p)}">${p.failed ? "F" : g.label}</span>
        <span class="prow-acc num">${pct(p.acc)}</span>
        <span class="prow-pp num">${p.pp ? `${num(Math.round(p.pp))}pp` : ""}</span>
        <span class="prow-when" data-tip="${playWhenTip(p)}">${when}</span>
      ${this.rowEnd(p, mapIndexOf(p.map) !== undefined)}`;
  }

  private mostRow(e: Most, i: number): string {
    const b = e.best;
    const g = b ? rankInfo(b.rank) : null;
    return `${this.rowStart(e, i, "", "prow mrow")}
        <span class="prow-count num">${tn(e.count, "<b>{n}</b> play", "<b>{n}</b> plays")}</span>
        <span class="grade" ${g ? `style="--c:${g.color}" data-tip="${playScoreTip(b!)}"` : ""}>${g ? g.label : ""}</span>
        <span class="prow-acc num">${b ? pct(b.acc) : ""}</span>
        <span class="prow-when">${e.last ? playWhen(e.last) : ""}</span>
      ${this.rowEnd(e, mapIndexOf(e.map) !== undefined)}`;
  }

  // ── actions ───────────────────────────────────────────────────────────

  private open(i: number): void {
    const mapIdx = mapIndexOf(this.rows[i]?.map);
    if (mapIdx !== undefined) openSet(store.snap!.maps[mapIdx].set, mapIdx);
  }

  private add(r: Row | undefined): void {
    if (r?.beatmapId) openImport(`https://osu.ppy.sh/b/${r.beatmapId}`);
  }

  private menu(i: number, at: { x: number; y: number }): void {
    const r = this.rows[i];
    if (!r) return;
    const { map, online } = playTarget(r);
    const entries: MenuEntry[] = [];
    if (map) entries.push({ label: t("Open beatmap set"), icon: "library", action: () => this.open(i) });
    else if (r.beatmapId) entries.push({ label: t("Add to your library"), icon: "download", action: () => this.add(r) });
    const setId = map ? store.snap!.sets[map.set].onlineId : online?.setId;
    const mapId = map?.onlineId ?? r.beatmapId;
    if (setId && mapId) entries.push({ label: t("View beatmap on osu! website"), icon: "external", action: () => void openUrl(osuMapUrl(setId, mapId, Math.max(0, r.mode))) });
    const id = r.play?.id;
    if (id) entries.push({ label: t("View score on osu! website"), icon: "external", action: () => void openUrl(osuScoreUrl(id)) });
    if (entries.length) openMenu(at, entries, { minWidth: 230 });
  }

  private async sync(): Promise<void> {
    const res = await syncHistory();
    if (res.ok) {
      const n = res.summary.added;
      toast(n ? tn(n, "{n} new score from osu!", "{n} new scores from osu!") : t("Up to date with osu!"), { kind: "success", timeout: 2400 });
      return;
    }
    toast(t("Couldn't sync with osu!: {error}", { error: res.error.message }), { kind: "danger", timeout: 6000 });
    if (res.error.code === "osu-logged-out") void this.refresh();
  }

  private bind(): void {
    this.el.addEventListener("click", (e) => {
      const target = e.target as Element;
      const mode = target.closest<HTMLElement>(".hist-modes [data-mode]");
      if (mode) return setPrefs({ mode: +mode.dataset.mode! });
      const tab = target.closest<HTMLElement>(".hist-tabs [data-tab]");
      if (tab) {
        if (this.tab === tab.dataset.tab) return;
        this.tab = tab.dataset.tab as Tab;
        this.shownRows = PAGE;
        return this.renderList();
      }
      if (target.closest(".hist-more")) {
        this.shownRows += PAGE;
        return this.renderList();
      }
      if (target.closest(".hist-sync-btn")) return void this.sync();
      const step = target.closest<HTMLButtonElement>(".wk-prev, .wk-next");
      if (step) {
        this.weekAt = weekShift(this.weekAt, step.classList.contains("wk-prev") ? -1 : 1);
        this.openSitting = null;
        return this.renderList();
      }
      if (target.closest(".wk-now")) {
        this.weekAt = weekStart(Date.now());
        this.openSitting = null;
        return this.renderList();
      }
      // a sitting: its row opens and closes it, its block in the week opens it
      const sit = target.closest<HTMLElement>(".wk-sit-head, .wk-block");
      if (sit) {
        const block = sit.classList.contains("wk-block");
        const start = Number(block ? sit.dataset.sit : sit.closest<HTMLElement>("[data-sitting]")?.dataset.sitting);
        this.openSitting = this.openSitting === start && !block ? null : start;
        this.renderList();
        if (block) this.el.querySelector(`[data-sitting="${start}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
        return;
      }
      if (target.closest(".hist-heart-setup")) return goSection({ name: "settings", section: "play" });
      const hrow = target.closest<HTMLElement>(".hrow[data-md5]");
      if (hrow) return go({ name: "tries", md5: hrow.dataset.md5! });
      if (target.closest(".hist-login")) {
        goSection({ name: "settings", section: "osu" });
        return void loginWithOsu();
      }
      const row = target.closest<HTMLElement>("[data-i]");
      if (!row) return;
      if (target.closest(".prow-add")) return this.add(this.rows[+row.dataset.i!]);
      this.open(+row.dataset.i!);
    });
    this.el.addEventListener("contextmenu", (e) => {
      const row = (e.target as Element).closest<HTMLElement>("[data-i]");
      if (!row) return;
      e.preventDefault();
      this.menu(+row.dataset.i!, { x: e.clientX, y: e.clientY });
    });
    this.el.addEventListener("keydown", (e) => {
      const row = (e.target as Element).closest<HTMLElement>(".prow.in-lib");
      if (row && (e.key === "Enter" || e.key === " ")) {
        e.preventDefault();
        this.open(+row.dataset.i!);
      }
    });
    this.el.addEventListener(
      "load",
      (e) => {
        const img = e.target as HTMLElement;
        if (img.tagName === "IMG") img.classList.add("loaded");
      },
      true,
    );
    this.el.addEventListener(
      "error",
      (e) => {
        const img = e.target as HTMLElement;
        if (img.tagName !== "IMG") return;
        img.parentElement?.classList.add("img-missing");
        img.remove();
      },
      true,
    );
  }

  destroy(): void {
    this.offs.forEach((f) => f());
    this.el.remove();
  }
}

// ── tiles ─────────────────────────────────────────────────────────────────

function tile(k: string, v: string, sub: string, extra = ""): string {
  return `<div class="panel hist-tile"><span class="tile-k">${k}</span><b class="tile-v num">${v}</b><span class="tile-s">${sub}</span>${extra}</div>`;
}

function osuTiles(st: OsuModeStats, account: OsuAccount | null): string {
  const ranks = [st.rank ? `#${num(st.rank)}` : "", st.countryRank ? (account?.country ? t("#{rank} in {country}", { rank: num(st.countryRank), country: esc(account.country) }) : `#${num(st.countryRank)}`) : ""].filter(Boolean);
  const hours = (st.playTime ?? 0) / 3600;
  return [
    tile(t("Performance"), `${num(Math.round(st.pp ?? 0))}pp`, ranks.length ? ranks.join(" · ") : t("No rank yet")),
    rankTile(st.rankHistory ?? []),
    tile(t("Accuracy"), st.accuracy ? pct(st.accuracy) : "–", t("on your top plays")),
    tile(t("Time played"), hours >= 1 ? `${num(Math.round(hours))} h` : `${Math.round(hours * 60)} min`, tn(st.playCount ?? 0, "{n} play on osu!", "{n} plays on osu!")),
  ].join("");
}

/** Global rank over the last 90 days: a line (up is better) and the change. */
function rankTile(history: number[]): string {
  const ranked = history.map((r, i) => [i, r] as const).filter(([, r]) => r > 0);
  if (ranked.length < 2) return tile(t("Rank"), "–", t("no history yet"));
  const [lo, hi] = [Math.min(...ranked.map(([, r]) => r)), Math.max(...ranked.map(([, r]) => r))];
  const span = Math.max(1, hi - lo);
  const last = history.length - 1;
  const pts = ranked.map(([i, r]) => `${((i / last) * 100).toFixed(2)},${(((r - lo) / span) * 100).toFixed(2)}`).join(" ");
  const change = ranked[0][1] - ranked[ranked.length - 1][1];
  const words = change > 0 ? t("up {n} in 90 days", { n: num(change) }) : change < 0 ? t("down {n} in 90 days", { n: num(-change) }) : t("unchanged in 90 days");
  const line = `<svg class="tile-line" viewBox="0 -4 100 108" preserveAspectRatio="none" aria-hidden="true"><polyline points="${pts}" /></svg>`;
  return tile(t("Rank, 90 days"), `#${num(ranked[ranked.length - 1][1])}`, words, line);
}

/** The pulse by day: each day's average as a bar, its highest as a tick above. */
function pulseDays(s: HeartTotals): string {
  const days = s.days.slice(-PULSE_DAYS);
  if (days.length < 2) return "";
  const lo = Math.max(30, Math.min(...days.map((d) => d.avg)) - 15);
  const hi = Math.max(lo + 20, ...days.map((d) => d.max));
  const y = (v: number): string => (((v - lo) / (hi - lo)) * 100).toFixed(1);
  const label = (day: string): string => new Date(`${day}T12:00:00`).toLocaleDateString(locale, { day: "numeric", month: "short" });
  return `
    <div class="label-caps hist-day">${t("By day")}</div>
    <div class="panel hr-days" style="--n:${days.length}">${days
      .map(
        (d) => `<div class="hr-day" data-tip="${esc(label(d.day))} · ${t("average {a}, highest {b}", { a: Math.round(d.avg), b: d.max })}${d.hrv === null ? "" : ` · HRV ${Math.round(d.hrv)} ms`} · ${tn(d.tries, "{n} try", "{n} tries")}">
          <i class="hr-day-avg" style="height:${y(d.avg)}%"></i><b class="hr-day-max" style="bottom:${y(d.max)}%"></b></div>`,
      )
      .join("")}</div>
    <div class="score-graph-axis num hr-days-axis"><span>${esc(label(days[0].day))}</span><span>${esc(label(days[days.length - 1].day))}</span></div>`;
}

function playTiles(plays: Play[]): string {
  const maps = new Set<string>();
  let inLib = 0;
  for (const p of plays) {
    const key = p.map ?? (p.beatmapId ? `b${p.beatmapId}` : null);
    if (!key || maps.has(key)) continue;
    maps.add(key);
    if (p.map) inLib++;
  }
  const days = playDays(plays);
  const passes = plays.filter((p) => !p.failed).slice(0, 50);
  const acc = passes.length ? passes.reduce((s, p) => s + p.acc, 0) / passes.length : 0;
  const first = plays.length ? plays[plays.length - 1].date : 0;
  return [
    tile(t("Plays"), num(plays.length), first ? t("since {date}", { date: monthYear(first) }) : t("none yet")),
    tile(t("Difficulties"), num(maps.size), t("{n} in your library", { n: num(inLib) })),
    tile(t("Days played"), num(days.length), tn(longestStreak(days), "longest streak {n} day", "longest streak {n} days")),
    tile(t("Accuracy"), passes.length ? pct(acc) : "–", passes.length ? tn(passes.length, "average of the last {n} pass", "average of the last {n} passes") : t("no passes yet")),
  ].join("");
}

// ── your week ─────────────────────────────────────────────────────────────

const weekDayFmt = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short" });
const weekDayYearFmt = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", year: "numeric" });
const dayNameFmt = new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric" });

/** "This week", "Last week" or the days, with the way to the weeks before and after. */
function weekNav(monday: number, earlier: boolean): string {
  const now = weekStart(Date.now());
  const sunday = dayShift(monday, 6);
  const fmt = new Date(monday).getFullYear() === new Date().getFullYear() ? weekDayFmt : weekDayYearFmt;
  const days = fmt.formatRange(new Date(monday), new Date(sunday));
  const name = monday === now ? t("This week") : monday === weekShift(now, -1) ? t("Last week") : days;
  return `
    <div class="wk-nav">
      <button class="icon-btn wk-prev" type="button" data-tip="${t("The week before")}" aria-label="${t("The week before")}"${earlier ? "" : " disabled"}>${icon("chevron-left")}</button>
      <div class="wk-name"><b>${esc(name)}</b>${name === days ? "" : `<span class="num">${esc(days)}</span>`}</div>
      <button class="icon-btn wk-next" type="button" data-tip="${t("The week after")}" aria-label="${t("The week after")}"${monday < now ? "" : " disabled"}>${icon("chevron-right")}</button>
      ${monday < weekShift(now, -1) ? `<button class="btn btn-ghost btn-sm wk-now" type="button">${t("This week")}</button>` : ""}
    </div>`;
}

/** What a sitting was, for its block in the week. */
function sittingTip(s: Sitting): string {
  return [`${timeOfDay(s.start)}–${timeOfDay(s.end)}`, spent(s.playing), tn(s.events.length, "{n} try", "{n} tries"), tn(s.passes, "{n} pass", "{n} passes")].join(" · ");
}

/** The seven days as lines through the day, each sitting a block where it was. */
function weekChart(list: Sitting[], monday: number): string {
  const today = dayNumber(Date.now());
  const perDay = byDay(list, monday);
  const days = perDay.map((ms, d) => {
    const from = dayShift(monday, d);
    const to = dayShift(monday, d + 1);
    const blocks = list
      .filter((s) => s.end > from && s.start < to)
      .map((s) => {
        const a = Math.max(s.start, from);
        const b = Math.min(s.end, to);
        const left = ((a - from) / (to - from)) * 100;
        const width = Math.max(0.6, ((b - a) / (to - from)) * 100);
        return `<b class="wk-block" data-sit="${s.start}" style="left:${left.toFixed(2)}%;width:${width.toFixed(2)}%" data-tip="${esc(sittingTip(s))}"></b>`;
      })
      .join("");
    const n = dayNumber(from);
    return `<div class="wk-day${n === today ? " today" : n > today ? " future" : ""}">
        <span class="wk-day-name">${esc(dayNameFmt.format(new Date(from)))}</span>
        <div class="wk-track">${blocks}</div>
        <span class="wk-day-sum num">${ms ? spent(ms) : ""}</span>
      </div>`;
  });
  return `<div class="panel wk-days">${days.join("")}
      <div class="wk-day wk-hours num"><span></span><div class="wk-axis"><span>0</span><span>6</span><span>12</span><span>18</span><span>24</span></div><span></span></div>
    </div>`;
}

// ── activity ──────────────────────────────────────────────────────────────

/** A local calendar day as a running number (DST-proof). */
const dayNumber = (ms: number): number => {
  const d = new Date(ms);
  return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000);
};

/** The days with plays, ascending. */
function playDays(plays: Play[]): number[] {
  return [...new Set(plays.map((p) => dayNumber(p.date)))].sort((a, b) => a - b);
}

function longestStreak(days: number[]): number {
  let best = 0;
  let run = 0;
  days.forEach((d, i) => {
    run = i > 0 && d === days[i - 1] + 1 ? run + 1 : 1;
    best = Math.max(best, run);
  });
  return best;
}

const WEEKS = 53;
// day numbers are UTC midnights of local dates
const monthFmt = new Intl.DateTimeFormat(locale, { month: "short", timeZone: "UTC" });
const cellFmt = new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

/** The last `weeks` weeks (from Monday), a cell per day, shaded by plays. */
function activity(plays: Play[], weeks: number): string {
  const counts = new Map<number, number>();
  for (const p of plays) counts.set(dayNumber(p.date), (counts.get(dayNumber(p.date)) ?? 0) + 1);
  const now = new Date();
  const today = dayNumber(now.getTime());
  const weekday = (now.getDay() + 6) % 7;
  const start = today - weekday - (weeks - 1) * 7;
  let max = 0;
  let total = 0;
  let days = 0;
  for (let d = start; d <= today; d++) {
    const c = counts.get(d) ?? 0;
    max = Math.max(max, c);
    total += c;
    if (c) days++;
  }
  const cells: string[] = [];
  const months: string[] = [];
  // a month's label sits over its first week and needs three columns of room
  const monthOf = (w: number) => new Date((start + w * 7) * 86_400_000).getUTCMonth();
  let labelled = -3;
  for (let w = 0; w < weeks; w++) {
    const first = w === 0 || monthOf(w) !== monthOf(w - 1);
    const roomy = w - labelled >= 3 && w <= weeks - 3 && (w > 0 || (monthOf(1) === monthOf(0) && monthOf(2) === monthOf(0)));
    if (first && roomy) {
      months.push(`<span style="grid-column:${w + 1}">${monthFmt.format(new Date((start + w * 7) * 86_400_000))}</span>`);
      labelled = w;
    }
    for (let k = 0; k < 7; k++) {
      const d = start + w * 7 + k;
      if (d > today) {
        cells.push(`<i class="future"></i>`);
        continue;
      }
      const c = counts.get(d) ?? 0;
      const level = c ? Math.min(4, Math.ceil(Math.sqrt(c / max) * 4)) : 0;
      const label = `${c ? tn(c, "{n} play", "{n} plays") : t("No plays")} · ${cellFmt.format(new Date(d * 86_400_000))}`;
      cells.push(`<i class="l${level}" data-tip="${esc(label)}"></i>`);
    }
  }
  const streak = longestStreak(playDays(plays));
  const sum = [
    `${tn(total, "{n} play", "{n} plays")} ${weeks === WEEKS ? t("in the last year") : t("in {n} weeks", { n: weeks })}`,
    tn(days, "{n} day", "{n} days"),
    streak > 1 ? tn(streak, "longest streak {n} day", "longest streak {n} days") : "",
  ].filter(Boolean);
  return `
    <section class="panel hist-activity">
      <div class="panel-head"><div class="label-caps">${t("Activity")}</div><div class="meta-line num">${sum.map((s) => `<span>${s}</span>`).join("")}</div></div>
      <div class="heat" style="--weeks:${weeks}">
        <div class="heat-months">${months.join("")}</div>
        <div class="heat-days"><span>${t("Mon")}</span><span></span><span>${t("Wed")}</span><span></span><span>${t("Fri")}</span><span></span><span></span></div>
        <div class="heat-grid">${cells.join("")}</div>
      </div>
    </section>`;
}

// ── dates ─────────────────────────────────────────────────────────────────

const monthYearFmt = new Intl.DateTimeFormat(locale, { month: "short", year: "numeric" });
const monthYear = (ms: number): string => monthYearFmt.format(new Date(ms));
const dayFmt = new Intl.DateTimeFormat(locale, { weekday: "long", day: "numeric", month: "short" });

/** "Today", "Yesterday", "Saturday 4 Oct", "4 Oct 2025" */
function dayLabel(ms: number): string {
  const diff = dayNumber(Date.now()) - dayNumber(ms);
  if (diff === 0) return t("Today");
  if (diff === 1) return t("Yesterday");
  return new Date(ms).getFullYear() === new Date().getFullYear() ? dayFmt.format(new Date(ms)) : date(ms);
}
