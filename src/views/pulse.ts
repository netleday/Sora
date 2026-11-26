/* pulse.ts — a try's pulse from a heart rate monitor (lib/heart-stats): what it came to and its
 * curve over the song, over the map's density, with its fastest part marked. With a strap that
 * sends the beats' spacing (1.5): the HRV as a second curve and the spots where the nerves set in
 * (the pulse climbing while the HRV falls away). Shown with a pass's score (views/score.ts) and
 * with your tries (views/tries.ts). */
import { duration } from "../lib/format";
import { hrvCurve, nerveSpots, type HeartTrack } from "../lib/heart-stats";
import { t } from "../lib/i18n";
import { hardest } from "../lib/practice";
import type { ChartData } from "../lib/types";

/** The section, or "" without a pulse. `chart`: the map's (for its length, density and fastest
 * part); `rate`: the try's (DT 1.5), which turns real seconds into song ms. */
export function pulseSection(h: HeartTrack | null | undefined, chart: ChartData | null, rate = 1): string {
  if (!h || h.samples.length < 2) return "";
  const s = h.samples;
  // the same length as the tries' heat above it (whole seconds)
  const end = Math.max(chart ? Math.ceil((chart.analysis.end + 1000) / 1000) * 1000 : 0, s[s.length - 1][0], 1000);
  const lo = Math.max(30, h.min - 8);
  const hi = Math.max(lo + 20, Math.min(240, h.max + 8));
  const W = 1000;
  const H = 100;
  const x = (ms: number): number => (Math.max(0, Math.min(end, ms)) / end) * W;
  const y = (bpm: number): number => H - ((bpm - lo) / (hi - lo)) * H;
  const pts = s.map(([ms, bpm]) => `${x(ms).toFixed(1)},${y(bpm).toFixed(1)}`);
  const line = `M${pts.join("L")}`;
  const area = `${line}L${x(s[s.length - 1][0]).toFixed(1)},${H}L${x(s[0][0]).toFixed(1)},${H}Z`;
  const peak = s.reduce((a, b) => (b[1] > a[1] ? b : a));
  const at = (ms: number): string => ((x(ms) / W) * 100).toFixed(3);
  const fast = chart ? hardest(chart) : null;
  const band = fast
    ? `<span class="score-band pulse-band" style="left:${at(fast.a)}%;width:${(((Math.min(end, fast.b) - fast.a) / end) * 100).toFixed(3)}%" data-tip="${t("The map's fastest part")}"></span>`
    : "";
  const dens = chart?.analysis.density ?? [];
  const top = Math.max(1, ...dens);
  const bars = dens.map((v, i) => `<i style="left:${at(chart!.analysis.start + i * 1000)}%;height:${((v / top) * 100).toFixed(1)}%"></i>`).join("");

  // the HRV on a scale of its own (0 at the bottom), and where the nerves set in
  const curve = h.rr?.length ? hrvCurve(h.rr, rate) : [];
  let hrvPath = "";
  if (curve.length >= 2) {
    const top = Math.max(...curve.map(([, v]) => v)) * 1.15;
    const yh = (v: number): number => H - (v / top) * H;
    hrvPath = `<path class="pulse-hrv" d="M${curve.map(([ms, v]) => `${x(ms).toFixed(1)},${yh(v).toFixed(1)}`).join("L")}" />`;
  }
  const spots = curve.length ? nerveSpots(s, curve, rate) : [];
  // a spot is at least two seconds wide, so it can be seen and pointed at
  const minW = 2000 * rate;
  const nerveBands = spots
    .map((n) => {
      const a = Math.max(0, n.a - minW / 2);
      const b = Math.min(end, Math.max(n.b, n.a + minW / 2));
      const tip = t("Nerves at {at}: pulse +{rise}, HRV −{drop} %", { at: duration(n.a), rise: Math.round(n.rise), drop: Math.round(n.drop * 100) });
      return `<span class="pulse-nerves" style="left:${at(a)}%;width:${(((b - a) / end) * 100).toFixed(3)}%" data-tip="${tip}"></span>`;
    })
    .join("");

  const fact = (label: string, v: number | null | undefined, unit = "bpm"): string =>
    v === null || v === undefined ? "" : `<span><i>${label}</i><b>${Math.round(v)}<small> ${unit}</small></b></span>`;
  const nervesFact = curve.length
    ? `<span><i>${t("Nerves")}</i><b>${spots.length ? t("from {at}", { at: duration(spots[0].a) }) : t("Calm")}</b></span>`
    : "";
  const legend = curve.length
    ? `<div class="pulse-legend">
        <span class="pl-pulse">${t("Pulse")}</span>
        <span class="pl-hrv" data-tip="${t("RMSSD over the half minute around each moment: lower is more stress. A tendency, not a measurement.")}">HRV</span>
        ${spots.length ? `<span class="pl-nerves">${t("Pulse climbing while the HRV falls")}</span>` : ""}
      </div>`
    : "";
  return `
    <section class="section">
      <h2 class="section-title">${t("Your pulse")}</h2>
      <div class="score-facts num pulse-facts">
        ${fact(t("Average"), h.avg)}
        ${fact(t("Highest"), h.max)}
        ${fact(t("Lowest"), h.min)}
        ${fact(t("In the fastest part"), h.fast)}
        ${fact("HRV", h.hrv, "ms")}
        ${nervesFact}
      </div>
      <div class="score-graph pulse-graph" aria-label="${t("Your pulse over the song")}">
        <div class="score-density">${bars}</div>
        ${band}
        ${nerveBands}
        <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
          <path class="pulse-area" d="${area}" />
          ${hrvPath}
          <path class="pulse-line" d="${line}" />
        </svg>
        <b class="pulse-peak" style="left:${at(peak[0])}%;--y:${(y(peak[1]) / H).toFixed(3)}" data-tip="${t("Highest: {bpm} bpm at {at}", { bpm: peak[1], at: duration(peak[0]) })}"></b>
      </div>
      <div class="score-graph-axis num"><span>0:00</span>${legend}<span>${duration(end)}</span></div>
    </section>`;
}
