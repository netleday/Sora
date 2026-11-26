/* skins.ts — Sora Skins Manager (osuck.net-style 16:9 Cards, In-Card Screenshot Arrows & Fullscreen Gallery) */
import { invoke } from "@tauri-apps/api/core";
import { asApiError } from "../lib/api";
import { esc } from "../lib/format";
import { loadSkinList } from "../lib/skin/skins";
import { setPrefs, store } from "../lib/store";
import { toast } from "../ui/controls";
import { icon } from "../ui/icons";

interface CatalogSkinEntry {
  id: string;
  name: string;
  author: string;
  source: string;
  thumbUrl: string;
  images: string[];
  detailUrl: string;
  downloadUrl: string;
}

interface SkinGalleryInfo {
  images: string[];
  downloadUrl: string;
}

interface LocalSkinElements {
  cursor?: string | null;
  hitcircle?: string | null;
  hitcircleoverlay?: string | null;
  approachcircle?: string | null;
  sliderb?: string | null;
  menuBg?: string | null;
  rankingPanel?: string | null;
  selectionMode?: string | null;
}

interface LocalSkinPreview {
  id: string;
  name: string;
  creator: string;
  kind: string;
  source: string;
  selected: boolean;
  coverDataUrl?: string | null;
  elements: LocalSkinElements;
  folderPath?: string | null;
}

const imgCache = new Map<string, string>();

async function resolveImage(url: string): Promise<string | null> {
  if (!url) return null;
  const hit = imgCache.get(url);
  if (hit) return hit;
  try {
    const dataUrl = await invoke<string>("fetch_skin_image", { url });
    if (!dataUrl || !dataUrl.startsWith("data:image/")) return null;
    imgCache.set(url, dataUrl);
    return dataUrl;
  } catch {
    return null;
  }
}

export class SkinsView {
  readonly el: HTMLElement;
  private tab: "local" | "catalog" = "catalog";
  private query = "";
  private localSkins: LocalSkinPreview[] = [];
  private loadingLocal = false;
  private catalog: CatalogSkinEntry[] = [];
  private loadingCatalog = false;

  constructor() {
    this.el = document.createElement("div");
    this.el.className = "skins-page";
    this.render();
    void this.loadOnlineCatalog();
  }

  shown(): void {
    void this.refreshLocal();
    if (this.catalog.length === 0 && !this.loadingCatalog) void this.loadOnlineCatalog();
  }

  destroy(): void {
    this.el.remove();
  }

  private async refreshLocal(): Promise<void> {
    if (this.loadingLocal) return;
    this.loadingLocal = true;
    if (this.tab === "local") this.renderGrid();
    try {
      this.localSkins = await invoke<LocalSkinPreview[]>("list_local_skin_previews");
    } catch {
      try {
        const list = await loadSkinList();
        this.localSkins = list.skins.map((s) => ({
          id: s.id,
          name: s.name,
          creator: "osu!lazer",
          kind: s.kind,
          source: "lazer",
          selected: list.selected === s.id,
          coverDataUrl: null,
          elements: {},
          folderPath: null,
        }));
      } catch {}
    } finally {
      this.loadingLocal = false;
      if (this.tab === "local") this.renderGrid();
    }
  }

  private async loadOnlineCatalog(): Promise<void> {
    if (this.loadingCatalog) return;
    this.loadingCatalog = true;
    this.renderGrid();
    try {
      this.catalog = await invoke<CatalogSkinEntry[]>("fetch_skins_catalog");
    } catch (e) {
      toast(asApiError(e).message, { kind: "danger" });
    } finally {
      this.loadingCatalog = false;
      if (this.tab === "catalog") this.renderGrid();
    }
  }

  private async installSkin(name: string, downloadUrl: string, btn?: HTMLButtonElement): Promise<void> {
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Скачивание .osk…";
    }
    try {
      const client = store.prefs.launchClient === "stable" ? "stable" : "lazer";
      const msg = await invoke<string>("install_catalog_skin", {
        url: downloadUrl,
        name,
        target: client,
      });
      toast(msg || `Скин «${name}» установлен в ${client}!`, { kind: "success" });
      if (btn) btn.textContent = "Установлено";
    } catch (e) {
      toast(asApiError(e).message, { kind: "danger", timeout: 6000 });
      if (btn) {
        btn.disabled = false;
        btn.textContent = "Установить в osu!";
      }
    }
  }

  private async openGalleryModal(s: CatalogSkinEntry, startIdx = 0): Promise<void> {
    const back = document.createElement("div");
    back.className = "sora-modal-backdrop";
    back.innerHTML = `
      <div class="sora-modal" style="width:min(860px,96vw);">
        <div class="sora-modal-head">
          <h3 class="sora-modal-title">${esc(s.name)}</h3>
          <button type="button" class="icon-btn sk-close">${icon("x")}</button>
        </div>
        <div class="sk-gallery-stage" style="position:relative;aspect-ratio:16/9;width:100%;border-radius:12px;overflow:hidden;background:#09070f;border:1px solid var(--border);display:flex;align-items:center;justify-content:center;">
          <img class="sk-gal-main" src="" alt="${esc(s.name)}" style="width:100%;height:100%;object-fit:contain;" />
          <button type="button" class="icon-btn sk-prev" style="position:absolute;left:12px;background:rgba(12,9,22,0.75);">${icon("chevron-left")}</button>
          <button type="button" class="icon-btn sk-next" style="position:absolute;right:12px;background:rgba(12,9,22,0.75);">${icon("chevron-right")}</button>
        </div>
        <div class="sk-thumbs" style="display:flex;gap:8px;overflow-x:auto;padding:4px 0;"></div>
        <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;">
          <div style="font-size:13px;color:var(--text-dim);">Автор: <strong style="color:var(--text);">${esc(s.author)}</strong></div>
          <button type="button" class="btn btn-primary sk-install">Установить в osu!</button>
        </div>
      </div>`;

    back.addEventListener("click", (e) => {
      if (e.target === back || (e.target as HTMLElement).closest(".sk-close")) back.remove();
    });
    document.body.appendChild(back);

    const mainImg = back.querySelector<HTMLImageElement>(".sk-gal-main")!;
    const thumbsEl = back.querySelector<HTMLElement>(".sk-thumbs")!;
    const instBtn = back.querySelector<HTMLButtonElement>(".sk-install")!;

    let images = s.images?.length ? [...s.images] : [s.thumbUrl];
    let dlUrl = s.downloadUrl;
    let idx = startIdx;

    const showAt = async (i: number) => {
      idx = (i + images.length) % images.length;
      const src = await resolveImage(images[idx]);
      if (src) mainImg.src = src;
      thumbsEl.querySelectorAll("img").forEach((t, ti) => {
        t.style.borderColor = ti === idx ? "#c77dff" : "transparent";
      });
    };

    back.querySelector(".sk-prev")?.addEventListener("click", () => void showAt(idx - 1));
    back.querySelector(".sk-next")?.addEventListener("click", () => void showAt(idx + 1));
    instBtn.addEventListener("click", () => void this.installSkin(s.name, dlUrl, instBtn));

    void showAt(idx);
    try {
      const gal = await invoke<SkinGalleryInfo>("fetch_skin_gallery", {
        detailUrl: s.detailUrl,
        fallbackThumb: s.thumbUrl,
        fallbackDl: s.downloadUrl,
      });
      if (gal.images?.length) images = gal.images;
      if (gal.downloadUrl) dlUrl = gal.downloadUrl;
      thumbsEl.innerHTML = "";
      for (let i = 0; i < images.length; i++) {
        const resolved = await resolveImage(images[i]);
        if (!resolved) continue;
        const ti = document.createElement("img");
        ti.style.cssText = "width:96px;height:54px;object-fit:cover;border-radius:7px;cursor:pointer;border:2px solid transparent;flex-shrink:0;";
        ti.src = resolved;
        ti.addEventListener("click", () => void showAt(i));
        thumbsEl.appendChild(ti);
      }
      void showAt(idx);
    } catch {}
  }

  private openLocalSkinModal(s: LocalSkinPreview): void {
    const back = document.createElement("div");
    back.className = "sora-modal-backdrop";

    const items: { label: string; src: string | null | undefined; wide?: boolean }[] = [
      { label: "Menu Background", src: s.elements.menuBg, wide: true },
      { label: "Selection Mode", src: s.elements.selectionMode, wide: true },
      { label: "Ranking Panel", src: s.elements.rankingPanel, wide: true },
      { label: "Cursor", src: s.elements.cursor },
      { label: "Hit Circle", src: s.elements.hitcircle },
      { label: "Hit Circle Overlay", src: s.elements.hitcircleoverlay },
      { label: "Approach Circle", src: s.elements.approachcircle },
      { label: "Slider Ball", src: s.elements.sliderb },
    ].filter((it) => Boolean(it.src));

    const itemsHtml = items.length
      ? items
          .map(
            (it) => `
          <div style="background:rgba(16,12,28,0.85);border:1px solid var(--border);border-radius:10px;padding:10px;display:flex;flex-direction:column;gap:8px;align-items:center;${it.wide ? "grid-column:span 2;" : ""}">
            <div style="width:100%;height:${it.wide ? "140px" : "84px"};display:flex;align-items:center;justify-content:center;overflow:hidden;border-radius:7px;background:#09070f;">
              <img src="${it.src}" alt="${esc(it.label)}" style="max-width:100%;max-height:100%;object-fit:${it.wide ? "cover" : "contain"};" />
            </div>
            <span style="font-size:11px;color:var(--text-dim);">${esc(it.label)}</span>
          </div>`
          )
          .join("")
      : `<div style="grid-column:1/-1;padding:24px;text-align:center;color:var(--text-dim);">Этот скин использует процедурную графику osu!lazer (${esc(s.kind)}) без отдельных PNG-файлов.</div>`;

    back.innerHTML = `
      <div class="sora-modal" style="width:min(780px,95vw);max-height:88vh;overflow-y:auto;">
        <div class="sora-modal-head">
          <div>
            <h3 class="sora-modal-title">${esc(s.name)}</h3>
            <div style="font-size:12px;color:var(--text-dim);margin-top:2px;">Автор: ${esc(s.creator)} • Источник: ${s.source === "stable" ? "osu!stable" : `osu!lazer (${esc(s.kind)})`}</div>
          </div>
          <button type="button" class="icon-btn sk-close">${icon("x")}</button>
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(145px,1fr));gap:10px;margin:12px 0;">
          ${itemsHtml}
        </div>
        <div style="display:flex;justify-content:flex-end;gap:10px;">
          ${
            s.source === "lazer"
              ? `<button type="button" class="btn btn-primary sk-modal-use">${store.prefs.playfieldSkin === s.id ? "Активен для превью" : "Выбрать для превью"}</button>`
              : ""
          }
        </div>
      </div>`;

    back.addEventListener("click", (e) => {
      if (e.target === back || (e.target as HTMLElement).closest(".sk-close")) back.remove();
    });
    back.querySelector(".sk-modal-use")?.addEventListener("click", () => {
      setPrefs({ playfieldSkin: s.id });
      toast("Скин выбран для превью карт в Sora!");
      this.renderGrid();
      back.remove();
    });
    document.body.appendChild(back);
  }

  private renderLocalStage(s: LocalSkinPreview): string {
    if (s.coverDataUrl) {
      return `<img src="${s.coverDataUrl}" alt="${esc(s.name)}" style="width:100%;height:100%;object-fit:cover;display:block;" />`;
    }
    if (s.elements.hitcircle || s.elements.cursor || s.elements.approachcircle) {
      return `
        <div style="width:100%;height:100%;background:radial-gradient(circle at 30% 30%, rgba(157,78,221,0.24), rgba(10,8,18,0.96));display:flex;align-items:center;justify-content:center;gap:22px;padding:16px;position:relative;">
          ${
            s.elements.hitcircle
              ? `<div style="position:relative;width:74px;height:74px;display:flex;align-items:center;justify-content:center;">
                  ${s.elements.approachcircle ? `<img src="${s.elements.approachcircle}" alt="" style="position:absolute;inset:-8px;width:90px;height:90px;object-fit:contain;opacity:0.85;" />` : ""}
                  <img src="${s.elements.hitcircle}" alt="" style="width:66px;height:66px;object-fit:contain;" />
                  ${s.elements.hitcircleoverlay ? `<img src="${s.elements.hitcircleoverlay}" alt="" style="position:absolute;width:66px;height:66px;object-fit:contain;" />` : ""}
                </div>`
              : ""
          }
          ${s.elements.cursor ? `<img src="${s.elements.cursor}" alt="" style="width:42px;height:42px;object-fit:contain;filter:drop-shadow(0 0 8px rgba(199,125,255,0.45));" />` : ""}
          ${s.elements.sliderb ? `<img src="${s.elements.sliderb}" alt="" style="width:46px;height:46px;object-fit:contain;opacity:0.9;" />` : ""}
        </div>`;
    }
    const initials = esc(
      s.name
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((w) => w[0]?.toUpperCase() ?? "")
        .join("") || "S"
    );
    return `
      <div style="width:100%;height:100%;background:linear-gradient(135deg, rgba(123,44,191,0.28), rgba(15,11,26,0.96));display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;">
        <div style="width:52px;height:52px;border-radius:14px;border:1px solid rgba(199,125,255,0.35);background:rgba(24,18,40,0.85);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:18px;color:#e0aaff;letter-spacing:0.04em;">${initials}</div>
        <span style="font-size:11px;color:var(--text-dim);text-transform:uppercase;letter-spacing:0.08em;">${esc(s.kind)}</span>
      </div>`;
  }

  private renderGrid(): void {
    const grid = this.el.querySelector<HTMLElement>(".skins-grid");
    if (!grid) return;

    if (this.tab === "local") {
      if (this.loadingLocal && this.localSkins.length === 0) {
        grid.innerHTML = `<div style="color:var(--text-dim);padding:24px;">Сканирование локальных скинов osu!…</div>`;
        return;
      }
      const q = this.query.toLowerCase();
      const list = this.localSkins.filter((s) => !q || `${s.name} ${s.creator}`.toLowerCase().includes(q));
      if (list.length === 0) {
        grid.innerHTML = `<div style="color:var(--text-dim);padding:24px;">Локальные скины пока не найдены. Укажите папку osu!lazer / osu!stable в Настройках или установите скин из Каталога.</div>`;
        return;
      }
      grid.innerHTML = list
        .map(
          (s) => `
        <div class="skin-card" data-local-id="${esc(s.id)}">
          <div class="skin-stage" style="padding:0;height:auto;aspect-ratio:16/9;overflow:hidden;position:relative;background:#09070f;">
            <span class="skin-badge" style="z-index:2;">${s.source === "stable" ? "stable" : esc(s.kind)}</span>
            ${this.renderLocalStage(s)}
          </div>
          <div class="skin-body">
            <div class="skin-name">${esc(s.name)}</div>
            <div class="skin-meta">${esc(s.creator)} • ${s.source === "stable" ? "osu!stable" : "osu!lazer"}</div>
            ${
              s.source === "lazer"
                ? `<button type="button" class="btn btn-sm sk-use-local" data-id="${esc(s.id)}">${store.prefs.playfieldSkin === s.id ? "Активен для превью" : "Выбрать для превью"}</button>`
                : `<button type="button" class="btn btn-sm sk-open-local" data-id="${esc(s.id)}">Просмотр элементов</button>`
            }
          </div>
        </div>`
        )
        .join("");

      grid.querySelectorAll<HTMLElement>(".skin-card[data-local-id]").forEach((card) => {
        const id = card.dataset.localId;
        const skin = list.find((x) => x.id === id);
        if (!skin) return;
        card.addEventListener("click", (e) => {
          if ((e.target as HTMLElement).closest(".sk-use-local")) return;
          this.openLocalSkinModal(skin);
        });
      });

      grid.querySelectorAll<HTMLButtonElement>(".sk-use-local").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          setPrefs({ playfieldSkin: btn.dataset.id ?? null });
          toast("Скин выбран для превью карт в Sora!");
          this.renderGrid();
        });
      });
      return;
    }

    if (this.loadingCatalog && this.catalog.length === 0) {
      grid.innerHTML = `<div style="color:var(--text-dim);padding:24px;">Загрузка каталога скинов и скриншотов…</div>`;
      return;
    }

    const q = this.query.toLowerCase();
    const list = this.catalog.filter((s) => {
      if (!s.thumbUrl && (!s.images || s.images.length === 0)) return false;
      if (q && !`${s.name} ${s.author}`.toLowerCase().includes(q)) return false;
      return true;
    });
    if (list.length === 0) {
      grid.innerHTML = `<div style="color:var(--text-dim);padding:24px;">Скины по запросу не найдены.</div>`;
      return;
    }

    grid.innerHTML = "";
    for (const s of list) {
      const images = s.images?.length ? s.images : [s.thumbUrl];
      let curIdx = 0;

      const card = document.createElement("div");
      card.className = "skin-card";
      card.style.display = "none"; // strict filter: show only once a real screenshot loads!
      card.innerHTML = `
        <div class="skin-stage" style="padding:0;height:auto;aspect-ratio:16/9;overflow:hidden;position:relative;background:#09070f;">
          <img class="sk-card-img" src="" alt="${esc(s.name)}" style="width:100%;height:100%;object-fit:cover;display:block;" />
          ${images.length > 1 ? `<button type="button" class="sk-card-arrow sk-card-prev" aria-label="Предыдущий скриншот">${icon("chevron-left")}</button><button type="button" class="sk-card-arrow sk-card-next" aria-label="Следующий скриншот">${icon("chevron-right")}</button>` : ""}
          <button type="button" class="sk-card-expand" title="Развернуть галерею">${icon("fullscreen")}</button>
        </div>
        <div class="skin-body">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
            <span class="skin-badge" style="position:static;">osu!</span>
            <span class="skin-meta" style="margin-left:auto;">${esc(s.author)}</span>
          </div>
          <div class="skin-name">${esc(s.name)}</div>
          <button type="button" class="btn btn-sm btn-primary sk-card-install">Установить в osu!</button>
        </div>`;

      const img = card.querySelector<HTMLImageElement>(".sk-card-img")!;
      const loadSlide = async (idx: number) => {
        curIdx = (idx + images.length) % images.length;
        const src = await resolveImage(images[curIdx]);
        if (!src) {
          if (curIdx === 0) card.remove();
          return;
        }
        img.src = src;
        card.style.display = "flex";
      };

      img.onerror = () => card.remove();
      void loadSlide(0);

      card.querySelector(".sk-card-prev")?.addEventListener("click", (e) => {
        e.stopPropagation();
        void loadSlide(curIdx - 1);
      });
      card.querySelector(".sk-card-next")?.addEventListener("click", (e) => {
        e.stopPropagation();
        void loadSlide(curIdx + 1);
      });
      card.querySelector(".sk-card-expand")?.addEventListener("click", (e) => {
        e.stopPropagation();
        void this.openGalleryModal(s, curIdx);
      });
      card.addEventListener("click", (e) => {
        if ((e.target as HTMLElement).closest(".sk-card-install, .sk-card-arrow, .sk-card-expand")) return;
        void this.openGalleryModal(s, curIdx);
      });
      const btn = card.querySelector<HTMLButtonElement>(".sk-card-install")!;
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        void this.installSkin(s.name, s.downloadUrl, btn);
      });
      grid.appendChild(card);
    }
  }

  private render(): void {
    this.el.innerHTML = `
      <div class="skins-head">
        <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;">
          <h1 class="skins-title" style="margin:0;">Менеджер скинов</h1>
          <span style="display:inline-flex;align-items:center;padding:4px 10px;border-radius:999px;font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#e0aaff;background:rgba(157,78,221,0.18);border:1px solid rgba(199,125,255,0.4);">В РАЗРАБОТКЕ</span>
        </div>
        <div class="skins-toolbar">
          <div class="roulette-source-seg">
            <button type="button" class="roulette-src-btn sk-tab ${this.tab === "local" ? "active" : ""}" data-tab="local">Мои скины</button>
            <button type="button" class="roulette-src-btn sk-tab ${this.tab === "catalog" ? "active" : ""}" data-tab="catalog">Каталог скинов</button>
          </div>
          <input type="text" class="skins-search" placeholder="Поиск скина или автора…" />
        </div>
      </div>
      <div class="skins-grid"></div>
    `;

    this.el.querySelectorAll<HTMLButtonElement>(".sk-tab").forEach((btn) => {
      btn.addEventListener("click", () => {
        this.tab = btn.dataset.tab === "local" ? "local" : "catalog";
        this.el.querySelectorAll(".sk-tab").forEach((b) => b.classList.toggle("active", b === btn));
        if (this.tab === "local") void this.refreshLocal();
        this.renderGrid();
      });
    });

    this.el.querySelector<HTMLInputElement>(".skins-search")?.addEventListener("input", (e) => {
      this.query = (e.currentTarget as HTMLInputElement).value;
      this.renderGrid();
    });

    this.renderGrid();
  }
}
