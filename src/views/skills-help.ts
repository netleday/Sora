/* skills-help.ts — "How Skills work": what the Skills page's numbers mean, from the info button in
 * its header, so the page itself only shows them. */
import { t } from "../lib/i18n";
import { closeAnimated } from "../ui/controls";
import { icon } from "../ui/icons";

export function openSkillsHelp(): void {
  const parts: [string, string][] = [
    [t("What a pass is worth"), t("Every osu!mania pass is rated with MinaCalc, Etterna's calculator: the map at the rate you played, for your accuracy as Etterna counts it. That gives a number per skillset.")],
    [t("Your skill"), t("A skillset blends your passes the way Etterna does. Your best count most, and it takes many good passes to get up there. Overall blends the seven skillsets.")],
    [t("What counts"), t("Passes only, without mods like Hold Off. A map counts with its two best rates, and rate edits count as the same map.")],
    [
      t("Maps that don't count"),
      t("Sora leaves out maps with parts no hand plays as written, like jacks or trills past a finger's speed (vibro), with mania-tracker's rules. If it's only a small part, it's cut out before rating. You can leave maps out yourself too, and a pass worth far more than your skill is marked."),
    ],
    [t("Practice next"), t("Maps in your library a little above your best plays in your weakest skillsets, at a rate that gets them there.")],
  ];
  const bd = document.createElement("div");
  bd.className = "modal-backdrop dialog-backdrop";
  bd.innerHTML = `
    <div class="modal-panel dialog changelog skills-help" role="dialog" aria-modal="true" aria-labelledby="skills-help-title">
      <button class="icon-btn modal-close" type="button" data-act="close" aria-label="${t("Close")}">${icon("x")}</button>
      <div class="dialog-title" id="skills-help-title">${t("How Skills work")}</div>
      <div class="changelog-list">
        ${parts.map(([head, text]) => `<section class="skills-help-part"><b>${head}</b><p>${text}</p></section>`).join("")}
      </div>
      <div class="dialog-actions">
        <button class="btn btn-primary" type="button" data-act="close">${t("Close")}</button>
      </div>
    </div>`;
  document.body.appendChild(bd);
  setTimeout(() => bd.querySelector<HTMLButtonElement>('.dialog-actions [data-act="close"]')?.focus(), 30);
  const close = () => {
    document.removeEventListener("keydown", onKey, true);
    closeAnimated(bd);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    close();
  };
  document.addEventListener("keydown", onKey, true);
  bd.addEventListener("pointerdown", (e) => {
    if (e.target === bd) close();
  });
  bd.addEventListener("click", (e) => {
    if ((e.target as Element).closest("[data-act='close']")) close();
  });
}
