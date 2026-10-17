import type { CharacterDef } from '../characters';
import type { Settings } from './options';
import type { MarkStyle } from './marks/types';
import { Camera } from './camera';
import { hexToRgb, lerp } from './math';

/** Depth buckets: stroke color, alpha and width are quantized to this many steps. */
const BUCKETS = 12;
/** Points on a ring that has no sculpted shape (drawn as a circle). */
const CIRCLE_POINTS = 24;

interface BucketStyle {
  color: string;
  lineWidth: number;
}

/**
 * Projects each ring's contour into screen space and paints rings back to front.
 *
 * Every ring is a closed curve in its own plane (ADR 0002). Each frame the
 * plane follows the body: its center rides between two nodes, its axis T
 * runs between the neighboring rings' centers, and its N axis is carried
 * along by the smallest rotation from rest. Surface normals come from the
 * ring grid itself (around the ring × along the body), so they stay right as
 * the body deforms.
 *
 * Two looks:
 * - ghost: every ring drawn whole, so the body reads as see-through.
 * - solid: the body is opaque. Each ring shows only the stretches that face
 *   the eye, and as rings paint back to front each one first erases its
 *   cross-section and the band of body between it and its nearer neighbor.
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

  // Per ring.
  private count = 0;
  private start = new Int32Array(0); // first point index
  private size = new Int32Array(0); // point count
  private prev = new Int32Array(0); // neighbor ring on the same part, or -1
  private next = new Int32Array(0);
  private offset = new Float32Array(0); // rest center minus rest node lerp
  private restT = new Float32Array(0);
  private restN = new Float32Array(0);
  private worldC = new Float32Array(0); // world space, this frame
  private center = new Float32Array(0); // view space, this frame
  private axis = new Float32Array(0); // view space T, this frame
  private depth = new Float32Array(0);
  private near = new Float32Array(0);
  private silL = new Int32Array(0); // silhouette point indices, this frame
  private silR = new Int32Array(0);
  private order: number[] = [];

  // Per point.
  private shape = new Float32Array(0); // x, y in the ring plane
  private view = new Float32Array(0); // xyz, view space
  private screen = new Float32Array(0); // xy, CSS px
  private facing = new Float32Array(0); // > 0 faces the eye
  private run = new Float32Array(0); // scratch for one visible run

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
    this.count = n;
    this.start = new Int32Array(n);
    this.size = new Int32Array(n);
    this.prev = new Int32Array(n);
    this.next = new Int32Array(n);
    this.offset = new Float32Array(n * 3);
    this.restT = new Float32Array(n * 3);
    this.restN = new Float32Array(n * 3);
    this.center = new Float32Array(n * 3);
    this.axis = new Float32Array(n * 3);
    this.depth = new Float32Array(n);
    this.near = new Float32Array(n);
    this.silL = new Int32Array(n);
    this.silR = new Int32Array(n);
    this.order = Array.from({ length: n }, (_, i) => i);

    let total = 0;
    let maxSize = 0;
    rings.forEach((r, i) => {
      this.start[i] = total;
      this.size[i] = r.shape ? r.shape.pts.length / 2 : CIRCLE_POINTS;
      total += this.size[i];
      maxSize = Math.max(maxSize, this.size[i]);
      this.prev[i] = i > 0 && rings[i - 1].part === r.part ? i - 1 : -1;
      this.next[i] = i < n - 1 && rings[i + 1].part === r.part ? i + 1 : -1;
    });
    this.shape = new Float32Array(total * 2);
    this.view = new Float32Array(total * 3);
    this.screen = new Float32Array(total * 2);
    this.facing = new Float32Array(total);
    this.run = new Float32Array((maxSize + 2) * 2);

    // Rest centers: the sculpted center when there is one, else the node lerp.
    const lerpRest = (i: number, k: number) => {
      const r = rings[i];
      return rest[r.a * 3 + k] + (rest[r.b * 3 + k] - rest[r.a * 3 + k]) * r.t;
    };
    const restC = new Float32Array(n * 3);
    rings.forEach((r, i) => {
      for (let k = 0; k < 3; k++) {
        restC[i * 3 + k] = r.shape ? r.shape.c[k] : lerpRest(i, k);
        this.offset[i * 3 + k] = restC[i * 3 + k] - lerpRest(i, k);
      }
    });

    rings.forEach((r, i) => {
      // Rest T exactly as draw() computes it each frame, so at rest nothing rotates.
      const T = this.axisFrom(restC, i, rest, rings);
      this.restT.set(T, i * 3);
      // Rest N: the sculpted one, or any direction across T, made perpendicular to T.
      let N = r.shape ? r.shape.N : Math.abs(T[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
      const d = N[0] * T[0] + N[1] * T[1] + N[2] * T[2];
      N = [N[0] - T[0] * d, N[1] - T[1] * d, N[2] - T[2] * d];
      const l = Math.hypot(N[0], N[1], N[2]) || 1;
      this.restN.set([N[0] / l, N[1] / l, N[2] / l], i * 3);

      const o = this.start[i] * 2;
      if (r.shape) {
        this.shape.set(r.shape.pts, o);
      } else {
        for (let k = 0; k < CIRCLE_POINTS; k++) {
          const a = (k / CIRCLE_POINTS) * Math.PI * 2;
          this.shape[o + k * 2] = Math.cos(a) * r.radius;
          this.shape[o + k * 2 + 1] = Math.sin(a) * r.radius;
        }
      }
    });
  }

  /** Unit axis along the body at ring i: from the previous ring's center to the next one's. */
  private axisFrom(centers: Float32Array, i: number, pos: Float32Array, rings: CharacterDef['rings']): number[] {
    const p = this.prev[i], q = this.next[i];
    let x: number, y: number, z: number;
    if (p >= 0 || q >= 0) {
      const lo = (p >= 0 ? p : i) * 3, hi = (q >= 0 ? q : i) * 3;
      x = centers[hi] - centers[lo];
      y = centers[hi + 1] - centers[lo + 1];
      z = centers[hi + 2] - centers[lo + 2];
    } else {
      const a = rings[i].a * 3, b = rings[i].b * 3;
      x = pos[b] - pos[a];
      y = pos[b + 1] - pos[a + 1];
      z = pos[b + 2] - pos[a + 2];
    }
    const l = Math.hypot(x, y, z) || 1;
    return [x / l, y / l, z / l];
  }

  draw(character: CharacterDef, pos: Float32Array, settings: Settings, transparent: boolean) {
    const { ctx, camera } = this;
    camera.update(settings.camera, this.width, this.height, character.center, character.extent);

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    if (transparent) {
      ctx.clearRect(0, 0, this.width, this.height);
    } else {
      ctx.fillStyle = settings.colors.background;
      ctx.fillRect(0, 0, this.width, this.height);
    }

    this.project(character, pos);
    this.shade();

    // Back to front.
    const depth = this.depth;
    this.order.sort((i, j) => depth[j] - depth[i]);
    let dMin = Infinity, dMax = -Infinity;
    for (let i = 0; i < this.count; i++) {
      if (depth[i] < dMin) dMin = depth[i];
      if (depth[i] > dMax) dMax = depth[i];
    }
    const span = dMax - dMin || 1;
    for (let i = 0; i < this.count; i++) this.near[i] = (dMax - depth[i]) / span;

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (settings.solid) this.paintSolid(settings.colors.background, transparent);
    else this.paintGhost();
  }

  /** Place every ring's contour in view space and on screen. */
  private project(character: CharacterDef, pos: Float32Array) {
    const camera = this.camera;
    const rings = character.rings;
    const n = this.count;

    // World centers this frame.
    if (this.worldC.length !== n * 3) this.worldC = new Float32Array(n * 3);
    const wc = this.worldC;
    for (let i = 0; i < n; i++) {
      const r = rings[i];
      for (let k = 0; k < 3; k++) {
        wc[i * 3 + k] = pos[r.a * 3 + k] + (pos[r.b * 3 + k] - pos[r.a * 3 + k]) * r.t + this.offset[i * 3 + k];
      }
    }

    for (let i = 0; i < n; i++) {
      const T = this.axisFrom(wc, i, pos, rings);
      // Carry N along by the smallest rotation taking rest T to this T.
      const a0 = this.restT[i * 3], a1 = this.restT[i * 3 + 1], a2 = this.restT[i * 3 + 2];
      const v0 = this.restN[i * 3], v1 = this.restN[i * 3 + 1], v2 = this.restN[i * 3 + 2];
      const c = a0 * T[0] + a1 * T[1] + a2 * T[2];
      const k0 = a1 * T[2] - a2 * T[1], k1 = a2 * T[0] - a0 * T[2], k2 = a0 * T[1] - a1 * T[0];
      const kv = k0 * v0 + k1 * v1 + k2 * v2;
      const f = c > -0.999 ? kv / (1 + c) : 0;
      let N0 = v0 * c + (k1 * v2 - k2 * v1) + k0 * f;
      let N1 = v1 * c + (k2 * v0 - k0 * v2) + k1 * f;
      let N2 = v2 * c + (k0 * v1 - k1 * v0) + k2 * f;
      const nl = Math.hypot(N0, N1, N2) || 1;
      N0 /= nl; N1 /= nl; N2 /= nl;
      const B0 = T[1] * N2 - T[2] * N1, B1 = T[2] * N0 - T[0] * N2, B2 = T[0] * N1 - T[1] * N0;

      const cx = wc[i * 3], cy = wc[i * 3 + 1], cz = wc[i * 3 + 2];
      camera.toView(cx, cy, cz, this.center, i * 3);
      camera.rotate(T[0], T[1], T[2], this.axis, i * 3);
      this.depth[i] = camera.distance - this.center[i * 3 + 2];

      const s0 = this.start[i], m = this.size[i];
      for (let k = 0; k < m; k++) {
        const x = this.shape[(s0 + k) * 2], y = this.shape[(s0 + k) * 2 + 1];
        camera.toView(cx + N0 * x + B0 * y, cy + N1 * x + B1 * y, cz + N2 * x + B2 * y, this.view, (s0 + k) * 3);
        const vx = this.view[(s0 + k) * 3], vy = this.view[(s0 + k) * 3 + 1], vz = this.view[(s0 + k) * 3 + 2];
        const s = camera.distance / (camera.distance - vz);
        this.screen[(s0 + k) * 2] = camera.cx + vx * s * camera.ppu;
        this.screen[(s0 + k) * 2 + 1] = camera.cyScreen - vy * s * camera.ppu;
      }
    }
  }

  /**
   * Which points face the eye, from the ring grid's surface normal; and each
   * ring's silhouette points (widest across the body, on screen) for bands.
   */
  private shade() {
    const { view, screen, facing } = this;
    const dist = this.camera.distance;
    for (let i = 0; i < this.count; i++) {
      const s0 = this.start[i], m = this.size[i];
      const p = this.prev[i], q = this.next[i];
      const lo = p >= 0 && this.size[p] === m ? p : i;
      const hi = q >= 0 && this.size[q] === m ? q : i;
      const cx = this.center[i * 3], cy = this.center[i * 3 + 1], cz = this.center[i * 3 + 2];
      // Fallback "along the body" direction for rings without a matching neighbor.
      const ax = this.axis[i * 3], ay = this.axis[i * 3 + 1], az = this.axis[i * 3 + 2];

      for (let k = 0; k < m; k++) {
        const ik = (s0 + k) * 3;
        const kp = (s0 + ((k + m - 1) % m)) * 3, kn = (s0 + ((k + 1) % m)) * 3;
        // Around the ring.
        const ux = view[kn] - view[kp], uy = view[kn + 1] - view[kp + 1], uz = view[kn + 2] - view[kp + 2];
        // Along the body (same point index on the neighboring rings).
        let wx = ax, wy = ay, wz = az;
        if (lo !== hi) {
          const a = (this.start[lo] + k) * 3, b = (this.start[hi] + k) * 3;
          wx = view[b] - view[a];
          wy = view[b + 1] - view[a + 1];
          wz = view[b + 2] - view[a + 2];
        }
        let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
        // Outward: away from the ring's center.
        if (nx * (view[ik] - cx) + ny * (view[ik + 1] - cy) + nz * (view[ik + 2] - cz) < 0) {
          nx = -nx; ny = -ny; nz = -nz;
        }
        const ex = -view[ik], ey = -view[ik + 1], ez = dist - view[ik + 2];
        facing[s0 + k] = (nx * ex + ny * ey + nz * ez) / ((Math.hypot(nx, ny, nz) || 1) * (Math.hypot(ex, ey, ez) || 1));
      }

      // Silhouette: the two points farthest apart across the body's screen direction.
      let dx = ax, dy = -ay;
      const dl = Math.hypot(dx, dy);
      if (dl < 1e-6) { dx = 1; dy = 0; } else { dx /= dl; dy /= dl; }
      const qx = -dy, qy = dx;
      let mn = Infinity, mx = -Infinity, iL = s0, iR = s0;
      for (let k = 0; k < m; k++) {
        const d = screen[(s0 + k) * 2] * qx + screen[(s0 + k) * 2 + 1] * qy;
        if (d < mn) { mn = d; iL = s0 + k; }
        if (d > mx) { mx = d; iR = s0 + k; }
      }
      this.silL[i] = iL;
      this.silR[i] = iR;
    }
  }

  private bucketOf(i: number) {
    // Clamped both ways: depth is stored as Float32, so `near` can land a hair outside 0–1.
    return Math.max(0, Math.min(BUCKETS - 1, Math.floor(this.near[i] * BUCKETS)));
  }

  /** The whole ring as one closed run. */
  private addWhole(i: number, lineWidth: number) {
    const m = this.size[i];
    this.mark.addRun(this.ctx, this.screen.subarray(this.start[i] * 2, (this.start[i] + m) * 2), m, true, lineWidth);
  }

  /** Each stretch of the ring that faces the eye, with ends trimmed to where facing crosses zero. */
  private addVisible(i: number, lineWidth: number) {
    const { facing, screen, run } = this;
    const s0 = this.start[i], m = this.size[i];
    let firstHidden = -1;
    for (let k = 0; k < m; k++) if (facing[s0 + k] <= 0) { firstHidden = k; break; }
    if (firstHidden < 0) {
      this.addWhole(i, lineWidth);
      return;
    }
    let n = 0;
    const flush = () => {
      if (n >= 2) this.mark.addRun(this.ctx, run, n, false, lineWidth);
      n = 0;
    };
    const push = (x: number, y: number) => {
      run[n * 2] = x;
      run[n * 2 + 1] = y;
      n++;
    };
    for (let j = 1; j <= m; j++) {
      const k = s0 + ((firstHidden + j) % m);
      const kPrev = s0 + ((firstHidden + j - 1) % m);
      const fv = facing[k], fp = facing[kPrev];
      if (fv > 0 && fp <= 0) {
        // Entering: start exactly at the crossing.
        const t = fp / (fp - fv);
        push(lerp(screen[kPrev * 2], screen[k * 2], t), lerp(screen[kPrev * 2 + 1], screen[k * 2 + 1], t));
        push(screen[k * 2], screen[k * 2 + 1]);
      } else if (fv > 0) {
        push(screen[k * 2], screen[k * 2 + 1]);
      } else if (fp > 0) {
        // Leaving: end exactly at the crossing.
        const t = fp / (fp - fv);
        push(lerp(screen[kPrev * 2], screen[k * 2], t), lerp(screen[kPrev * 2 + 1], screen[k * 2 + 1], t));
        flush();
      }
    }
    flush();
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
      this.addWhole(i, this.styles[b].lineWidth);
    }
    if (bucket >= 0) this.paintPath();
  }

  /** Opaque body: erase what this ring's slice of body hides, then draw what of it faces the eye. */
  private paintSolid(background: string, transparent: boolean) {
    const { ctx, screen, depth } = this;
    for (const i of this.order) {
      ctx.globalCompositeOperation = transparent ? 'destination-out' : 'source-over';
      ctx.fillStyle = transparent ? '#000' : background;

      // The cross-section.
      const s0 = this.start[i], m = this.size[i];
      ctx.beginPath();
      ctx.moveTo(screen[s0 * 2], screen[s0 * 2 + 1]);
      for (let k = 1; k < m; k++) ctx.lineTo(screen[(s0 + k) * 2], screen[(s0 + k) * 2 + 1]);
      ctx.closePath();
      ctx.fill();

      // The band to each neighbor that is nearer than this ring (that band sits at
      // this ring's depth or behind). Filled on its own so windings can't cancel.
      for (const j of [this.prev[i], this.next[i]]) {
        if (j < 0 || depth[j] > depth[i]) continue;
        const a = this.silL[i] * 2, b = this.silL[j] * 2, c = this.silR[j] * 2, d = this.silR[i] * 2;
        ctx.beginPath();
        ctx.moveTo(screen[a], screen[a + 1]);
        ctx.lineTo(screen[b], screen[b + 1]);
        ctx.lineTo(screen[c], screen[c + 1]);
        ctx.lineTo(screen[d], screen[d + 1]);
        ctx.closePath();
        ctx.fill();
      }

      ctx.globalCompositeOperation = 'source-over';
      const style = this.styles[this.bucketOf(i)];
      ctx.strokeStyle = ctx.fillStyle = style.color;
      ctx.lineWidth = style.lineWidth;
      ctx.beginPath();
      this.addVisible(i, style.lineWidth);
      this.paintPath();
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  private paintPath() {
    if (this.mark.paint === 'stroke') this.ctx.stroke();
    else this.ctx.fill();
  }
}
