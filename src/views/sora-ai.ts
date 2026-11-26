/* sora-ai.ts — Hybrid Sora AI Assistant (built-in smart mode + optional OpenAI-compatible LLM) */
import { api } from "../lib/api";
import { esc, fixed } from "../lib/format";
import { go } from "../lib/router";
import { store } from "../lib/store";
import { player } from "../player";
import { icon } from "../ui/icons";

interface ChatMsg {
  role: "user" | "assistant";
  html: string;
  actions?: { label: string; run: () => void }[];
}

export class SoraAiView {
  readonly el: HTMLElement;
  private msgs: ChatMsg[] = [
    {
      role: "assistant",
      html: "Привет, Сенпай! Я <strong>Sora AI</strong>. Могу подобрать карты из твоей библиотеки или онлайна (например, <em>«найди джамп-карту на 4.5 звезды с высоким BPM»</em>), посоветовать разминку, проверить место на диске или помочь с функциями лаунчера.",
      actions: [
        { label: "Открыть Рулетку", run: () => go({ name: "roulette" }) },
        { label: "Каталог скинов", run: () => go({ name: "skins" }) },
      ],
    },
  ];
  private busy = false;

  constructor() {
    this.el = document.createElement("div");
    this.el.className = "ai-page";
    this.render();
  }

  shown(): void {}

  destroy(): void {
    this.el.remove();
  }

  private async askLlm(prompt: string): Promise<string | null> {
    const key = store.prefs.aiApiKey?.trim();
    if (!key) return null;
    const base = (store.prefs.aiApiUrl?.trim() || "https://api.openai.com/v1").replace(/\/+$/, "");
    const model = store.prefs.aiModel?.trim() || "gpt-4o-mini";
    const stats = store.snap
      ? `У игрока в библиотеке ${store.snap.sets.length} сетов и ${store.snap.maps.length} сложностей.`
      : "Локальная библиотека пока не загружена.";
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "system",
            content: `Ты Sora AI — дружелюбный аниме-помощник для osu!standard внутри лаунчера Sora (by netleday). Отвечай кратко, по делу и на языке пользователя. Контекст: ${stats}`,
          },
          { role: "user", content: prompt },
        ],
      }),
    });
    if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return data.choices?.[0]?.message?.content?.trim() || null;
  }

  private async handleBuiltIn(q: string): Promise<ChatMsg> {
    const low = q.toLowerCase();
    const snap = store.snap;

    // 1. Video / disk care query
    if (low.includes("видео") || low.includes("место") || low.includes("диск") || low.includes("очист") || low.includes("video")) {
      return {
        role: "assistant",
        html: "Чтобы освободить место на диске от фоновых видео, дубликатов и неигранных карт, открой раздел <strong>Здоровье базы</strong> — там всё сразу отсортировано по размеру.",
        actions: [{ label: "Открыть Здоровье базы", run: () => go({ name: "care" }) }],
      };
    }

    // 2. Unplayed / forgotten maps
    if (low.includes("давно") || low.includes("не играл") || low.includes("забыл") || low.includes("unplayed")) {
      const unplayed = (snap?.maps ?? []).filter((m) => m.mode === 0 && !m.played && !m.hidden);
      const picks = unplayed.slice(0, 4);
      if (picks.length > 0 && snap) {
        const lines = picks
          .map((m) => `• <strong>${esc(snap.sets[m.set]?.title || "?")}</strong> [${esc(m.version)}] — ${fixed(m.sr, 2)}★`)
          .join("<br>");
        return {
          role: "assistant",
          html: `Нашла <strong>${unplayed.length}</strong> неигранных карт osu!standard. Вот несколько вариантов:<br>${lines}`,
          actions: picks.map((m) => ({
            label: `Слушать: ${snap.sets[m.set]?.title.slice(0, 18) || "карта"}`,
            run: () => player.playSet(m.set, snap.maps.indexOf(m)),
          })),
        };
      }
    }

    // 3. Beatmap search / warmup / jump / stream / star rating
    const starMatch = q.match(/(\d+(?:[.,]\d+)?)\s*(?:★|звезд|стар|sr|star)/i);
    const targetSr = starMatch ? parseFloat(starMatch[1].replace(",", ".")) : low.includes("размин") ? 3.8 : 4.6;
    const highBpm = low.includes("высок") || low.includes("быстр") || low.includes("bpm") || low.includes("speed");
    const wantJump = low.includes("джамп") || low.includes("jump") || low.includes("аим");
    const wantStream = low.includes("стрим") || low.includes("stream");

    if (snap && snap.maps.length > 0) {
      let pool = snap.maps.filter(
        (m) => m.mode === 0 && !m.hidden && m.sr >= Math.max(0.5, targetSr - 0.6) && m.sr <= targetSr + 0.6
      );
      if (highBpm) pool = pool.filter((m) => m.bpm >= 175);
      if (wantJump) {
        const j = pool.filter((m) => `${snap.sets[m.set]?.title} ${snap.sets[m.set]?.tags ?? ""} ${m.version}`.toLowerCase().match(/jump|tv size|aim|reform|sotarks/));
        if (j.length) pool = j;
      }
      if (wantStream) {
        const s = pool.filter((m) => `${snap.sets[m.set]?.title} ${snap.sets[m.set]?.tags ?? ""} ${m.version}`.toLowerCase().match(/stream|burst|speed|stamina/));
        if (s.length) pool = s;
      }
      if (pool.length > 0) {
        const picks = pool.sort(() => Math.random() - 0.5).slice(0, 4);
        const list = picks
          .map((m) => `• <strong>${esc(snap.sets[m.set]?.title || "?")}</strong> [${esc(m.version)}] — ${fixed(m.sr, 2)}★ · ${Math.round(m.bpm)} BPM`)
          .join("<br>");
        return {
          role: "assistant",
          html: `Подобрала из твоей библиотеки около <strong>${fixed(targetSr, 1)}★</strong>:<br>${list}`,
          actions: picks.map((m) => ({
            label: `Открыть: ${snap.sets[m.set]?.title.slice(0, 18) || "сет"}`,
            run: () => go({ name: "set", id: snap.sets[m.set].id, map: m.id }),
          })),
        };
      }
    }

    // 4. Online mirror fallback
    try {
      const online = await api.searchMirrors({
        text: wantJump ? "jump" : wantStream ? "stream" : "",
        mode: 0,
        keys: [],
        srMin: Math.max(1, targetSr - 0.5),
        srMax: targetSr + 0.5,
        status: [1, 4],
        sort: "plays",
        page: 0,
      });
      if (online.sets?.length) {
        const top = online.sets.slice(0, 4);
        const list = top.map((s) => `• <strong>${esc(s.title)}</strong> — ${esc(s.artist)}`).join("<br>");
        return {
          role: "assistant",
          html: `Нашла в онлайне (зеркало ${esc(online.mirror)}) около <strong>${fixed(targetSr, 1)}★</strong>:<br>${list}`,
          actions: [{ label: "Открыть Поиск карт", run: () => go({ name: "browse" }) }],
        };
      }
    } catch {}

    return {
      role: "assistant",
      html: "Можешь спросить про подбор карт (например, <em>«найди джамп-карту на 4.5 звезды»</em>), попросить разминку, проверить неигранные карты или открыть Настройки чтобы подключить свой LLM API-ключ.",
      actions: [
        { label: "Открыть Рулетку", run: () => go({ name: "roulette" }) },
        { label: "Настройки AI", run: () => go({ name: "settings", section: "appearance" }) },
      ],
    };
  }

  private async send(text: string): Promise<void> {
    const q = text.trim();
    if (!q || this.busy) return;
    this.busy = true;
    this.msgs.push({ role: "user", html: esc(q) });
    this.renderMessages();

    try {
      const llm = await this.askLlm(q);
      if (llm) {
        this.msgs.push({ role: "assistant", html: esc(llm).replace(/\n/g, "<br>") });
      } else {
        this.msgs.push(await this.handleBuiltIn(q));
      }
    } catch {
      this.msgs.push(await this.handleBuiltIn(q));
    } finally {
      this.busy = false;
      this.renderMessages();
    }
  }

  private renderMessages(): void {
    const box = this.el.querySelector<HTMLElement>(".ai-messages");
    if (!box) return;
    box.innerHTML = "";
    for (const m of this.msgs) {
      const row = document.createElement("div");
      row.className = `ai-msg ${m.role}`;
      row.innerHTML = `
        ${m.role === "assistant" ? `<img class="ai-avatar" src="/mascot/sora_mascot.png" alt="Sora AI" style="width:34px;height:34px;" />` : ""}
        <div class="ai-bubble">
          <div>${m.html}</div>
          ${m.actions?.length ? `<div class="ai-actions"></div>` : ""}
        </div>`;
      if (m.actions?.length) {
        const actHost = row.querySelector<HTMLElement>(".ai-actions")!;
        for (const a of m.actions) {
          const b = document.createElement("button");
          b.type = "button";
          b.className = "btn btn-sm";
          b.textContent = a.label;
          b.addEventListener("click", a.run);
          actHost.appendChild(b);
        }
      }
      box.appendChild(row);
    }
    box.scrollTop = box.scrollHeight;
  }

  private render(): void {
    const hasLlm = !!store.prefs.aiApiKey?.trim();
    this.el.innerHTML = `
      <div class="ai-head">
        <div class="ai-head-left">
          <img class="ai-avatar" src="/mascot/sora_mascot.png" alt="Sora AI" />
          <div>
            <div style="font-size:16px;font-weight:800;color:#fff;">Sora AI</div>
            <div style="font-size:12px;color:var(--text-dim);">${hasLlm ? `LLM API: ${esc(store.prefs.aiModel || "gpt-4o-mini")}` : "Встроенный умный режим (работает без API-ключей)"}</div>
          </div>
        </div>
        <button type="button" class="btn btn-sm ai-cfg-btn">${icon("settings")} Настройки AI</button>
      </div>
      <div class="ai-chips">
        <button type="button" class="ai-chip">Найди джамп-карту на 4.5 звезды с высоким BPM</button>
        <button type="button" class="ai-chip">Посоветуй разминку</button>
        <button type="button" class="ai-chip">Какие карты я давно не играл?</button>
        <button type="button" class="ai-chip">Сколько места занимают видео?</button>
      </div>
      <div class="ai-messages"></div>
      <form class="ai-input-row">
        <input type="text" placeholder="Спроси Sora AI о картах, тренировке или функциях…" />
        <button type="submit" class="btn btn-primary">Отправить</button>
      </form>
    `;

    this.el.querySelector(".ai-cfg-btn")?.addEventListener("click", () => go({ name: "settings", section: "appearance" }));
    this.el.querySelectorAll<HTMLButtonElement>(".ai-chip").forEach((c) => {
      c.addEventListener("click", () => void this.send(c.textContent || ""));
    });
    const form = this.el.querySelector<HTMLFormElement>(".ai-input-row")!;
    const inp = form.querySelector<HTMLInputElement>("input")!;
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const v = inp.value;
      inp.value = "";
      void this.send(v);
    });

    this.renderMessages();
  }
}
