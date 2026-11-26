/* storyboard.ts — an osu! storyboard read and played: the sprites and animations of a .osu's
 * [Events] and the set's .osb, with their commands (fade, move, scale, rotate, colour, flips,
 * additive), loops and variables, and every one of osu!'s easings. `state` says where a sprite is
 * at a moment; views/vis/storyboard-gl draws it.
 *
 * As osu! does it: the .osb's elements come first (under the difficulty's own), layers stack
 * Background, Fail, Pass, Foreground, Overlay (Fail never shows here: nothing fails), a value
 * before its first command is that command's start value and after its last that command's end
 * value, a sprite lives from its first command to its last (from its first fade when that starts
 * at nothing), and a loop's commands repeat after each other, as long as they last together.
 * Triggers (hitsounds, passing, failing) aren't played. */

/** Background, Fail, Pass, Foreground, Overlay */
export const LAYERS = ["background", "fail", "pass", "foreground", "overlay"] as const;
export const FAIL_LAYER = 1;

const ORIGINS: Record<string, [number, number]> = {
  topleft: [0, 0],
  centre: [0.5, 0.5],
  center: [0.5, 0.5],
  centreleft: [0, 0.5],
  topright: [1, 0],
  bottomcentre: [0.5, 1],
  topcentre: [0.5, 0],
  custom: [0, 0],
  centreright: [1, 0.5],
  bottomleft: [0, 1],
  bottomright: [1, 1],
};
const ORIGIN_NUMBERS = ["topleft", "centre", "centreleft", "topright", "bottomcentre", "topcentre", "custom", "centreright", "bottomleft", "bottomright"];

/** a value from `a` to `b` between `s` and `t` (ms), eased */
export interface Seg {
  s: number;
  t: number;
  e: number;
  a: number;
  b: number;
}

/** a parameter (flip, additive) on from `s` to `t`, for good when they're the same */
export interface Span {
  s: number;
  t: number;
}

type Channel = "x" | "y" | "sc" | "vx" | "vy" | "r" | "f" | "cr" | "cg" | "cb";

export interface Sprite {
  layer: number;
  /** the image's name, normalised (lower case, `/`) */
  path: string;
  /** an animation's frames: how many, ms each, played once or over and over */
  frames: { count: number; delay: number; once: boolean } | null;
  /** origin, 0–1 of the image's width and height */
  ox: number;
  oy: number;
  /** where it is without a move */
  x: number;
  y: number;
  ch: Partial<Record<Channel, Seg[]>>;
  flipH: Span[];
  flipV: Span[];
  add: Span[];
  /** from its first command to its last, ms */
  start: number;
  end: number;
}

export interface Storyboard {
  sprites: Sprite[];
  /** made for 16:9 (otherwise 4:3, the sides cut) */
  widescreen: boolean;
  /** the difficulty's background image is one of the storyboard's sprites: osu! doesn't draw it under */
  replacesBackground: boolean;
}

/** what a sprite looks like at a moment */
export interface SpriteState {
  x: number;
  y: number;
  sx: number;
  sy: number;
  rot: number;
  alpha: number;
  r: number;
  g: number;
  b: number;
  flipH: boolean;
  flipV: boolean;
  add: boolean;
  /** the image to draw (an animation's frame) */
  path: string;
}

/** A name as a set's files are looked up: lower case, `/`, no quotes or leading `./`. */
export const normName = (name: string): string =>
  name.trim().replace(/^"|"$/g, "").replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();

/** more segments than this in one storyboard and the rest of its loops are left out */
const BUDGET = 2_000_000;

/** Splits a line at commas, keeping quoted parts whole. */
function split(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (ch === "," && !quoted) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

const num = (s: string | undefined, def = 0): number => {
  const v = Number.parseFloat(s ?? "");
  return Number.isFinite(v) ? v : def;
};

interface Cmd {
  type: string;
  e: number;
  s: number;
  t: number;
  /** values, or for P its letter */
  v: number[];
  p: string;
}

const ARITY: Record<string, number> = { F: 1, S: 1, R: 1, MX: 1, MY: 1, M: 2, V: 2, C: 3 };

function parseCmd(parts: string[]): Cmd | null {
  const type = parts[0].trim();
  if (type === "P") {
    const s = num(parts[2]);
    const t = parts[3]?.trim() ? num(parts[3]) : s;
    return { type, e: 0, s, t, v: [], p: (parts[4] ?? "").trim() };
  }
  if (!(type in ARITY)) return null;
  const e = Math.round(num(parts[1]));
  const s = num(parts[2]);
  const t = parts[3]?.trim() ? num(parts[3]) : s;
  return { type, e, s, t, v: parts.slice(4).map((p) => num(p)), p: "" };
}

class Builder {
  ch: Partial<Record<Channel, Seg[]>> = {};
  flipH: Span[] = [];
  flipV: Span[] = [];
  add: Span[] = [];
  count = 0;

  private push(c: Channel, seg: Seg): void {
    (this.ch[c] ??= []).push(seg);
    this.count++;
  }

  /** a command, `off` ms later than written */
  apply(cmd: Cmd, off: number): void {
    const s = cmd.s + off;
    const t = cmd.t + off;
    if (cmd.type === "P") {
      const span = { s, t };
      if (cmd.p === "H") this.flipH.push(span);
      else if (cmd.p === "V") this.flipV.push(span);
      else if (cmd.p === "A") this.add.push(span);
      return;
    }
    const n = ARITY[cmd.type];
    const v = cmd.v;
    if (v.length < n) return;
    const chans: Channel[] =
      cmd.type === "M" ? ["x", "y"] : cmd.type === "V" ? ["vx", "vy"] : cmd.type === "C" ? ["cr", "cg", "cb"] : [({ F: "f", S: "sc", R: "r", MX: "x", MY: "y" } as Record<string, Channel>)[cmd.type]];
    const scale = cmd.type === "C" ? 1 / 255 : 1;
    // one set of values: it stays; more: each next set over the next stretch as long
    const sets = Math.floor(v.length / n);
    const dur = t - s;
    const steps = Math.max(1, sets - 1);
    for (let i = 0; i < steps; i++) {
      const from = i * n;
      const to = sets > 1 ? (i + 1) * n : from;
      chans.forEach((c, k) => this.push(c, { s: s + i * dur, t: t + i * dur, e: cmd.e, a: v[from + k] * scale, b: v[to + k] * scale }));
    }
  }
}

/** A loop's commands: its start and how many times it plays (at least once). */
interface Loop {
  start: number;
  times: number;
  cmds: Cmd[];
}

interface Pending {
  layer: number;
  path: string;
  frames: Sprite["frames"];
  ox: number;
  oy: number;
  x: number;
  y: number;
  b: Builder;
}

/** Reads a storyboard from the .osb (if any) and the .osu. */
export function parseStoryboard(osu: string, osb: string | null): Storyboard {
  const vars: [string, string][] = [];
  const sprites: Sprite[] = [];
  /** every image the Background layer names, with commands or without (osu! counts both) */
  const bgLayer = new Set<string>();
  let budget = BUDGET;
  let bg: string | null = null;
  let widescreen = false;

  const read = (text: string, isOsb: boolean) => {
    let section = isOsb ? "[Events]" : "";
    let cur: Pending | null = null;
    let loop: Loop | null = null;
    /** inside a trigger: its commands are skipped */
    let trigger = false;

    const closeLoop = () => {
      if (!loop || !cur) {
        loop = null;
        return;
      }
      const l: Loop = loop;
      loop = null;
      if (!l.cmds.length) return;
      let lo = Infinity;
      let hi = -Infinity;
      for (const c of l.cmds) {
        lo = Math.min(lo, c.s);
        hi = Math.max(hi, c.t);
      }
      const dur = hi - lo;
      let times = l.times;
      // a loop that would take the storyboard over its budget plays as often as still fits
      const per = l.cmds.length * 3;
      if (per * times > budget) times = Math.max(1, Math.floor(budget / per));
      budget -= per * times;
      for (let i = 0; i < times; i++) for (const c of l.cmds) cur.b.apply(c, l.start + i * dur);
    };
    const closeSprite = () => {
      closeLoop();
      trigger = false;
      if (!cur) return;
      const p: Pending = cur;
      cur = null;
      if (p.layer === 0) bgLayer.add(p.path);
      const sp = finish(p);
      if (sp) sprites.push(sp);
    };

    for (const raw of text.replace(/^﻿/, "").split(/\r?\n/)) {
      if (!raw.trim() || raw.startsWith("//")) continue;
      if (raw.startsWith("[")) {
        closeSprite();
        section = raw.trim();
        continue;
      }
      if (section === "[General]" && !isOsb) {
        const m = /^WidescreenStoryboard\s*:\s*(\d+)/.exec(raw);
        if (m) widescreen = m[1] === "1";
        continue;
      }
      if (section === "[Variables]") {
        const eq = raw.indexOf("=");
        if (raw.startsWith("$") && eq > 1) vars.push([raw.slice(0, eq).trim(), raw.slice(eq + 1).trim()]);
        vars.sort((a, b) => b[0].length - a[0].length);
        continue;
      }
      if (section !== "[Events]") continue;
      let depth = 0;
      while (depth < raw.length && (raw[depth] === " " || raw[depth] === "_")) depth++;
      let line = raw.slice(depth).trimEnd();
      if (line.includes("$")) for (const [k, v] of vars) line = line.split(k).join(v);
      const parts = split(line);

      if (depth === 0) {
        closeSprite();
        const kind = parts[0].trim();
        if (kind === "0" || kind === "Background") {
          if (parts[2]) bg = normName(parts[2]);
          continue;
        }
        const sprite = kind === "Sprite" || kind === "4";
        const anim = kind === "Animation" || kind === "6";
        if (!sprite && !anim) continue;
        const layerName = (parts[1] ?? "").trim().toLowerCase();
        let layer = LAYERS.indexOf(layerName as (typeof LAYERS)[number]);
        if (layer < 0) layer = Math.min(4, Math.max(0, Math.round(num(layerName))));
        const originName = (parts[2] ?? "").trim().toLowerCase();
        const [ox, oy] = ORIGINS[originName] ?? ORIGINS[ORIGIN_NUMBERS[Math.round(num(originName, 0))] ?? "topleft"] ?? [0, 0];
        const frames = anim
          ? {
              count: Math.max(1, Math.round(num(parts[6], 1))),
              delay: Math.max(1, num(parts[7], 1)),
              once: /^(loop)?once$|^1$/i.test((parts[8] ?? "").trim()),
            }
          : null;
        cur = { layer, path: normName(parts[3] ?? ""), frames, ox, oy, x: num(parts[4]), y: num(parts[5]), b: new Builder() };
        continue;
      }
      if (!cur) continue;
      const pending: Pending = cur;
      if (depth === 1) {
        closeLoop();
        trigger = false;
        const type = parts[0].trim();
        if (type === "L") {
          loop = { start: num(parts[1]), times: Math.max(1, Math.round(num(parts[2], 1))), cmds: [] };
        } else if (type === "T") {
          trigger = true;
        } else {
          const c = parseCmd(parts);
          if (c && budget > 0) {
            const before = pending.b.count;
            pending.b.apply(c, 0);
            budget -= pending.b.count - before;
          }
        }
        continue;
      }
      // deeper: a loop's or a trigger's commands
      if (trigger) continue;
      const l = loop as Loop | null;
      if (l) {
        const c = parseCmd(parts);
        if (c) l.cmds.push(c);
      }
    }
    closeSprite();
  };

  if (osb) read(osb, true);
  read(osu, false);
  // layers stack in order, each in the order its sprites were written
  sprites.sort((a, b) => a.layer - b.layer);
  const replacesBackground = !!bg && bgLayer.has(bg);
  return { sprites, widescreen, replacesBackground };
}

function finish(p: Pending): Sprite | null {
  const ch = p.b.ch;
  let start = Infinity;
  let end = -Infinity;
  for (const k in ch) {
    const segs = ch[k as Channel]!;
    // in order of their start, those starting together as written
    segs.sort((a, b) => a.s - b.s);
    for (const g of segs) {
      start = Math.min(start, g.s);
      end = Math.max(end, g.t);
    }
  }
  for (const spans of [p.b.flipH, p.b.flipV, p.b.add]) {
    spans.sort((a, b) => a.s - b.s);
    for (const g of spans) {
      start = Math.min(start, g.s);
      end = Math.max(end, g.t);
    }
  }
  if (!Number.isFinite(start)) return null;
  // a first fade from nothing: there's nothing to see before it
  const f = ch.f;
  if (f?.length && f[0].a === 0) start = Math.max(start, f[0].s);
  if (!p.path) return null;
  return { layer: p.layer, path: p.path, frames: p.frames, ox: p.ox, oy: p.oy, x: p.x, y: p.y, ch, flipH: p.b.flipH, flipV: p.b.flipV, add: p.b.add, start, end };
}

/** A channel's value at `t`: before its first command that one's start value, between commands the
 * last one's end value. */
export function valueAt(segs: Seg[] | undefined, t: number, def: number): number {
  if (!segs || !segs.length) return def;
  if (t < segs[0].s) return segs[0].a;
  // the last one started by now
  let lo = 0;
  let hi = segs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (segs[mid].s <= t) lo = mid;
    else hi = mid - 1;
  }
  const g = segs[lo];
  if (t >= g.t) return g.b;
  return g.a + (g.b - g.a) * ease(g.e, (t - g.s) / (g.t - g.s));
}

function on(spans: Span[], t: number): boolean {
  for (const g of spans) {
    if (g.s > t) break;
    if (t < g.t || g.s === g.t) return true;
  }
  return false;
}

/** Where a sprite is at `t` ms; null while it isn't there or can't be seen. */
export function spriteAt(sp: Sprite, t: number): SpriteState | null {
  if (t < sp.start || t > sp.end) return null;
  const ch = sp.ch;
  const alpha = valueAt(ch.f, t, 1);
  if (alpha <= 0.001) return null;
  const sc = valueAt(ch.sc, t, 1);
  const sx = sc * valueAt(ch.vx, t, 1);
  const sy = sc * valueAt(ch.vy, t, 1);
  if (sx === 0 || sy === 0) return null;
  let path = sp.path;
  if (sp.frames) {
    const f = sp.frames;
    let i = Math.floor((t - sp.start) / f.delay);
    i = f.once ? Math.min(f.count - 1, Math.max(0, i)) : ((i % f.count) + f.count) % f.count;
    path = framePath(sp.path, i);
  }
  return {
    x: valueAt(ch.x, t, sp.x),
    y: valueAt(ch.y, t, sp.y),
    sx,
    sy,
    rot: valueAt(ch.r, t, 0),
    alpha: Math.min(1, alpha),
    r: valueAt(ch.cr, t, 1),
    g: valueAt(ch.cg, t, 1),
    b: valueAt(ch.cb, t, 1),
    flipH: on(sp.flipH, t),
    flipV: on(sp.flipV, t),
    add: on(sp.add, t),
    path,
  };
}

/** An animation's frame: the number before the extension ("a.png" → "a3.png"). */
export function framePath(path: string, i: number): string {
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  return dot > slash ? `${path.slice(0, dot)}${i}${path.slice(dot)}` : `${path}${i}`;
}

/** Every image a sprite can show (an animation's frames). */
export function spritePaths(sp: Sprite): string[] {
  if (!sp.frames) return [sp.path];
  return Array.from({ length: sp.frames.count }, (_, i) => framePath(sp.path, i));
}

// ── easings, as osu! numbers them (osu-framework's Easing) ──

const ELASTIC = (Math.PI * 2) / 0.3;
const ELASTIC2 = 0.3 / 4;
const BACK = 1.70158;
const BACK2 = BACK * 1.525;
const EXPO = 2 ** -10;

function outBounce(t: number): number {
  if (t < 1 / 2.75) return 7.5625 * t * t;
  if (t < 2 / 2.75) return 7.5625 * (t -= 1.5 / 2.75) * t + 0.75;
  if (t < 2.5 / 2.75) return 7.5625 * (t -= 2.25 / 2.75) * t + 0.9375;
  return 7.5625 * (t -= 2.625 / 2.75) * t + 0.984375;
}

/** Easing number `e` (0 linear … 34 InOutBounce) at `t` (0–1). */
export function ease(e: number, t: number): number {
  switch (e) {
    case 1: // Out
    case 4: // OutQuad
      return t * (2 - t);
    case 2: // In
    case 3: // InQuad
      return t * t;
    case 5: // InOutQuad
      return t < 0.5 ? t * t * 2 : --t * t * -2 + 1;
    case 6:
      return t * t * t;
    case 7:
      return --t * t * t + 1;
    case 8:
      return t < 0.5 ? t * t * t * 4 : --t * t * t * 4 + 1;
    case 9:
      return t * t * t * t;
    case 10:
      return 1 - --t * t * t * t;
    case 11:
      return t < 0.5 ? t * t * t * t * 8 : --t * t * t * t * -8 + 1;
    case 12:
      return t * t * t * t * t;
    case 13:
      return --t * t * t * t * t + 1;
    case 14:
      return t < 0.5 ? t * t * t * t * t * 16 : --t * t * t * t * t * 16 + 1;
    case 15:
      return 1 - Math.cos(t * Math.PI * 0.5);
    case 16:
      return Math.sin(t * Math.PI * 0.5);
    case 17:
      return 0.5 - 0.5 * Math.cos(Math.PI * t);
    case 18:
      return 2 ** (10 * (t - 1)) + EXPO * (t - 1);
    case 19:
      return -(2 ** (-10 * t)) + 1 + EXPO * t;
    case 20:
      return t < 0.5 ? 0.5 * (2 ** (20 * t - 10) + EXPO * (2 * t - 1)) : 1 - 0.5 * (2 ** (-20 * t + 10) + EXPO * (-2 * t + 1));
    case 21:
      return 1 - Math.sqrt(1 - t * t);
    case 22:
      return Math.sqrt(1 - --t * t);
    case 23:
      return (t *= 2) < 1 ? 0.5 - 0.5 * Math.sqrt(1 - t * t) : 0.5 * Math.sqrt(1 - (t -= 2) * t) + 0.5;
    case 24:
      return -(2 ** (-10 + 10 * t)) * Math.sin((1 - ELASTIC2 - t) * ELASTIC);
    case 25:
      return 2 ** (-10 * t) * Math.sin((t - ELASTIC2) * ELASTIC) + 1;
    case 26:
      return 2 ** (-10 * t) * Math.sin((0.5 * t - ELASTIC2) * ELASTIC) + 1;
    case 27:
      return 2 ** (-10 * t) * Math.sin((0.25 * t - ELASTIC2) * ELASTIC) + 1;
    case 28:
      if ((t *= 2) < 1) return -0.5 * 2 ** (-10 + 10 * t) * Math.sin(((1 - ELASTIC2 * 1.5 - t) * ELASTIC) / 1.5);
      return 0.5 * 2 ** (-10 * --t) * Math.sin(((t - ELASTIC2 * 1.5) * ELASTIC) / 1.5) + 1;
    case 29:
      return t * t * ((BACK + 1) * t - BACK);
    case 30:
      return --t * t * ((BACK + 1) * t + BACK) + 1;
    case 31:
      if ((t *= 2) < 1) return 0.5 * t * t * ((BACK2 + 1) * t - BACK2);
      return 0.5 * ((t -= 2) * t * ((BACK2 + 1) * t + BACK2) + 2);
    case 32:
      return 1 - outBounce(1 - t);
    case 33:
      return outBounce(t);
    case 34:
      return t < 0.5 ? 0.5 - 0.5 * outBounce(1 - t * 2) : outBounce((t - 0.5) * 2) * 0.5 + 0.5;
    default:
      return t;
  }
}
