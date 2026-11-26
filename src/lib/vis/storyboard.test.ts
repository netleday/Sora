import { describe, expect, it } from "vitest";
import { ease, framePath, parseStoryboard, spriteAt, valueAt } from "./storyboard";

const osu = (events: string, general = "") => `osu file format v14\n\n[General]\nAudioFilename: a.mp3\n${general}\n[Events]\n${events}\n[TimingPoints]\n0,500,4,2,0,100,1,0\n`;

describe("storyboard", () => {
  it("reads sprites with their commands", () => {
    const sb = parseStoryboard(osu(`0,0,"bg.jpg",0,0\nSprite,Foreground,Centre,"SB\\Star.png",320,240\n F,0,1000,2000,0,1\n M,0,1000,2000,0,0,640,480`), null);
    expect(sb.sprites).toHaveLength(1);
    const sp = sb.sprites[0];
    expect(sp.path).toBe("sb/star.png");
    expect([sp.ox, sp.oy]).toEqual([0.5, 0.5]);
    expect([sp.start, sp.end]).toEqual([1000, 2000]);
    expect(spriteAt(sp, 999)).toBeNull();
    const mid = spriteAt(sp, 1500)!;
    expect(mid.alpha).toBeCloseTo(0.5);
    expect([mid.x, mid.y]).toEqual([320, 240]);
    expect(spriteAt(sp, 2001)).toBeNull();
    expect(sb.replacesBackground).toBe(false);
    expect(sb.widescreen).toBe(false);
  });

  it("holds values before, between and after commands", () => {
    const sb = parseStoryboard(osu(`Sprite,Background,TopLeft,"a.png",10,20\n S,0,0,100,2,3\n S,0,500,600,5,6\n MX,0,0,,50`), null);
    const sc = sb.sprites[0].ch.sc;
    expect(valueAt(sc, -100, 1)).toBe(2);
    expect(valueAt(sc, 300, 1)).toBe(3);
    expect(valueAt(sc, 550, 1)).toBeCloseTo(5.5);
    expect(valueAt(sc, 9999, 1)).toBe(6);
    const st = spriteAt(sb.sprites[0], 50)!;
    // MX with no end time and one value: there from its start
    expect(st.x).toBe(50);
    expect(st.y).toBe(20);
  });

  it("plays shorthand commands one after another", () => {
    const sb = parseStoryboard(osu(`Sprite,Pass,Centre,"a.png",0,0\n F,0,0,100,0,1,0.5`), null);
    const f = sb.sprites[0].ch.f!;
    expect(f.map((g) => [g.s, g.t, g.a, g.b])).toEqual([
      [0, 100, 0, 1],
      [100, 200, 1, 0.5],
    ]);
  });

  it("repeats loops as long as their commands last together", () => {
    const sb = parseStoryboard(osu(`Sprite,Foreground,Centre,"a.png",0,0\n L,1000,3\n  F,0,100,200,0,1\n  F,0,200,300,1,0`), null);
    const sp = sb.sprites[0];
    expect(sp.ch.f!.map((g) => g.s)).toEqual([1100, 1200, 1300, 1400, 1500, 1600]);
    expect([sp.start, sp.end]).toEqual([1100, 1700]);
  });

  it("leaves triggers out and the sprites only they move", () => {
    const sb = parseStoryboard(osu(`Sprite,Foreground,Centre,"a.png",0,0\n T,HitSoundClap,0,1000\n  F,0,0,100,1,0`), null);
    expect(sb.sprites).toHaveLength(0);
  });

  it("reads the .osb first with its variables, the difficulty's sprites over it", () => {
    const osb = `[Variables]\n$fadeIn=F,0,0,500,0,1\n[Events]\nSprite,Background,Centre,"bg.jpg",320,240\n $fadeIn\nSprite,Overlay,Centre,"top.png",320,240\n $fadeIn`;
    const sb = parseStoryboard(osu(`0,0,"BG.jpg",0,0\nSprite,Background,Centre,"diff.png",320,240\n $fadeIn`, "WidescreenStoryboard: 1"), osb);
    expect(sb.sprites.map((s) => s.path)).toEqual(["bg.jpg", "diff.png", "top.png"]);
    expect(sb.sprites[0].ch.f![0].b).toBe(1);
    expect(sb.replacesBackground).toBe(true);
    expect(sb.widescreen).toBe(true);
  });

  it("counts the background as replaced by a sprite without commands too", () => {
    const sb = parseStoryboard(osu(`0,0,"bg.jpg",0,0`), `[Events]\nVideo,0,"video.mp4"\nSprite,Background,Centre,"bg.jpg",320,240\nSprite,Foreground,Centre,"a.png",0,0\n F,0,0,100,1`);
    expect(sb.sprites).toHaveLength(1);
    expect(sb.replacesBackground).toBe(true);
  });

  it("colours, flips and additive", () => {
    const sb = parseStoryboard(osu(`Sprite,Foreground,Centre,"a.png",0,0\n C,0,0,100,255,0,0,0,0,255\n P,0,50,,A\n P,0,0,100,H`), null);
    const sp = sb.sprites[0];
    const a = spriteAt(sp, 0)!;
    expect([a.r, a.g, a.b]).toEqual([1, 0, 0]);
    expect(a.flipH).toBe(true);
    expect(a.add).toBe(false);
    const b = spriteAt(sp, 100)!;
    expect([b.r, b.g, b.b]).toEqual([0, 0, 1]);
    expect(b.add).toBe(true);
    expect(b.flipH).toBe(false);
  });

  it("animates frames, over and over or once", () => {
    const sb = parseStoryboard(osu(`Animation,Foreground,Centre,"sb/run.png",0,0,4,100,LoopForever\n F,0,0,1000,1\nAnimation,Foreground,Centre,"sb/once.png",0,0,3,100,LoopOnce\n F,0,0,1000,1`), null);
    expect(spriteAt(sb.sprites[0], 250)!.path).toBe("sb/run2.png");
    expect(spriteAt(sb.sprites[0], 450)!.path).toBe("sb/run0.png");
    expect(spriteAt(sb.sprites[1], 900)!.path).toBe("sb/once2.png");
    expect(framePath("a/b.c/x", 3)).toBe("a/b.c/x3");
  });

  it("starts at the first fade from nothing", () => {
    const sb = parseStoryboard(osu(`Sprite,Foreground,Centre,"a.png",0,0\n M,0,0,5000,0,0,100,100\n F,0,2000,2500,0,1`), null);
    expect(sb.sprites[0].start).toBe(2000);
  });

  it("eases from 0 to 1", () => {
    for (let e = 0; e <= 34; e++) {
      expect(ease(e, 0), `easing ${e} at 0`).toBeCloseTo(0, 2);
      expect(ease(e, 1), `easing ${e} at 1`).toBeCloseTo(1, 2);
    }
    expect(ease(1, 0.5)).toBeCloseTo(0.75);
    expect(ease(2, 0.5)).toBeCloseTo(0.25);
  });
});
