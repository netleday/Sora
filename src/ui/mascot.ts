/* mascot.ts — Interactive Shimeji Anime Mascot (walks, jumps on UI buttons, sits, sleeps, Drag & Drop) */
import { playMascotSfx } from "../lib/anime-sfx";
import { store } from "../lib/store";

const PHRASES: { text: string; sfx: "nya" | "sugoi" | "start" }[] = [
  { text: "Удачи в скоре, Сенпай!", sfx: "start" },
  { text: "Покрутим рулетку?", sfx: "nya" },
  { text: "Хороший темп!", sfx: "sugoi" },
  { text: "Nya~ Удачного FC!", sfx: "nya" },
  { text: "Sugoi! Красивый сет!", sfx: "sugoi" },
];

type Mode = "active" | "corner" | "hidden";
type State = "idle" | "walk" | "jump" | "sit" | "sleep" | "drag";

let root: HTMLElement | null = null;
let animId = 0;

export function syncMascotVisibility(): void {
  if (!root) return;
  const mode = (store.prefs.mascotMode as Mode) || (store.prefs.showMascot === false ? "hidden" : "active");
  root.hidden = mode === "hidden";
  const size = store.prefs.mascotSize ?? 160;
  root.style.setProperty("--mascot-h", `${size}px`);
}

export function mountMascot(): void {
  if (root) {
    syncMascotVisibility();
    return;
  }

  const el = document.createElement("div");
  el.className = "sora-shimeji";
  el.innerHTML = `
    <div class="shimeji-bubble" hidden></div>
    <div class="shimeji-zzz" hidden>Zzz…</div>
    <div class="shimeji-hearts"></div>
    <div class="shimeji-body">
      <img src="/mascot/sora_mascot.png" alt="Sora-chan" draggable="false" />
    </div>
  `;
  document.body.appendChild(el);
  root = el;
  syncMascotVisibility();

  const body = el.querySelector<HTMLElement>(".shimeji-body")!;
  const img = el.querySelector<HTMLImageElement>("img")!;
  const bubble = el.querySelector<HTMLElement>(".shimeji-bubble")!;
  const zzz = el.querySelector<HTMLElement>(".shimeji-zzz")!;
  const hearts = el.querySelector<HTMLElement>(".shimeji-hearts")!;

  const mascotH = () => store.prefs.mascotSize ?? 160;
  const mascotW = () => Math.max(80, el.offsetWidth || Math.round(mascotH() * 0.72));
  const groundY = () => Math.max(60, window.innerHeight - mascotH() - 10);
  const clampX = (nx: number) => Math.max(8, Math.min(window.innerWidth - mascotW() - 8, nx));
  const clampY = (ny: number) => Math.max(58, Math.min(groundY(), ny));

  let x = clampX(window.innerWidth - mascotW() - 24);
  let y = groundY();
  let vx = 0;
  let vy = 0;
  let facing = -1; // -1 left, 1 right
  let state: State = "idle";
  let stateUntil = Date.now() + 3000;
  let lastMouseMove = Date.now();
  let phraseIdx = 0;
  let bubbleTimer = 0;
  let dragOffX = 0;
  let dragOffY = 0;
  let draggedMoved = false;

  function say(text?: string, sfx?: "nya" | "sugoi" | "start"): void {
    const p = PHRASES[phraseIdx % PHRASES.length];
    phraseIdx++;
    playMascotSfx(sfx ?? p.sfx);
    bubble.textContent = text ?? p.text;
    bubble.hidden = false;
    clearTimeout(bubbleTimer);
    bubbleTimer = window.setTimeout(() => {
      bubble.hidden = true;
    }, 2700);
  }

  function spawnSparks(): void {
    for (let i = 0; i < 5; i++) {
      const sp = document.createElement("span");
      sp.className = "sora-spark";
      sp.style.setProperty("--dx", `${(Math.random() - 0.5) * 68}px`);
      sp.style.setProperty("--delay", `${i * 65}ms`);
      hearts.appendChild(sp);
      setTimeout(() => sp.remove(), 950);
    }
  }

  function pickJumpTarget(): { tx: number; ty: number } | null {
    const candidates = Array.from(
      document.querySelectorAll<HTMLElement>(".sora-nav-pill, .btn-primary, .tile, .skin-card, .roulette-result-card")
    ).filter((n) => {
      const r = n.getBoundingClientRect();
      return r.width > 40 && r.height > 20 && r.top > 70 && r.bottom < window.innerHeight - 90;
    });
    if (candidates.length === 0) return null;
    const target = candidates[Math.floor(Math.random() * candidates.length)];
    const r = target.getBoundingClientRect();
    const h = mascotH();
    return {
      tx: clampX(r.left + r.width * 0.5 - mascotW() * 0.5),
      ty: clampY(r.top - h + 14),
    };
  }

  // Parallax & idle reset
  window.addEventListener("mousemove", (e) => {
    lastMouseMove = Date.now();
    if (state === "sleep") {
      state = "idle";
      zzz.hidden = true;
    }
    const mode = (store.prefs.mascotMode as Mode) || "active";
    if (mode === "corner") {
      const dx = (e.clientX / window.innerWidth - 0.5) * 6;
      const dy = (e.clientY / window.innerHeight - 0.5) * 4;
      body.style.transform = `translate(${dx}px, ${dy}px)`;
    }
  });

  // Drag & Drop + Click
  el.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    state = "drag";
    draggedMoved = false;
    dragOffX = e.clientX - x;
    dragOffY = e.clientY - y;
    zzz.hidden = true;
    el.setPointerCapture(e.pointerId);
  });

  el.addEventListener("pointermove", (e) => {
    if (state !== "drag") return;
    const nx = e.clientX - dragOffX;
    const ny = e.clientY - dragOffY;
    if (Math.abs(nx - x) > 4 || Math.abs(ny - y) > 4) draggedMoved = true;
    x = clampX(nx);
    y = clampY(ny);
  });

  el.addEventListener("pointerup", (e) => {
    if (state !== "drag") return;
    el.releasePointerCapture(e.pointerId);
    if (!draggedMoved) {
      say();
      spawnSparks();
      vy = -8.5;
      state = "jump";
      stateUntil = Date.now() + 900;
    } else {
      vy = 1;
      vx = 0;
      state = "jump";
      stateUntil = Date.now() + 1200;
    }
  });

  let lastTs = performance.now();
  function tick(ts: number): void {
    animId = requestAnimationFrame(tick);
    const dt = Math.min(0.05, (ts - lastTs) / 1000);
    lastTs = ts;

    const mode: Mode = (store.prefs.mascotMode as Mode) || (store.prefs.showMascot === false ? "hidden" : "active");
    if (mode === "hidden") return;

    if (mode === "corner") {
      x = clampX(window.innerWidth - mascotW() - 18);
      y = groundY();
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
      el.dataset.state = "corner";
      img.style.transform = "scaleX(1)";
      return;
    }

    const now = Date.now();
    const gy = groundY();

    if (state === "drag") {
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
      el.dataset.state = "drag";
      return;
    }

    // Check sleep on inactivity (22s)
    if (now - lastMouseMove > 22000 && state !== "sleep" && state !== "jump") {
      state = "sleep";
      zzz.hidden = false;
    }

    if (state === "jump") {
      x += vx * dt * 60;
      y += vy * dt * 60;
      vy += 0.42 * dt * 60; // gravity
      if (x < 8) { x = 8; vx = Math.abs(vx); }
      if (x > window.innerWidth - mascotW() - 8) { x = window.innerWidth - mascotW() - 8; vx = -Math.abs(vx); }
      if (y >= gy) {
        y = gy;
        vy = 0;
        vx = 0;
        state = "idle";
        stateUntil = now + 2200 + Math.random() * 2500;
      }
    } else if (state === "walk") {
      x += vx * dt * 60;
      if (x <= 12) { x = 12; vx = Math.abs(vx); facing = 1; }
      if (x >= window.innerWidth - mascotW() - 12) { x = window.innerWidth - mascotW() - 12; vx = -Math.abs(vx); facing = -1; }
      y = gy;
      if (now >= stateUntil) {
        state = "idle";
        vx = 0;
        stateUntil = now + 2000 + Math.random() * 3000;
      }
    } else if (state === "sit") {
      if (now >= stateUntil) {
        state = "jump";
        vy = -5;
        vx = (Math.random() - 0.5) * 4;
        stateUntil = now + 1500;
      }
    } else if (state === "idle") {
      y = gy;
      if (now >= stateUntil) {
        const r = Math.random();
        if (r < 0.55) {
          state = "walk";
          facing = Math.random() < 0.5 ? -1 : 1;
          vx = facing * (1.2 + Math.random() * 0.9);
          stateUntil = now + 2800 + Math.random() * 3200;
        } else if (r < 0.85) {
          const tgt = pickJumpTarget();
          if (tgt) {
            playMascotSfx("jump");
            x = tgt.tx;
            y = tgt.ty;
            state = "sit";
            stateUntil = now + 4500 + Math.random() * 4000;
          } else {
            stateUntil = now + 2500;
          }
        } else {
          stateUntil = now + 2500;
        }
      }
    }

    x = clampX(x);
    y = clampY(y);
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    el.dataset.state = state;
    img.style.transform = `scaleX(${facing})`;
  }

  animId = requestAnimationFrame(tick);
  void animId;
}
