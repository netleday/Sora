/* skins.ts — Sora Skins Catalog (16:9 Cards, In-Card Screenshot Arrows & Fullscreen Gallery) */
import { invoke } from "@tauri-apps/api/core";
import { asApiError } from "../lib/api";
import { esc } from "../lib/format";
import { store } from "../lib/store";
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
  private query = "";
  private catalog: CatalogSkinEntry[] = [];
  private loadingCatalog = false;

  constructor() {
    this.el = document.createElement("div");
    this.el.className = "skins-page";
    this.render();
    void this.loadOnlineCatalog();
  }

  shown(): void {
    if (this.catalog.length === 0 && !this.loadingCatalog) void this.loadOnlineCatalog();
  }

  destroy(): void {
    this.el.remove();
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
      this.renderGrid();
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

  private renderGrid(): void {
    const grid = this.el.querySelector<HTMLElement>(".skins-grid");
    if (!grid) return;

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
      card.style.display = "none";
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
        <h1 class="skins-title">Каталог скинов</h1>
        <div class="skins-toolbar">
          <input type="text" class="skins-search" placeholder="Поиск скина или автора…" />
        </div>
      </div>
      <div class="skins-grid"></div>
    `;

    this.el.querySelector<HTMLInputElement>(".skins-search")?.addEventListener("input", (e) => {
      this.query = (e.currentTarget as HTMLInputElement).value;
      this.renderGrid();
    });

    this.renderGrid();
  }
}
