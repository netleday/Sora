/* storyboard-gl.ts — draws a storyboard (lib/vis/storyboard) at a moment into a canvas of its own,
 * with WebGL: the difficulty's background under it (unless a sprite of the storyboard is that
 * image), the video over that, then the sprites, tinted, additive where they ask for it. The
 * visualizer puts the canvas where the cover goes.
 *
 * The storyboard's space is 480 high with 640 wide in the middle, as osu! has it; a storyboard not
 * made for widescreen is cut to that 4:3. Images load as they're about to be needed (a few seconds
 * ahead) and go again once they haven't been needed for a while and too many are loaded. */
import { FAIL_LAYER, spriteAt, spritePaths, type Storyboard } from "../../lib/vis/storyboard";

const VS = `attribute vec2 p; attribute vec2 uv; attribute vec4 col; uniform vec2 size;
varying vec2 vUv; varying vec4 vCol;
void main() { vUv = uv; vCol = col; gl_Position = vec4(p.x / size.x * 2.0 - 1.0, 1.0 - p.y / size.y * 2.0, 0.0, 1.0); }`;
const FS = `precision mediump float; uniform sampler2D tex; varying vec2 vUv; varying vec4 vCol;
void main() { gl_FragColor = texture2D(tex, vUv) * vCol; }`;

/** floats per corner: x, y, u, v, r, g, b, a */
const STRIDE = 8;
const BATCH = 4096;
/** the most pixels drawn: a bigger canvas gets a smaller storyboard, scaled up */
const MAX_PIXELS = 1920 * 1080;
/** images wanted this far ahead, ms of the song */
const AHEAD = 3000;
const LOADING = 6;
/** loaded images beyond this many bytes go, those unused longest first */
const BUDGET = 768 * 1024 * 1024;
/** what was used this recently (wall ms) stays */
const KEEP = 5000;

interface Tex {
  tex: WebGLTexture | null;
  w: number;
  h: number;
  state: "queued" | "loading" | "ready" | "failed";
  used: number;
}

export class StoryboardView {
  readonly canvas = document.createElement("canvas");
  private gl: WebGLRenderingContext | null;
  private buf: WebGLBuffer | null = null;
  private loc = { size: null as WebGLUniformLocation | null };
  private verts = new Float32Array(BATCH * 4 * STRIDE);
  private n = 0;
  private boundTex: WebGLTexture | null = null;
  private additive = false;
  private blendSet = false;
  private texs = new Map<string, Tex>();
  private queue: string[] = [];
  private loading = 0;
  private bytes = 0;
  private lastScan = { wall: -Infinity, ms: Number.NaN };
  private under = { src: null as unknown, tex: null as WebGLTexture | null };
  private videoTex: WebGLTexture | null = null;
  private lost = false;

  constructor(
    private readonly sb: Storyboard,
    /** an image's address by its name in the set; null when the set hasn't got it */
    private readonly url: (name: string) => string | null,
    /** asks for a frame (an image arrived while nothing moves) */
    private readonly kick: () => void,
  ) {
    const gl = this.canvas.getContext("webgl", { alpha: false, antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: false });
    this.gl = gl;
    if (!gl) return;
    this.canvas.addEventListener("webglcontextlost", (e) => {
      e.preventDefault();
      this.lost = true;
    });
    const shader = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, shader(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.warn("[storyboard]", gl.getProgramInfoLog(prog));
      this.gl = null;
      return;
    }
    gl.useProgram(prog);
    this.buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferData(gl.ARRAY_BUFFER, this.verts.byteLength, gl.DYNAMIC_DRAW);
    const idx = new Uint16Array(BATCH * 6);
    for (let i = 0; i < BATCH; i++) idx.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4 + 2, i * 4 + 1, i * 4 + 3], i * 6);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    const attr = (name: string, size: number, off: number) => {
      const l = gl.getAttribLocation(prog, name);
      gl.enableVertexAttribArray(l);
      gl.vertexAttribPointer(l, size, gl.FLOAT, false, STRIDE * 4, off * 4);
    };
    attr("p", 2, 0);
    attr("uv", 2, 2);
    attr("col", 4, 4);
    this.loc.size = gl.getUniformLocation(prog, "size");
    gl.uniform1i(gl.getUniformLocation(prog, "tex"), 0);
    gl.enable(gl.BLEND);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  }

  /** Whether it can draw at all (WebGL there and not lost). */
  get ok(): boolean {
    return !!this.gl && !this.lost;
  }

  /** The storyboard at `ms` (song time as heard) on a w×h px canvas, the background `bg` (unless
   * the storyboard draws it itself) and the `video` under it; null when it can't draw. */
  render(ms: number, w: number, h: number, bg: TexImageSource | null, video: HTMLVideoElement | null): HTMLCanvasElement | null {
    const gl = this.gl;
    if (!gl || this.lost || gl.isContextLost()) return null;
    const k0 = Math.min(1, Math.sqrt(MAX_PIXELS / Math.max(1, w * h)));
    const W = Math.max(1, Math.round(w * k0));
    const H = Math.max(1, Math.round(h * k0));
    if (this.canvas.width !== W || this.canvas.height !== H) {
      this.canvas.width = W;
      this.canvas.height = H;
    }
    gl.viewport(0, 0, W, H);
    gl.uniform2f(this.loc.size, W, H);
    gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.setBlend(false);
    const wall = performance.now();

    // under it: the background, then the video
    if (bg && !this.sb.replacesBackground) {
      if (this.under.src !== bg) {
        if (this.under.tex) gl.deleteTexture(this.under.tex);
        this.under = { src: bg, tex: this.upload(bg) };
      }
      const size = sizeOf(bg);
      if (this.under.tex && size) this.cover(this.under.tex, size.w, size.h, W, H);
    }
    if (video && video.videoWidth) {
      this.videoTex ??= this.newTex();
      gl.bindTexture(gl.TEXTURE_2D, this.videoTex);
      try {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
        this.cover(this.videoTex, video.videoWidth, video.videoHeight, W, H);
      } catch {
        // a frame the canvas may not read: the background stays
      }
    }

    // the storyboard's space: 480 high, its 640 in the middle
    const k = H / 480;
    const ox = (W - 640 * k) / 2;
    if (!this.sb.widescreen) {
      this.flush();
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(Math.round(ox), 0, Math.round(640 * k), H);
    }
    for (const sp of this.sb.sprites) {
      if (sp.layer === FAIL_LAYER) continue;
      const st = spriteAt(sp, ms);
      if (!st) continue;
      const t = this.want(st.path, wall, true);
      if (!t || t.state !== "ready" || !t.tex) continue;
      this.setBlend(st.add);
      this.bind(t.tex);
      const x0 = -sp.ox * t.w * st.sx;
      const x1 = (1 - sp.ox) * t.w * st.sx;
      const y0 = -sp.oy * t.h * st.sy;
      const y1 = (1 - sp.oy) * t.h * st.sy;
      const cos = Math.cos(st.rot);
      const sin = Math.sin(st.rot);
      const px = (lx: number, ly: number) => ox + (st.x + lx * cos - ly * sin) * k;
      const py = (lx: number, ly: number) => (st.y + lx * sin + ly * cos) * k;
      const [u0, u1] = st.flipH ? [1, 0] : [0, 1];
      const [v0, v1] = st.flipV ? [1, 0] : [0, 1];
      const a = st.alpha;
      this.quad(
        px(x0, y0), py(x0, y0), u0, v0,
        px(x1, y0), py(x1, y0), u1, v0,
        px(x0, y1), py(x0, y1), u0, v1,
        px(x1, y1), py(x1, y1), u1, v1,
        st.r * a, st.g * a, st.b * a, a,
      );
    }
    this.flush();
    gl.disable(gl.SCISSOR_TEST);

    this.prefetch(ms, wall);
    this.pump();
    this.evict(wall);
    return this.canvas;
  }

  /** Lets go of everything (the context too). */
  dispose(): void {
    const gl = this.gl;
    this.queue = [];
    if (!gl) return;
    for (const t of this.texs.values()) if (t.tex) gl.deleteTexture(t.tex);
    this.texs.clear();
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    this.gl = null;
  }

  private newTex(): WebGLTexture {
    const gl = this.gl!;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.boundTex = null;
    return tex;
  }

  private upload(src: TexImageSource): WebGLTexture | null {
    const gl = this.gl!;
    const tex = this.newTex();
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
      return tex;
    } catch {
      gl.deleteTexture(tex);
      return null;
    }
  }

  /** An image fills the canvas, cropped to fit. */
  private cover(tex: WebGLTexture, iw: number, ih: number, W: number, H: number): void {
    const s = Math.max(W / iw, H / ih);
    const w = iw * s;
    const h = ih * s;
    const x = (W - w) / 2;
    const y = (H - h) / 2;
    this.bind(tex);
    this.quad(x, y, 0, 0, x + w, y, 1, 0, x, y + h, 0, 1, x + w, y + h, 1, 1, 1, 1, 1, 1);
    this.flush();
  }

  private bind(tex: WebGLTexture): void {
    if (this.boundTex === tex) return;
    this.flush();
    this.gl!.bindTexture(this.gl!.TEXTURE_2D, tex);
    this.boundTex = tex;
  }

  private setBlend(add: boolean): void {
    if (this.blendSet && this.additive === add) return;
    this.flush();
    const gl = this.gl!;
    // premultiplied: normal over, additive adds
    gl.blendFunc(gl.ONE, add ? gl.ONE : gl.ONE_MINUS_SRC_ALPHA);
    this.additive = add;
    this.blendSet = true;
  }

  // prettier-ignore
  private quad(
    ax: number, ay: number, au: number, av: number,
    bx: number, by: number, bu: number, bv: number,
    cx: number, cy: number, cu: number, cv: number,
    dx: number, dy: number, du: number, dv: number,
    r: number, g: number, b: number, a: number,
  ): void {
    if (this.n >= BATCH) this.flush();
    const v = this.verts;
    let o = this.n * 4 * STRIDE;
    for (const [x, y, u, w] of [[ax, ay, au, av], [bx, by, bu, bv], [cx, cy, cu, cv], [dx, dy, du, dv]]) {
      v[o++] = x; v[o++] = y; v[o++] = u; v[o++] = w;
      v[o++] = r; v[o++] = g; v[o++] = b; v[o++] = a;
    }
    this.n++;
  }

  private flush(): void {
    if (!this.n) return;
    const gl = this.gl!;
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.verts.subarray(0, this.n * 4 * STRIDE));
    gl.drawElements(gl.TRIANGLES, this.n * 6, gl.UNSIGNED_SHORT, 0);
    this.n = 0;
  }

  /** The image by its name, asked for if it isn't there yet (`now`: ahead of those only coming up). */
  private want(path: string, wall: number, now: boolean): Tex | null {
    let t = this.texs.get(path);
    if (!t) {
      t = { tex: null, w: 0, h: 0, state: "queued", used: wall };
      this.texs.set(path, t);
      if (now) this.queue.unshift(path);
      else this.queue.push(path);
    } else if (t.state === "queued" && now) {
      const i = this.queue.indexOf(path);
      if (i > 0) {
        this.queue.splice(i, 1);
        this.queue.unshift(path);
      }
    }
    t.used = wall;
    return t;
  }

  /** Asks for the images of what shows in the next few seconds, four times a second (and on a seek). */
  private prefetch(ms: number, wall: number): void {
    const jumped = !(Math.abs(ms - this.lastScan.ms) < 1000);
    if (!jumped && wall - this.lastScan.wall < 250) return;
    this.lastScan = { wall, ms };
    for (const sp of this.sb.sprites) {
      if (sp.layer === FAIL_LAYER || sp.start > ms + AHEAD || sp.end < ms) continue;
      for (const p of spritePaths(sp)) this.want(p, wall, false);
    }
  }

  private pump(): void {
    while (this.loading < LOADING && this.queue.length) {
      const path = this.queue.shift()!;
      const t = this.texs.get(path);
      if (!t || t.state !== "queued") continue;
      const url = this.url(path);
      if (!url) {
        t.state = "failed";
        continue;
      }
      t.state = "loading";
      this.loading++;
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.src = url;
      img
        .decode()
        .then(() => {
          // gone meanwhile (dropped, or this storyboard closed)
          if (!this.gl || this.texs.get(path) !== t) return;
          t.tex = this.upload(img);
          t.w = img.naturalWidth;
          t.h = img.naturalHeight;
          t.state = t.tex ? "ready" : "failed";
          this.bytes += t.w * t.h * 4;
          this.kick();
        })
        .catch(() => {
          t.state = "failed";
        })
        .finally(() => {
          this.loading--;
          this.pump();
        });
    }
  }

  /** Over the budget: images unused longest go (asked for again when they're needed). */
  private evict(wall: number): void {
    if (this.bytes <= BUDGET) return;
    const old = [...this.texs.entries()].filter(([, t]) => t.state === "ready" && wall - t.used > KEEP).sort((a, b) => a[1].used - b[1].used);
    const gl = this.gl!;
    for (const [path, t] of old) {
      if (this.bytes <= BUDGET * 0.8) break;
      if (t.tex) gl.deleteTexture(t.tex);
      this.bytes -= t.w * t.h * 4;
      this.texs.delete(path);
    }
    this.boundTex = null;
  }
}

function sizeOf(src: TexImageSource): { w: number; h: number } | null {
  const s = src as { naturalWidth?: number; naturalHeight?: number; videoWidth?: number; videoHeight?: number; width?: number; height?: number };
  const w = s.naturalWidth || s.videoWidth || s.width || 0;
  const h = s.naturalHeight || s.videoHeight || s.height || 0;
  return w && h ? { w, h } : null;
}
