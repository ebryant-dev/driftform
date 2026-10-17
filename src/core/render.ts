import type { CharacterDef } from '../characters';
import type { Settings } from './options';
import type { MarkStyle, ProjectedRing } from './marks/types';
import { Camera } from './camera';
import { hexToRgb, lerp } from './math';

/** Depth buckets: rings are sorted back to front and painted with one stroke per bucket. */
const BUCKETS = 12;

interface BucketStyle {
  color: string;
  lineWidth: number;
}

/**
 * Projects each ring to a screen-space ellipse and paints them back to front.
 * Owns the canvas pixels (size, devicePixelRatio) but not the page.
 */
export class Renderer {
  readonly camera = new Camera();
  private ctx: CanvasRenderingContext2D;
  private width = 0;
  private height = 0;
  private dpr = 1;
  private styles: BucketStyle[] = [];
  private projected: ProjectedRing[] = [];
  private depth = new Float32Array(0);
  private order: number[] = [];
  private v = new Float32Array(6);

  constructor(
    private canvas: HTMLCanvasElement,
    private mark: MarkStyle,
  ) {
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) throw new Error('Driftform: Canvas 2D is not available.');
    this.ctx = ctx;
  }

  /** Match the backing store to the container's CSS size × devicePixelRatio. Returns true if it changed. */
  resize(cssWidth: number, cssHeight: number, maxDpr: number) {
    const dpr = Math.min(window.devicePixelRatio || 1, maxDpr);
    const w = Math.max(1, Math.round(cssWidth * dpr));
    const h = Math.max(1, Math.round(cssHeight * dpr));
    if (w === this.canvas.width && h === this.canvas.height && dpr === this.dpr) return false;
    this.canvas.width = w;
    this.canvas.height = h;
    this.width = cssWidth;
    this.height = cssHeight;
    this.dpr = dpr;
    return true;
  }

  setStyle(settings: Settings) {
    const near = hexToRgb(settings.colors.near);
    const far = hexToRgb(settings.colors.far);
    this.styles = [];
    for (let b = 0; b < BUCKETS; b++) {
      const t = (b + 0.5) / BUCKETS;
      const alpha = 1 - settings.depthFade * (1 - t);
      const c = [0, 1, 2].map((i) => Math.round(lerp(far[i], near[i], t)));
      this.styles.push({
        color: `rgba(${c[0]},${c[1]},${c[2]},${alpha.toFixed(3)})`,
        lineWidth: settings.strokeWeight * lerp(0.4, 1, t),
      });
    }
  }

  setCharacter(character: CharacterDef) {
    const n = character.rings.length;
    this.projected = Array.from({ length: n }, () => ({ x: 0, y: 0, major: 0, minor: 0, rotation: 0, near: 0 }));
    this.depth = new Float32Array(n);
    this.order = Array.from({ length: n }, (_, i) => i);
  }

  draw(character: CharacterDef, pos: Float32Array, settings: Settings, transparent: boolean) {
    const { ctx, camera, v } = this;
    camera.update(settings.camera, this.width, this.height, character.center, character.extent);

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    if (transparent) {
      ctx.clearRect(0, 0, this.width, this.height);
    } else {
      ctx.fillStyle = settings.colors.background;
      ctx.fillRect(0, 0, this.width, this.height);
    }

    // Project every ring.
    const rings = character.rings;
    let dMin = Infinity;
    let dMax = -Infinity;
    for (let i = 0; i < rings.length; i++) {
      const r = rings[i];
      const a = r.a * 3;
      const b = r.b * 3;
      const ax = pos[a], ay = pos[a + 1], az = pos[a + 2];
      const nx = pos[b] - ax, ny = pos[b + 1] - ay, nz = pos[b + 2] - az;

      camera.toView(ax + nx * r.t, ay + ny * r.t, az + nz * r.t, v, 0);
      camera.rotate(nx, ny, nz, v, 3);

      const d = camera.distance - v[2];
      const s = camera.distance / d;
      const p = this.projected[i];
      p.x = camera.cx + v[0] * s * camera.ppu;
      p.y = camera.cyScreen - v[1] * s * camera.ppu;
      p.major = r.radius * s * camera.ppu;

      // Direction from the ring to the eye, and the ring's normal, in view space.
      const dl = Math.hypot(v[0], v[1], d) || 1;
      const ex = -v[0] / dl, ey = -v[1] / dl, ez = d / dl;
      const nl = Math.hypot(v[3], v[4], v[5]) || 1;
      const mx = v[3] / nl, my = v[4] / nl, mz = v[5] / nl;

      // Facing the eye → full circle; edge-on → a line.
      p.minor = p.major * Math.abs(mx * ex + my * ey + mz * ez);

      // The major axis lies along normal × eye (the ring's diameter seen at full length).
      let ux = my * ez - mz * ey;
      let uy = mz * ex - mx * ez;
      if (ux * ux + uy * uy < 1e-8) {
        ux = 1;
        uy = 0;
      }
      p.rotation = Math.atan2(-uy, ux);

      this.depth[i] = d;
      if (d < dMin) dMin = d;
      if (d > dMax) dMax = d;
    }

    // Back to front, then one path per depth bucket.
    const depth = this.depth;
    this.order.sort((i, j) => depth[j] - depth[i]);
    const span = dMax - dMin || 1;
    let bucket = -1;
    ctx.lineCap = 'round';
    for (const i of this.order) {
      const p = this.projected[i];
      p.near = (dMax - depth[i]) / span;
      const b = Math.min(BUCKETS - 1, Math.floor(p.near * BUCKETS));
      if (b !== bucket) {
        if (bucket >= 0) this.paint();
        bucket = b;
        const style = this.styles[b];
        ctx.strokeStyle = ctx.fillStyle = style.color;
        ctx.lineWidth = style.lineWidth;
        ctx.beginPath();
      }
      this.mark.addToPath(ctx, p, this.styles[b].lineWidth);
    }
    if (bucket >= 0) this.paint();
  }

  private paint() {
    if (this.mark.paint === 'stroke') this.ctx.stroke();
    else this.ctx.fill();
  }
}
