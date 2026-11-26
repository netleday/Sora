/* roulette.ts — Sora Map Roulette (Local client.realm + Online mirrors + Filter Modal) */
import { api, asApiError, thumbUrl } from "../lib/api";
import { playWinSfx } from "../lib/anime-sfx";
import { esc, fixed } from "../lib/format";
import { t } from "../lib/i18n";
import { go } from "../lib/router";
import { store } from "../lib/store";
import type { FoundSet, MapRow, SetRow } from "../lib/types";
import { player } from "../player";
import { toast } from "../ui/controls";
import { icon } from "../ui/icons";
import { importSets } from "./import";

interface RouletteCard {
  source: "local" | "online";
  setId: string;
  onlineSetId?: number;
  mapId?: string;
  title: string;
  artist: string;
  creator: string;
  version: string;
  sr: number;
  bpm: number;
  lengthSec: number;
  ar: number;
  od: number;
  cs: number;
  hp: number;
  status: number;
  coverUrl: string;
  setRow?: SetRow;
  mapRow?: MapRow;
}

interface RouletteFilters {
  source: "local" | "online";
  srMin: number;
  srMax: number;
  bpmMin: number;
  bpmMax: number;
  lenMin: number;
  lenMax: number;
  status: string;
  playstyle: string;
  favoritesOnly: boolean;
}

const STATUS_NAMES: Record<number, string> = {
  [-2]: "Graveyard",
  [-1]: "WIP",
  0: "Pending",
  1: "Ranked",
  2: "Approved",
  3: "Qualified",
  4: "Loved",
};

const PLAYSTYLE_TAGS: Record<string, string[]> = {
  any: [],
  jump: ["jump", "aim", "tv size", "sotarks", "browiec", "reform"],
  stream: ["stream", "speed", "stamina", "burst", "deathstream"],
  tech: ["tech", "slider", "reading", "gimmick", "complex"],
  alt: ["alt", "alternating", "finger"],
  farm: ["tv size", "farm", "pp", "short"],
};

const FALLBACK_SVG =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="220" viewBox="0 0 400 220"><rect width="400" height="220" fill="#181824"/><circle cx="200" cy="110" r="36" fill="none" stroke="rgba(255,102,171,0.5)" stroke-width="5"/></svg>'
  );

function playTick(): void {
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "triangle";
    osc.frequency.value = 640;
    gain.gain.value = 0.04;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.03);
    setTimeout(() => void ctx.close(), 80);
  } catch {}
}

export class RouletteView {
  readonly el: HTMLElement;
  private filters: RouletteFilters = {
    source: "local",
    srMin: 3.5,
    srMax: 6.0,
    bpmMin: 0,
    bpmMax: 400,
    lenMin: 0,
    lenMax: 900,
    status: "any",
    playstyle: "any",
    favoritesOnly: false,
  };
  private spinning = false;
  private winner: RouletteCard | null = null;
  private modalOpen = false;

  private onlinePreviewAudio: HTMLAudioElement | null = null;

  constructor() {
    this.el = document.createElement("div");
    this.el.className = "roulette-page";
    this.render();
    this.populateInitialReel();
  }

  shown(): void {
    this.updatePoolHint();
    const track = this.el.querySelector<HTMLElement>(".roulette-reel-track");
    if (track && track.children.length <= 1) {
      this.populateInitialReel();
    }
  }

  destroy(): void {
    this.onlinePreviewAudio?.pause();
    this.onlinePreviewAudio = null;
    this.el.remove();
  }

  private populateInitialReel(): void {
    const track = this.el.querySelector<HTMLElement>(".roulette-reel-track");
    if (!track) return;
    let pool = this.localPool();
    if (pool.length === 0 && store.snap) {
      // fallback to any osu!standard maps in library so the reel is never empty on open
      for (const m of store.snap.maps) {
        if (m.mode !== 0 || m.hidden) continue;
        const set = store.snap.sets[m.set];
        if (!set) continue;
        const cover = m.bg || set.bg ? thumbUrl(m.bg || set.bg!, 400) : set.onlineId ? `https://assets.ppy.sh/beatmaps/${set.onlineId}/covers/card.jpg` : FALLBACK_SVG;
        pool.push({
          source: "local",
          setId: set.id,
          onlineSetId: set.onlineId,
          mapId: m.id,
          title: set.title,
          artist: set.artist,
          creator: set.creator,
          version: m.version,
          sr: m.sr,
          bpm: m.bpm,
          lengthSec: Math.round((m.length || 0) / 1000),
          ar: m.ar,
          od: m.od,
          cs: m.cs,
          hp: 6,
          status: m.status,
          coverUrl: cover,
          setRow: set,
          mapRow: m,
        });
        if (pool.length >= 40) break;
      }
    }
    if (pool.length === 0) {
      // Demo visual slots when no local maps are loaded yet
      const placeholders = [
        { title: "Idol (TV Size)", sr: 5.12, version: "Insane", id: 1986320 },
        { title: "Hitorigoto", sr: 4.84, version: "Extra", id: 604480 },
        { title: "Supernova", sr: 5.45, version: "Expert", id: 1859401 },
        { title: "Kira Kira Days", sr: 5.86, version: "Shiawase!", id: 257793 },
        { title: "Everything will freeze", sr: 6.18, version: "Time Freeze", id: 158023 },
      ];
      pool = placeholders.map((p) => ({
        source: "online" as const,
        setId: String(p.id),
        onlineSetId: p.id,
        title: p.title,
        artist: "osu!standard",
        creator: "Sora",
        version: p.version,
        sr: p.sr,
        bpm: 180,
        lengthSec: 120,
        ar: 9.2,
        od: 8.5,
        cs: 4,
        hp: 6,
        status: 1,
        coverUrl: `https://assets.ppy.sh/beatmaps/${p.id}/covers/card.jpg`,
      }));
    }
    const slots: RouletteCard[] = [];
    for (let i = 0; i < 28; i++) {
      slots.push(pool[Math.floor(Math.random() * pool.length)]);
    }
    track.style.transition = "none";
    track.style.transform = "translateX(0px)";
    track.innerHTML = slots
      .map(
        (s, idx) => `
      <div class="roulette-slot" data-idx="${idx}">
        <img src="${esc(s.coverUrl)}" alt="" onerror="this.src='${FALLBACK_SVG}'" />
        <div class="roulette-slot-info">
          <div class="roulette-slot-title">${esc(s.title)}</div>
          <div class="roulette-slot-sr">${fixed(s.sr, 2)}★ • ${esc(s.version)}</div>
        </div>
      </div>`
      )
      .join("");
  }

  private localPool(): RouletteCard[] {
    const snap = store.snap;
    if (!snap) return [];
    const out: RouletteCard[] = [];
    const f = this.filters;
    const tagsNeed = PLAYSTYLE_TAGS[f.playstyle] ?? [];
    for (const m of snap.maps) {
      if (m.mode !== 0 || m.hidden) continue;
      if (m.sr < f.srMin || m.sr > f.srMax) continue;
      if (m.bpm < f.bpmMin || m.bpm > f.bpmMax) continue;
      const lenSec = Math.round((m.length || 0) / 1000);
      if (lenSec < f.lenMin || lenSec > f.lenMax) continue;
      if (f.status !== "any" && String(m.status) !== f.status) continue;
      if (f.favoritesOnly && (!m.best || m.best.rank < 3)) continue;
      const set = snap.sets[m.set];
      if (!set) continue;
      if (tagsNeed.length > 0) {
        const hay = `${set.title} ${set.artist} ${set.creator} ${set.tags ?? ""} ${m.version}`.toLowerCase();
        if (!tagsNeed.some((tg) => hay.includes(tg))) continue;
      }
      const cover = m.bg || set.bg ? thumbUrl(m.bg || set.bg!, 400) : set.onlineId ? `https://assets.ppy.sh/beatmaps/${set.onlineId}/covers/card.jpg` : FALLBACK_SVG;
      out.push({
        source: "local",
        setId: set.id,
        onlineSetId: set.onlineId,
        mapId: m.id,
        title: set.title,
        artist: set.artist,
        creator: set.creator,
        version: m.version,
        sr: m.sr,
        bpm: m.bpm,
        lengthSec: lenSec,
        ar: m.ar,
        od: m.od,
        cs: m.cs,
        hp: m.hp,
        status: m.status,
        coverUrl: cover,
        setRow: set,
        mapRow: m,
      });
    }
    return out;
  }

  private async fetchOnlinePool(): Promise<RouletteCard[]> {
    const f = this.filters;
    const statusArr = f.status === "any" ? [1, 2, 4] : [parseInt(f.status, 10)];
    const queryText = f.playstyle === "any" ? "" : (PLAYSTYLE_TAGS[f.playstyle]?.[0] ?? "");
    const tryPages = [Math.floor(Math.random() * 3), 0];
    let sets: FoundSet[] = [];
    for (const page of tryPages) {
      const res = await api.searchMirrors({
        text: queryText,
        mode: 0,
        keys: [],
        srMin: f.srMin,
        srMax: f.srMax,
        status: statusArr,
        sort: "plays",
        page,
      });
      if (res.sets && res.sets.length > 0) {
        sets = res.sets;
        break;
      }
    }
    if (sets.length === 0) {
      const res = await api.searchMirrors({
        text: "",
        mode: 0,
        keys: [],
        srMin: f.srMin,
        srMax: f.srMax,
        status: [],
        sort: "plays",
        page: 0,
      });
      sets = res.sets || [];
    }

    const seen = new Set<number>();
    const cards: RouletteCard[] = [];
    for (const s of sets) {
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      const diffs = (s.maps || []).filter((d) => d.mode === 0 && d.sr >= f.srMin && d.sr <= f.srMax);
      const chosen = diffs[Math.floor(Math.random() * diffs.length)] || (s.maps || []).find((d) => d.mode === 0) || s.maps?.[0];
      if (!chosen) continue;
      if (chosen.bpm < f.bpmMin || chosen.bpm > f.bpmMax) continue;
      if (chosen.length < f.lenMin || chosen.length > f.lenMax) continue;
      cards.push({
        source: "online",
        setId: String(s.id),
        onlineSetId: s.id,
        title: s.title,
        artist: s.artist,
        creator: s.creator,
        version: chosen.version,
        sr: chosen.sr,
        bpm: chosen.bpm,
        lengthSec: chosen.length,
        ar: chosen.ar,
        od: chosen.od,
        cs: chosen.cs,
        hp: 6,
        status: s.status,
        coverUrl: `https://assets.ppy.sh/beatmaps/${s.id}/covers/card.jpg`,
      });
    }
    // Fisher-Yates shuffle
    for (let i = cards.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [cards[i], cards[j]] = [cards[j], cards[i]];
    }
    return cards;
  }

  private async spin(): Promise<void> {
    if (this.spinning) return;
    this.spinning = true;
    const spinBtn = this.el.querySelector<HTMLButtonElement>(".r-spin-btn");
    if (spinBtn) {
      spinBtn.disabled = true;
      spinBtn.textContent = "Крутится…";
    }

    try {
      const pool = this.filters.source === "online" ? await this.fetchOnlinePool() : this.localPool();
      if (pool.length === 0) {
        toast("Подходящих карт не найдено — расширьте фильтры", { kind: "danger" });
        return;
      }

      const win = pool[Math.floor(Math.random() * pool.length)];
      const slots: RouletteCard[] = [];
      const totalSlots = 36;
      const winIndex = 28;
      for (let i = 0; i < totalSlots; i++) {
        slots.push(i === winIndex ? win : pool[Math.floor(Math.random() * pool.length)]);
      }

      const track = this.el.querySelector<HTMLElement>(".roulette-reel-track");
      const box = this.el.querySelector<HTMLElement>(".roulette-reel-box");
      if (track && box) {
        track.style.transition = "none";
        track.style.transform = "translateX(0px)";
        track.innerHTML = slots
          .map(
            (s, idx) => `
          <div class="roulette-slot" data-idx="${idx}">
            <img src="${esc(s.coverUrl)}" alt="" onerror="this.src='${FALLBACK_SVG}'" />
            <div class="roulette-slot-info">
              <div class="roulette-slot-title">${esc(s.title)}</div>
              <div class="roulette-slot-sr">${fixed(s.sr, 2)}★ • ${esc(s.version)}</div>
            </div>
          </div>`
          )
          .join("");

        void track.offsetWidth;
        const slotWidth = 208;
        const centerOffset = box.clientWidth / 2 - 98;
        const jitter = (Math.random() - 0.5) * 60;
        const targetX = -(winIndex * slotWidth - centerOffset + jitter);

        track.style.transition = "transform 4.2s cubic-bezier(0.12, 0.85, 0.18, 1)";
        track.style.transform = `translateX(${targetX}px)`;

        const ticks = [140, 260, 420, 620, 900, 1300, 1850, 2500, 3250];
        ticks.forEach((ms) => setTimeout(playTick, ms));

        await new Promise((r) => setTimeout(r, 4350));
        track.querySelector(`[data-idx="${winIndex}"]`)?.classList.add("winner");
        playWinSfx();
      }

      this.winner = win;
      this.renderResult();
    } catch (e) {
      toast(asApiError(e).message, { kind: "danger" });
    } finally {
      this.spinning = false;
      if (spinBtn) {
        spinBtn.disabled = false;
        spinBtn.textContent = "Крутить рулетку";
      }
    }
  }

  private updatePoolHint(): void {
    const sub = this.el.querySelector<HTMLElement>(".roulette-sub");
    if (!sub) return;
    if (this.filters.source === "online") {
      sub.textContent = `Онлайн-режим (зеркала Mino/Nerinyan) • ${this.filters.srMin}–${this.filters.srMax}★`;
    } else {
      const cnt = this.localPool().length;
      sub.textContent = `Локальная база osu!standard: найдено ${cnt} карт под фильтры`;
    }
  }

  private renderResult(): void {
    const host = this.el.querySelector<HTMLElement>(".roulette-result-host");
    if (!host) return;
    const w = this.winner;
    if (!w) {
      host.innerHTML = "";
      return;
    }
    const mins = Math.floor(w.lengthSec / 60);
    const secs = String(w.lengthSec % 60).padStart(2, "0");
    host.innerHTML = `
      <div class="roulette-result-card">
        <img class="roulette-result-cover" src="${esc(w.coverUrl)}" alt="" onerror="this.src='${FALLBACK_SVG}'" />
        <div class="roulette-result-body">
          <div>
            <h2 class="roulette-result-title">${esc(w.title)}</h2>
            <div class="roulette-result-meta">${esc(w.artist)} • [${esc(w.version)}] • Маппер: ${esc(w.creator)}</div>
          </div>
          <div class="roulette-pills">
            <span class="roulette-pill">${fixed(w.sr, 2)}★</span>
            <span class="roulette-pill">${Math.round(w.bpm)} BPM</span>
            <span class="roulette-pill">${mins}:${secs}</span>
            <span class="roulette-pill">AR ${fixed(w.ar, 1)}</span>
            <span class="roulette-pill">OD ${fixed(w.od, 1)}</span>
            <span class="roulette-pill">CS ${fixed(w.cs, 1)}</span>
            <span class="roulette-pill">${STATUS_NAMES[w.status] ?? "Unknown"}</span>
          </div>
          <div class="roulette-result-actions">
            <button type="button" class="btn btn-primary r-play-osu">${w.source === "local" ? t("Play in osu!") : t("Download and play")}</button>
            <button type="button" class="btn r-preview">${icon("play")} ${t("Preview")}</button>
            ${w.setRow ? `<button type="button" class="btn r-open-set">${t("Open the set")}</button>` : ""}
          </div>
        </div>
      </div>`;

    host.querySelector(".r-play-osu")?.addEventListener("click", async () => {
      if (w.source === "local" && w.setRow && w.mapRow) {
        try {
          const client = store.prefs.launchClient === "stable" ? "stable" : "lazer";
          await api.launchOsu(client);
          toast(`Запуск карты в ${client}...`);
        } catch (e) {
          toast(asApiError(e).message, { kind: "danger" });
        }
      } else if (w.onlineSetId) {
        try {
          importSets([{ id: w.onlineSetId, title: w.title }]);
          toast("Сет добавлен в очередь загрузки и импорта!");
        } catch (e) {
          toast(asApiError(e).message, { kind: "danger" });
        }
      }
    });

    host.querySelector(".r-preview")?.addEventListener("click", () => {
      if (w.mapRow && store.snap) {
        const mi = store.snap.maps.indexOf(w.mapRow);
        player.playSet(w.mapRow.set, mi >= 0 ? mi : undefined);
      } else if (w.onlineSetId) {
        this.onlinePreviewAudio?.pause();
        this.onlinePreviewAudio = new Audio(`https://b.ppy.sh/preview/${w.onlineSetId}.mp3`);
        this.onlinePreviewAudio.volume = store.prefs.volume ?? 0.6;
        void this.onlinePreviewAudio.play().catch(() => toast("Не удалось загрузить аудио-превью", { kind: "danger" }));
      }
    });

    host.querySelector(".r-open-set")?.addEventListener("click", () => {
      if (w.setRow) go({ name: "set", id: w.setRow.id, map: w.mapRow?.id });
    });
  }

  private renderFilterModal(): void {
    document.querySelector(".roulette-filter-modal")?.remove();
    if (!this.modalOpen) return;
    const f = this.filters;
    const back = document.createElement("div");
    back.className = "sora-modal-backdrop roulette-filter-modal";
    back.innerHTML = `
      <div class="sora-modal">
        <div class="sora-modal-head">
          <h3 class="sora-modal-title">Фильтры рулетки</h3>
          <button type="button" class="icon-btn r-modal-close">${icon("x")}</button>
        </div>
        <div class="sora-form-grid">
          <div class="sora-field">
            <label>Star Rating от</label>
            <input type="number" step="0.1" min="0" max="15" id="rf-sr-min" value="${f.srMin}" />
          </div>
          <div class="sora-field">
            <label>Star Rating до</label>
            <input type="number" step="0.1" min="0" max="15" id="rf-sr-max" value="${f.srMax}" />
          </div>
          <div class="sora-field">
            <label>BPM от</label>
            <input type="number" min="0" max="500" id="rf-bpm-min" value="${f.bpmMin}" />
          </div>
          <div class="sora-field">
            <label>BPM до</label>
            <input type="number" min="0" max="500" id="rf-bpm-max" value="${f.bpmMax}" />
          </div>
          <div class="sora-field">
            <label>Длина от (сек)</label>
            <input type="number" min="0" max="3600" id="rf-len-min" value="${f.lenMin}" />
          </div>
          <div class="sora-field">
            <label>Длина до (сек)</label>
            <input type="number" min="0" max="3600" id="rf-len-max" value="${f.lenMax}" />
          </div>
          <div class="sora-field">
            <label>Статус карты</label>
            <select id="rf-status">
              <option value="any" ${f.status === "any" ? "selected" : ""}>Любой</option>
              <option value="1" ${f.status === "1" ? "selected" : ""}>Ranked</option>
              <option value="4" ${f.status === "4" ? "selected" : ""}>Loved</option>
              <option value="3" ${f.status === "3" ? "selected" : ""}>Qualified</option>
              <option value="0" ${f.status === "0" ? "selected" : ""}>Pending</option>
              <option value="-2" ${f.status === "-2" ? "selected" : ""}>Graveyard</option>
            </select>
          </div>
          <div class="sora-field">
            <label>Плейстайл</label>
            <select id="rf-style">
              <option value="any" ${f.playstyle === "any" ? "selected" : ""}>Любой</option>
              <option value="jump" ${f.playstyle === "jump" ? "selected" : ""}>Jump / Aim</option>
              <option value="stream" ${f.playstyle === "stream" ? "selected" : ""}>Stream / Speed</option>
              <option value="tech" ${f.playstyle === "tech" ? "selected" : ""}>Tech / Reading</option>
              <option value="alt" ${f.playstyle === "alt" ? "selected" : ""}>Alternating</option>
              <option value="farm" ${f.playstyle === "farm" ? "selected" : ""}>Farm / TV Size</option>
            </select>
          </div>
        </div>
        <label style="display:flex;align-items:center;gap:8px;font-size:13px;color:var(--text);">
          <input type="checkbox" id="rf-fav" ${f.favoritesOnly ? "checked" : ""} />
          <span>Только карты с хорошими скорами / избранные (★)</span>
        </label>
        <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:6px;">
          <button type="button" class="btn r-modal-apply btn-primary">Применить</button>
        </div>
      </div>`;

    back.addEventListener("click", (e) => {
      if (e.target === back || (e.target as HTMLElement).closest(".r-modal-close")) {
        this.modalOpen = false;
        back.remove();
      }
    });

    back.querySelector(".r-modal-apply")?.addEventListener("click", () => {
      this.filters.srMin = parseFloat(back.querySelector<HTMLInputElement>("#rf-sr-min")!.value) || 0;
      this.filters.srMax = parseFloat(back.querySelector<HTMLInputElement>("#rf-sr-max")!.value) || 15;
      this.filters.bpmMin = parseInt(back.querySelector<HTMLInputElement>("#rf-bpm-min")!.value, 10) || 0;
      this.filters.bpmMax = parseInt(back.querySelector<HTMLInputElement>("#rf-bpm-max")!.value, 10) || 500;
      this.filters.lenMin = parseInt(back.querySelector<HTMLInputElement>("#rf-len-min")!.value, 10) || 0;
      this.filters.lenMax = parseInt(back.querySelector<HTMLInputElement>("#rf-len-max")!.value, 10) || 3600;
      this.filters.status = back.querySelector<HTMLSelectElement>("#rf-status")!.value;
      this.filters.playstyle = back.querySelector<HTMLSelectElement>("#rf-style")!.value;
      this.filters.favoritesOnly = back.querySelector<HTMLInputElement>("#rf-fav")!.checked;
      this.modalOpen = false;
      back.remove();
      this.updatePoolHint();
    });

    document.body.appendChild(back);
  }

  private render(): void {
    this.el.innerHTML = `
      <div class="roulette-head">
        <div class="roulette-head-left">
          <h1 class="roulette-title">Рулетка карт (osu!standard)</h1>
          <div class="roulette-sub">Загрузка пула…</div>
        </div>
        <div class="roulette-controls">
          <div class="roulette-source-seg">
            <button type="button" class="roulette-src-btn ${this.filters.source === "local" ? "active" : ""}" data-src="local">Локально</button>
            <button type="button" class="roulette-src-btn ${this.filters.source === "online" ? "active" : ""}" data-src="online">Онлайн</button>
          </div>
          <button type="button" class="btn r-filters-btn">${icon("sliders")} Фильтры</button>
          <button type="button" class="btn btn-primary r-spin-btn">${icon("shuffle")} Крутить рулетку</button>
        </div>
      </div>
      <div class="roulette-reel-box">
        <div class="roulette-reel-pointer"></div>
        <div class="roulette-reel-track">
          <div style="padding:0 24px;color:var(--text-dim);font-size:14px;">Нажмите «Крутить рулетку», чтобы выбрать случайную карту…</div>
        </div>
      </div>
      <div class="roulette-result-host"></div>
    `;

    this.el.querySelectorAll<HTMLButtonElement>(".roulette-src-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        this.filters.source = btn.dataset.src === "online" ? "online" : "local";
        this.el.querySelectorAll(".roulette-src-btn").forEach((b) => b.classList.toggle("active", b === btn));
        this.updatePoolHint();
      });
    });

    this.el.querySelector(".r-filters-btn")?.addEventListener("click", () => {
      this.modalOpen = true;
      this.renderFilterModal();
    });

    this.el.querySelector(".r-spin-btn")?.addEventListener("click", () => {
      void this.spin();
    });

    this.updatePoolHint();
  }
}
