/* skill-trends.ts — a skill's graph on the Skills page, opened from its row: overall or one
 * skillset over time (lib/skills' `skillHistory`, a step per day whose plays raised something),
 * for 90 days, a year or all of it. Hovering it (or moving along it with the arrow keys) shows the
 * value on a day and the step that day made. */
import { date, fixed } from "../lib/format";
import { type SkillPoint } from "../lib/skills";
import { attachSegIndicator } from "../ui/controls";
import { t } from "../lib/i18n";

export type TrendRange = "90d" | "1y" | "all";
const RANGE_MS: Record<TrendRange, number> = { "90d": 90 * 86_400_000, "1y": 365 * 86_400_000, all: Infinity };

/** the plot's own units: 1000 wide, 100 high, room above the line for the value labels */
const W = 1000;
const H = 100;
const TOP = 16;
const BOTTOM = 6;
/** where a value sits in the plot, 0 (top) to H */
const yOf = (v: number, lo: number, hi: number): number => H - BOTTOM - ((v - lo) / (hi - lo)) * (H - TOP - BOTTOM);

/** A step for the value lines: about three of them over the graph. */
const stepFor = (span: number): number => (span <= 3 ? 1 : span <= 8 ? 2 : span <= 20 ? 5 : 10);

function scale(values: number[]): { lo: number; hi: number; step: number } {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const step = stepFor(Math.max(max - min, 2));
  const lo = Math.floor(min / step) * step;
  let hi = Math.ceil(max / step) * step;
  if (hi - lo < 2) hi = lo + Math.max(2, step);
  return { lo, hi, step };
}

/** Puts line `line` of the points (0 overall, then the skillsets) as a graph into `host`. */
export function renderTrend(host: HTMLElement, all: SkillPoint[], line: number, name: string, range: TrendRange, onRange: (r: TrendRange) => void): void {
  const to = Date.now();
  const span = RANGE_MS[range];
  const rated = all.filter((p) => p.values[line] > 0);
  if (!rated.length) {
    host.innerHTML = `<p class="trend-none">${t("Nothing to show yet.")}</p>`;
    return;
  }
  const from = span === Infinity ? rated[0].date : to - span;
  // where it stood when the range starts, then what changed in it
  let carry: SkillPoint | undefined;
  const inside: SkillPoint[] = [];
  for (const p of rated) {
    if (p.date < from) carry = p;
    else inside.push(p);
  }
  const pts = carry ? [{ date: from, values: carry.values }, ...inside] : inside;
  const first = pts[0];
  const last = pts[pts.length - 1];
  const change = last.values[line] - first.values[line];
  const { lo, hi, step } = scale(pts.map((p) => p.values[line]));
  const x = (d: number) => (to > from ? ((d - from) / (to - from)) * W : W);
  const y = (v: number) => yOf(v, lo, hi);
  let path = `M${x(first.date).toFixed(1)} ${y(first.values[line]).toFixed(1)}`;
  for (const p of pts.slice(1)) path += `H${x(p.date).toFixed(1)}V${y(p.values[line]).toFixed(1)}`;
  path += `H${W}`;
  const area = `${path}V${H}H${x(first.date).toFixed(1)}Z`;
  const grid: string[] = [];
  const labels: string[] = [];
  for (let v = lo; v <= hi + 1e-9; v += step) {
    grid.push(`<line x1="0" x2="${W}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" vector-effect="non-scaling-stroke" />`);
    labels.push(`<span class="trend-y num" style="top:${((y(v) / H) * 100).toFixed(1)}%">${v}</span>`);
  }
  const opts: [TrendRange, string][] = [
    ["90d", t("90 days")],
    ["1y", t("Year")],
    ["all", t("All")],
  ];
  const sum = inside.length
    ? Math.abs(change) >= 0.01
      ? t("{change} in this time", { change: `${change > 0 ? "+" : "−"}${fixed(Math.abs(change), 2)}` })
      : t("About the same in this time")
    : t("Nothing moved in this time.");
  host.innerHTML = `
    <div class="trend-head">
      <span class="trend-sum num${change >= 0.01 && inside.length ? " up" : ""}">${sum}</span>
      <div class="seg-pill trend-range" role="tablist" aria-label="${t("Time range")}">${opts.map(([r, label]) => `<button type="button" data-range="${r}" class="${r === range ? "active" : ""}">${label}</button>`).join("")}</div>
    </div>
    <div class="trend-plot" tabindex="0" role="img" aria-label="${t("{skill}: {from} to {to}", { skill: name, from: fixed(first.values[line], 2), to: fixed(last.values[line], 2) })}">
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
        <g class="trend-grid">${grid.join("")}</g>
        <path class="trend-area" d="${area}" />
        <path class="trend-line" d="${path}" vector-effect="non-scaling-stroke" />
      </svg>
      ${labels.join("")}
      <i class="trend-cross" hidden></i>
      <i class="trend-dot" hidden></i>
      <div class="trend-tip" hidden></div>
    </div>
    <div class="trend-x num"><span>${date(from)}</span><span>${t("Today")}</span></div>`;
  attachSegIndicator(host.querySelector<HTMLElement>(".trend-range")!);
  const plot = host.querySelector<HTMLElement>(".trend-plot")!;
  const cross = plot.querySelector<HTMLElement>(".trend-cross")!;
  const dot = plot.querySelector<HTMLElement>(".trend-dot")!;
  const tip = plot.querySelector<HTMLElement>(".trend-tip")!;
  let at = pts.length - 1;
  const show = (j: number) => {
    at = j;
    const p = pts[j];
    const v = p.values[line];
    const fx = to > from ? (p.date - from) / (to - from) : 1;
    cross.hidden = dot.hidden = tip.hidden = false;
    cross.style.left = dot.style.left = `${(fx * 100).toFixed(2)}%`;
    dot.style.top = `${((y(v) / H) * 100).toFixed(2)}%`;
    const d = j > 0 ? v - pts[j - 1].values[line] : 0;
    tip.innerHTML = `<b class="num">${fixed(v, 2)}</b>${Math.abs(d) >= 0.005 ? `<span class="num trend-tip-d${d < 0 ? " down" : ""}">${d > 0 ? "+" : "−"}${fixed(Math.abs(d), 2)}</span>` : ""}<span class="trend-tip-when">${date(p.date)}</span>`;
    const w = plot.clientWidth;
    const half = tip.offsetWidth / 2;
    tip.style.left = `${Math.max(half, Math.min(w - half, fx * w))}px`;
  };
  const hide = () => {
    cross.hidden = dot.hidden = tip.hidden = true;
  };
  host.querySelector(".trend-range")!.addEventListener("click", (e) => {
    const b = (e.target as Element).closest<HTMLElement>("[data-range]");
    if (b && b.dataset.range !== range) onRange(b.dataset.range as TrendRange);
  });
  plot.addEventListener("pointermove", (e) => {
    const r = plot.getBoundingClientRect();
    const d = from + ((e.clientX - r.left) / Math.max(1, r.width)) * (to - from);
    let best = 0;
    for (let j = 1; j < pts.length; j++) if (Math.abs(pts[j].date - d) < Math.abs(pts[best].date - d)) best = j;
    show(best);
  });
  plot.addEventListener("pointerleave", hide);
  plot.addEventListener("focus", () => show(pts.length - 1));
  plot.addEventListener("blur", hide);
  plot.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    show(Math.max(0, Math.min(pts.length - 1, at + (e.key === "ArrowLeft" ? -1 : 1))));
  });
}
