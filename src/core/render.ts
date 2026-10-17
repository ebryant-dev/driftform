import type { CharacterDef } from '../characters';
import type { Settings } from './options';
import type { MarkStyle, ProjectedRing } from './marks/types';
import { Camera } from './camera';
import { hexToRgb, lerp } from './math';

/** Depth buckets: stroke color, alpha and width are quantized to this many steps. */
const BUCKETS = 12;
const TAU = Math.PI * 2;

interface BucketStyle {
  color: string;
  lineWidth: number;
}

interface RingTopology {
  /** Neighboring rings on the same part (-1 at the ends). */
  prev: number;
  next: number;
  /** How fast the body widens along the ring's normal (dr/ds), from the rest pose. */
  taper: number;
}

/**
 * Projects each ring to a screen-space ellipse and paints them back to front.
 *
 * Two looks:
 * - ghost: every ring is a full ellipse, so the body reads as see-through.
 * - solid: the body is opaque. Each ring shows only the arc on the side
 *   facing the eye, and as rings are painted back to front each one first
 *   erases its cross-section and the band of body between it and its
 *   neighbor, hiding whatever lies behind.
 *
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
  private topo: RingTopology[] = [];
  private depth = new Float32Array(0);
  /** Screen-space ends of each ring's major axis: the body's silhouette at that ring. */
  private ends = new Float32Array(0);
  private visible = new Uint8Array(0);
  private centers = new Float32Array(0);
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
    const { rings, rest } = character;
    const n = rings.length;
    this.projected = Array.from({ length: n }, () => ({
      x: 0, y: 0, major: 0, minor: 0, rotation: 0, near: 0, arcStart: 0, arcEnd: TAU,
    }));
    this.depth = new Float32Array(n);
    this.ends = new Float32Array(n * 4);
    this.visible = new Uint8Array(n);
    this.centers = new Float32Array(n * 3);
    this.order = Array.from({ length: n }, (_, i) => i);

    // Rest-pose ring centers, to measure each ring's taper.
    const centers = rings.map((r) => {
      const a = r.a * 3, b = r.b * 3;
      return [0, 1, 2].map((k) => lerp(rest[a + k], rest[b + k], r.t));
    });
    this.topo = rings.map((r, i) => {
      const prev = i > 0 && rings[i - 1].part === r.part ? i - 1 : -1;
      const next = i < n - 1 && rings[i + 1].part === r.part ? i + 1 : -1;
      const lo = prev >= 0 ? prev : i;
      const hi = next >= 0 ? next : i;
      const ds = Math.hypot(...[0, 1, 2].map((k) => centers[hi][k] - centers[lo][k]));
      const taper = lo !== hi && ds > 1e-6 ? (rings[hi].radius - rings[lo].radius) / ds : 0;
      return { prev, next, taper };
    });
  }

  draw(character: CharacterDef, pos: Float32Array, settings: Settings, transparent: boolean) {
    const { ctx } = this;
    this.camera.update(settings.camera, this.width, this.height, character.center, character.extent);

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    if (transparent) {
      ctx.clearRect(0, 0, this.width, this.height);
    } else {
      ctx.fillStyle = settings.colors.background;
      ctx.fillRect(0, 0, this.width, this.height);
    }

    const { dMin, dMax } = this.project(character, pos, settings.solid);

    // Back to front.
    const depth = this.depth;
    this.order.sort((i, j) => depth[j] - depth[i]);
    const span = dMax - dMin || 1;
    for (const i of this.order) this.projected[i].near = (dMax - depth[i]) / span;

    ctx.lineCap = 'round';
    if (settings.solid) this.paintSolid(settings.colors.background, transparent);
    else this.paintGhost();
  }

  /** Project every ring into `projected`, `depth`, `ends` and `visible`. */
  private project(character: CharacterDef, pos: Float32Array, solid: boolean) {
    const { camera, v } = this;
    const rings = character.rings;
    let dMin = Infinity;
    let dMax = -Infinity;

    // Ring centers first, so each ring's normal can follow its neighbors:
    // the line from the previous ring's center to the next one's. That bends
    // smoothly along the body instead of jumping at every node.
    const wc = this.centers;
    for (let i = 0; i < rings.length; i++) {
      const r = rings[i];
      const a = r.a * 3, b = r.b * 3;
      for (let k = 0; k < 3; k++) wc[i * 3 + k] = pos[a + k] + (pos[b + k] - pos[a + k]) * r.t;
    }

    for (let i = 0; i < rings.length; i++) {
      const r = rings[i];
      const { prev, next } = this.topo[i];
      let nx: number, ny: number, nz: number;
      if (prev >= 0 || next >= 0) {
        const lo = (prev >= 0 ? prev : i) * 3, hi = (next >= 0 ? next : i) * 3;
        nx = wc[hi] - wc[lo]; ny = wc[hi + 1] - wc[lo + 1]; nz = wc[hi + 2] - wc[lo + 2];
      } else {
        const a = r.a * 3, b = r.b * 3;
        nx = pos[b] - pos[a]; ny = pos[b + 1] - pos[a + 1]; nz = pos[b + 2] - pos[a + 2];
      }

      camera.toView(wc[i * 3], wc[i * 3 + 1], wc[i * 3 + 2], v, 0);
      camera.rotate(nx, ny, nz, v, 3);

      const d = camera.distance - v[2];
      const s = camera.distance / d;
      const p = this.projected[i];
      p.x = camera.cx + v[0] * s * camera.ppu;
      p.y = camera.cyScreen - v[1] * s * camera.ppu;
      p.major = r.radius * s * camera.ppu;

      // e: from the ring toward the eye. m: the ring's normal. Both view space, unit length.
      const dl = Math.hypot(v[0], v[1], d) || 1;
      const ex = -v[0] / dl, ey = -v[1] / dl, ez = d / dl;
      const nl = Math.hypot(v[3], v[4], v[5]) || 1;
      const mx = v[3] / nl, my = v[4] / nl, mz = v[5] / nl;
      const facing = mx * ex + my * ey + mz * ez;

      // Facing the eye → full circle; edge-on → a line.
      p.minor = p.major * Math.abs(facing);

      // U: the ring's diameter seen at full length (normal × eye). V completes the ring's plane.
      let ux = my * ez - mz * ey;
      let uy = mz * ex - mx * ez;
      let uz = mx * ey - my * ex;
      let ul = Math.hypot(ux, uy, uz);
      if (ul < 1e-5) {
        // Face-on: any in-plane direction will do.
        ux = mz; uy = 0; uz = -mx;
        ul = Math.hypot(ux, uz);
        if (ul < 1e-5) { ux = 1; uz = 0; ul = 1; }
      }
      ux /= ul; uy /= ul; uz /= ul;
      p.rotation = Math.atan2(-uy, ux);

      const ca = Math.cos(p.rotation) * p.major;
      const sa = Math.sin(p.rotation) * p.major;
      this.ends[i * 4] = p.x + ca;
      this.ends[i * 4 + 1] = p.y + sa;
      this.ends[i * 4 + 2] = p.x - ca;
      this.ends[i * 4 + 3] = p.y - sa;

      this.visible[i] = 1;
      p.arcStart = 0;
      p.arcEnd = TAU;
      if (solid) {
        let vx = my * uz - mz * uy;
        let vy = mz * ux - mx * uz;
        let vz = mx * uy - my * ux;
        let ve = vx * ex + vy * ey + vz * ez;
        if (ve < 0) { vx = -vx; vy = -vy; vz = -vz; ve = -ve; }

        // A point at angle φ around the ring (U at 0, V at 90°) faces the eye
        // when sin φ · (V·e) > taper · (m·e): the surface tilts toward m as
        // the body narrows, which is why a dome's top ring shows whole.
        const bias = this.topo[i].taper * facing;
        const k = ve > 1e-5 ? bias / ve : bias < 0 ? -2 : 2;
        if (k >= 1) {
          this.visible[i] = 0;
        } else if (k > -1) {
          const phi = Math.asin(k);
          // Canvas sweeps from the major axis toward +90°; does V land there or at -90° on screen?
          const flip = ux * -vy - -uy * vx < 0;
          if (flip) {
            p.arcStart = -(Math.PI - phi);
            p.arcEnd = -phi;
          } else {
            p.arcStart = phi;
            p.arcEnd = Math.PI - phi;
          }
        }
      }

      this.depth[i] = d;
      if (d < dMin) dMin = d;
      if (d > dMax) dMax = d;
    }
    return { dMin, dMax };
  }

  private bucketOf(i: number) {
    // Clamped both ways: depth is stored as Float32, so `near` can land a hair outside 0–1.
    return Math.max(0, Math.min(BUCKETS - 1, Math.floor(this.projected[i].near * BUCKETS)));
  }

  /** See-through: one path per depth bucket. */
  private paintGhost() {
    const { ctx } = this;
    let bucket = -1;
    for (const i of this.order) {
      const b = this.bucketOf(i);
      if (b !== bucket) {
        if (bucket >= 0) this.paintPath();
        bucket = b;
        ctx.strokeStyle = ctx.fillStyle = this.styles[b].color;
        ctx.lineWidth = this.styles[b].lineWidth;
        ctx.beginPath();
      }
      this.mark.addToPath(ctx, this.projected[i], this.styles[b].lineWidth);
    }
    if (bucket >= 0) this.paintPath();
  }

  /** Opaque body: erase what this ring's slice of body hides, then draw its visible arc. */
  private paintSolid(background: string, transparent: boolean) {
    const { ctx, projected, ends, depth } = this;
    for (const i of this.order) {
      const p = projected[i];

      // Erase: the cross-section, plus the band to each neighbor that is
      // nearer than this ring (that band sits at this ring's depth or behind).
      ctx.globalCompositeOperation = transparent ? 'destination-out' : 'source-over';
      ctx.fillStyle = transparent ? '#000' : background;
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, p.major, Math.max(p.minor, 0.01), p.rotation, 0, TAU);
      ctx.fill();
      // Each band is filled on its own: sharing a path with the ellipse, opposite windings would cancel into holes.
      for (const j of [this.topo[i].prev, this.topo[i].next]) {
        if (j < 0 || depth[j] > depth[i]) continue;
        const a = i * 4;
        // Pair silhouette ends that point the same way, so the band never twists into a bow tie.
        const same = Math.cos(p.rotation - projected[j].rotation) >= 0;
        const b = j * 4 + (same ? 0 : 2);
        const b2 = j * 4 + (same ? 2 : 0);
        ctx.beginPath();
        ctx.moveTo(ends[a], ends[a + 1]);
        ctx.lineTo(ends[b], ends[b + 1]);
        ctx.lineTo(ends[b2], ends[b2 + 1]);
        ctx.lineTo(ends[a + 2], ends[a + 3]);
        ctx.closePath();
        ctx.fill();
      }

      if (!this.visible[i]) continue;
      ctx.globalCompositeOperation = 'source-over';
      const style = this.styles[this.bucketOf(i)];
      ctx.strokeStyle = ctx.fillStyle = style.color;
      ctx.lineWidth = style.lineWidth;
      ctx.beginPath();
      this.mark.addToPath(ctx, p, style.lineWidth);
      this.paintPath();
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  private paintPath() {
    if (this.mark.paint === 'stroke') this.ctx.stroke();
    else this.ctx.fill();
  }
}
