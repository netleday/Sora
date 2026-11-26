/* anime-sfx.ts — Japanese Anime Voice Pack & osu! UI SFX (with voiceVolume & custom files support) */
import { store } from "./store";

let audioCtx: AudioContext | null = null;

function voiceVol(): number {
  return store.prefs.voiceVolume ?? 0.65;
}

function ctx(): AudioContext | null {
  if (store.prefs.animeSfx === false) return null;
  const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) return null;
  if (!audioCtx) audioCtx = new Ctx();
  if (audioCtx.state === "suspended") void audioCtx.resume();
  return audioCtx;
}

function tone(freq: number, dur: number, type: OscillatorType = "sine", vol = 0.05, delay = 0, slideTo?: number): void {
  const c = ctx();
  if (!c) return;
  const scaled = Math.min(0.2, vol * voiceVol() * 1.4);
  if (scaled <= 0.001) return;
  const now = c.currentTime + delay;
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, now);
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, now + dur);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.linearRampToValueAtTime(scaled, now + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + dur);
  osc.connect(gain);
  gain.connect(c.destination);
  osc.start(now);
  osc.stop(now + dur + 0.02);
}

function tryPlayPack(file: string, fallback: () => void): void {
  if (store.prefs.animeSfx === false) return;
  const a = new Audio(`/sounds/anime/${file}`);
  a.volume = Math.max(0, Math.min(1, voiceVol()));
  a.play().catch(fallback);
}

export function playClickSfx(): void {
  tone(840, 0.04, "triangle", 0.032, 0, 1120);
}

export function playNavSfx(): void {
  tone(560, 0.055, "sine", 0.032, 0, 790);
  tone(880, 0.05, "sine", 0.025, 0.03, 1080);
}

export function playWinSfx(): void {
  tryPlayPack("yatta.ogg", () => {
    tone(523.25, 0.14, "triangle", 0.055, 0);
    tone(659.25, 0.14, "triangle", 0.055, 0.09);
    tone(783.99, 0.16, "triangle", 0.06, 0.18);
    tone(1046.5, 0.34, "sine", 0.065, 0.27);
  });
}

export function playMascotSfx(kind: "nya" | "sugoi" | "start" | "jump"): void {
  const file = kind === "nya" ? "nya.ogg" : kind === "sugoi" ? "sugoi.ogg" : kind === "jump" ? "hop.ogg" : "start.ogg";
  tryPlayPack(file, () => {
    if (kind === "nya") {
      tone(780, 0.09, "sine", 0.05, 0, 1180);
      tone(1020, 0.13, "triangle", 0.045, 0.07, 1360);
    } else if (kind === "sugoi") {
      tone(660, 0.08, "triangle", 0.05, 0);
      tone(880, 0.09, "triangle", 0.05, 0.07);
      tone(1174, 0.18, "sine", 0.055, 0.15);
    } else if (kind === "jump") {
      tone(520, 0.08, "sine", 0.04, 0, 960);
    } else {
      tone(587.33, 0.09, "triangle", 0.05, 0);
      tone(880, 0.16, "sine", 0.055, 0.08, 1046.5);
    }
  });
}
