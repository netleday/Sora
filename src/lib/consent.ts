// The terms for Sora's online features and downloads, and the block screens. Sora works on its
// own without anything; searching and downloading maps on the mirrors, logging in with osu!, the
// cloud and comparing go online, and they come with terms (fumen.dertesti.dev/terms): the block
// check at each start, with this install's random number and codes made from the computer's ids
// (src-tauri/src/online.rs), which also counts the start. The first start shows them once; "Only
// local" keeps all of it off, and a button that needs them offers them again (needOnline). What
// the site keeps: fumen.dertesti.dev/privacy.
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, asApiError, isTauri } from "./api";
import { t } from "./i18n";
import { store } from "./store";
import type { FumenBlock } from "./types";
import { closeAnimated, toast } from "../ui/controls";

const PRIVACY = "https://fumen.dertesti.dev/privacy";
const TERMS = "https://fumen.dertesti.dev/terms";

/** At the start: a block noted here first, then the terms (once), then the check. */
export async function startConsent(): Promise<void> {
  if (!isTauri) return;
  const noted = await api.notedBlock().catch(() => null);
  showFor(noted);
  if (!store.settings?.termsAsked) await askTerms(false);
  if (store.settings?.online) await checkBlock(false);
}

/** Whether the online features are on, for a button that needs them: when they're off, their
 * terms come first, and accepting them turns them on. */
export async function needOnline(): Promise<boolean> {
  if (store.settings?.online) return true;
  return askTerms(true);
}

/** A full block takes Sora over; an online one is said once per start, over the app. */
let onlineSaid = false;
function showFor(b: FumenBlock | null | undefined): void {
  if (b?.scope === "full") {
    hideOnline();
    showBlock(b);
    return;
  }
  hideBlock();
  if (b?.scope === "online") {
    if (!onlineSaid) showOnline(b);
    onlineSaid = true;
  } else {
    hideOnline();
    onlineSaid = false;
  }
}

/** The block check: a full block shows the block page, an online one the notice, none takes
 * them away. Offline, what's noted holds. \`ask\`: from the block page (also with the online
 * features off). */
export async function checkBlock(ask: boolean): Promise<FumenBlock | null | undefined> {
  try {
    const b = await api.checkBlock(ask);
    showFor(b);
    return b;
  } catch (e) {
    if (ask) toast(asApiError(e).message, { kind: "danger", timeout: 6000 });
    else console.warn("[check]", asApiError(e).message);
    return undefined;
  }
}

/** The terms, one answer: "Accept" turns the online features on, "Only local" leaves them off for
 * good (at the first start), "Not now" just for this time (\`later\`: from a button that needs
 * them). Escape is the second. Resolves with whether they're on. */
function askTerms(later: boolean): Promise<boolean> {
  return new Promise((resolve) => {
    const bd = document.createElement("div");
    bd.className = "modal-backdrop dialog-backdrop";
    bd.innerHTML = `
      <div class="modal-panel dialog consent" role="dialog" aria-modal="true" aria-labelledby="consent-title">
        <div class="dialog-title" id="consent-title">${t("Online features and downloads")}</div>
        <div class="dialog-msg">${t("Sora works on your computer, and your library, playing and everything else in it work without this. Searching and downloading maps, logging in with osu!, the cloud and comparing with other players go online, and they come with a few terms:")}</div>
        <ul class="consent-terms">
          <li>${t("At each start, Sora checks with fumen.dertesti.dev whether it's blocked. Along go a random number made for this install and codes made from this computer's ids (Windows and the mainboard). The ids never leave your computer, and the codes can't be turned back into them.")}</li>
          <li>${t("The same check counts this Sora among the ones in use.")}</li>
          <li>${t("Don't misuse the mirrors or fumen.dertesti.dev, for example by scraping them or getting around their limits. Misuse can get the online features blocked, or Sora on this computer.")}</li>
        </ul>
        <div class="consent-login" hidden>${t("You're logged in with osu!. Logging in is one of the online features, so without them, Sora logs you out.")}</div>
        <div class="consent-links">
          <button class="btn btn-ghost btn-sm" type="button" data-act="terms">${t("Terms")}</button>
          <button class="btn btn-ghost btn-sm" type="button" data-act="privacy">${t("Privacy")}</button>
          <span>${t("You can change this later in Settings › About.")}</span>
        </div>
        <div class="dialog-actions">
          <button class="btn btn-ghost" type="button" data-act="no">${later ? t("Not now") : t("Only local")}</button>
          <button class="btn btn-primary" type="button" data-act="yes">${t("Accept")}</button>
        </div>
      </div>`;
    document.body.appendChild(bd);
    if (!later) {
      void api
        .osuAccount()
        .then((a) => (bd.querySelector<HTMLElement>(".consent-login")!.hidden = !a))
        .catch(() => {});
    }
    let done = false;
    const finish = async (accept: boolean) => {
      if (done) return;
      done = true;
      document.removeEventListener("keydown", onKey, true);
      let on = false;
      try {
        // "Not now" changes nothing; the rest is an answer that's kept
        if (accept || !later) store.settings = await api.setOnline(accept);
        on = accept;
      } catch (e) {
        toast(asApiError(e).message, { kind: "danger", timeout: 6000 });
      }
      closeAnimated(bd);
      if (on) void checkBlock(false);
      resolve(on);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      void finish(false);
    };
    document.addEventListener("keydown", onKey, true);
    const open = (url: string) => void openUrl(url).catch((e) => toast(asApiError(e).message, { kind: "danger" }));
    bd.querySelector('[data-act="terms"]')!.addEventListener("click", () => open(TERMS));
    bd.querySelector('[data-act="privacy"]')!.addEventListener("click", () => open(PRIVACY));
    bd.querySelector('[data-act="no"]')!.addEventListener("click", () => void finish(false));
    bd.querySelector('[data-act="yes"]')!.addEventListener("click", () => void finish(true));
    setTimeout(() => bd.querySelector<HTMLButtonElement>('[data-act="yes"]')!.focus(), 30);
  });
}

let page: HTMLElement | null = null;
/** keys don't reach Sora behind the block page */
const swallowKeys = (e: KeyboardEvent) => {
  if (page && !page.contains(e.target as Node)) {
    e.preventDefault();
    e.stopPropagation();
  }
};

/** The site's words, one paragraph each (it parts them with a blank line). The first one says
 * what's blocked, which the page's title already does; the reason gets its own block. */
function blockParagraphs(message: string): HTMLElement[] {
  const parts = message.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const shown = parts.length > 1 ? parts.slice(1) : parts;
  return shown.map((text) => {
    const reason = /^Reason:\s*(.*)$/s.exec(text);
    const contact = /^If you think that's a mistake:\s*(.*)$/s.exec(text);
    if (reason) {
      const box = document.createElement("div");
      box.className = "fumen-block-reason";
      const label = document.createElement("span");
      label.textContent = t("Reason");
      const words = document.createElement("p");
      words.textContent = reason[1];
      box.append(label, words);
      return box;
    }
    const p = document.createElement("p");
    p.textContent = contact ? `${t("If you think that's a mistake:")} ${contact[1]}` : text;
    return p;
  });
}

/** The card both block screens share: the badge on its striped head, then the words. */
function blockCard(o: { eyebrow: string; title: string; note: string; actions: string; small?: string }): string {
  return `
    <div class="fumen-block-panel" role="alertdialog" aria-modal="true" aria-labelledby="fumen-block-title">
      <div class="fumen-block-card">
        <div class="fumen-block-head">
          <div class="fumen-block-badge" aria-hidden="true">
            <svg viewBox="0 0 48 48"><circle class="ring" cx="24" cy="24" r="17" pathLength="1"/><path class="slash" d="M12 12 36 36" pathLength="1"/></svg>
          </div>
        </div>
        <div class="fumen-block-body">
          <div class="fumen-block-eyebrow">${o.eyebrow}</div>
          <div class="fumen-block-title" id="fumen-block-title">${o.title}</div>
          <div class="fumen-block-msg"></div>
          <p class="fumen-block-note">${o.note}</p>
          <div class="fumen-block-actions">${o.actions}</div>
        </div>
      </div>
      ${o.small ? `<p class="fumen-block-small">${o.small}</p>` : ""}
    </div>`;
}

/** The card's words from the site, and its privacy button. */
function fillCard(el: HTMLElement, b: FumenBlock): void {
  el.querySelector(".fumen-block-msg")!.replaceChildren(...blockParagraphs(b.message));
  el.querySelector('[data-act="privacy"]')!.addEventListener("click", () =>
    void openUrl(PRIVACY).catch((e) => toast(asApiError(e).message, { kind: "danger" })),
  );
}

let notice: HTMLElement | null = null;
const noticeKeys = (e: KeyboardEvent) => {
  if (e.key === "Escape" || e.key === "Enter") {
    e.preventDefault();
    e.stopPropagation();
    hideOnline();
  }
};

/** An online block, said over the app: the login, the cloud and comparing are off, the rest works. */
function showOnline(b: FumenBlock): void {
  hideOnline(true);
  notice = document.createElement("div");
  notice.className = "fumen-block is-online";
  notice.innerHTML = blockCard({
    eyebrow: t("Online blocked"),
    title: t("Sora's online features are blocked"),
    note: t("Logging in, the cloud, comparing and downloading maps are off. Everything else in Sora works as usual."),
    actions: `
      <button class="btn btn-ghost" type="button" data-act="privacy">${t("Privacy")}</button>
      <button class="btn btn-danger" type="button" data-act="close">${t("Got it")}</button>`,
  });
  fillCard(notice, b);
  notice.querySelector('[data-act="close"]')!.addEventListener("click", () => hideOnline());
  notice.addEventListener("click", (e) => {
    if (e.target === notice) hideOnline();
  });
  document.body.appendChild(notice);
  document.addEventListener("keydown", noticeKeys, true);
  notice.querySelector<HTMLButtonElement>('[data-act="close"]')!.focus({ preventScroll: true });
}

function hideOnline(now = false): void {
  if (!notice) return;
  const el = notice;
  notice = null;
  document.removeEventListener("keydown", noticeKeys, true);
  if (now) return el.remove();
  el.classList.add("closing");
  setTimeout(() => el.remove(), 200);
}

/** Sora behind a page with the site's reason and where to turn; the files stay as they are. */
function showBlock(b: FumenBlock): void {
  if (!page) {
    page = document.createElement("div");
    page.className = "fumen-block";
    document.body.appendChild(page);
    document.body.classList.add("fumen-blocked");
    document.addEventListener("keydown", swallowKeys, true);
  }
  page.innerHTML = blockCard({
    eyebrow: t("Blocked"),
    title: t("Sora is blocked on this computer"),
    note: t("Your files stay as they are. Sora hasn't changed or deleted anything."),
    actions: `
      <button class="btn btn-ghost" type="button" data-act="privacy">${t("Privacy")}</button>
      <button class="btn btn-danger" type="button" data-act="ask">${t("Ask again")}</button>`,
    small: store.settings?.online
      ? t("Asks fumen.dertesti.dev whether the block was lifted.")
      : t("Asks fumen.dertesti.dev whether the block was lifted, with Sora's random number only."),
  });
  fillCard(page, b);
  const ask = page.querySelector<HTMLButtonElement>('[data-act="ask"]')!;
  ask.addEventListener("click", async () => {
    ask.disabled = true;
    const now = await checkBlock(true);
    // an online block left over shows its own notice (showFor)
    if (now === null) toast(t("The block is lifted."), { kind: "success" });
    else if (now?.scope === "full") {
      toast(t("Still blocked."));
      // a short shake again, so the answer is felt
      page?.classList.remove("again");
      void page?.offsetWidth;
      page?.classList.add("again");
    }
    ask.disabled = false;
  });
}

function hideBlock(): void {
  if (!page) return;
  page.remove();
  page = null;
  document.body.classList.remove("fumen-blocked");
  document.removeEventListener("keydown", swallowKeys, true);
}
