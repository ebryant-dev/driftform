import type { Settings } from './options';

/**
 * Simple pinhole camera on the +z axis looking at the character's center.
 * World → view applies yaw (about y) then pitch (about x). Perspective scale
 * is 1 at the character's center, so `ppu` alone sets on-screen size.
 */
export class Camera {
  private cy = 1;
  private sy = 0;
  private cp = 1;
  private sp = 0;
  distance = 14;
  /** Screen pixels per world unit at the character's center. */
  ppu = 1;
  cx = 0;
  cyScreen = 0;
  center: [number, number, number] = [0, 0, 0];

  update(settings: Settings['camera'], width: number, height: number, center: [number, number, number], extent: number) {
    this.cy = Math.cos(settings.yaw);
    this.sy = Math.sin(settings.yaw);
    this.cp = Math.cos(settings.pitch);
    this.sp = Math.sin(settings.pitch);
    this.distance = Math.max(settings.distance, 1.2) * extent;
    this.center = center;
    this.ppu = (Math.min(width, height) * 0.5 * settings.framing) / extent;
    this.cx = width / 2;
    this.cyScreen = height / 2;
  }

  /** Rotate a world-space vector into view space (no translation). Writes into `out`. */
  rotate(x: number, y: number, z: number, out: Float32Array, o: number) {
    // Yaw about y.
    const x1 = x * this.cy + z * this.sy;
    const z1 = -x * this.sy + z * this.cy;
    // Pitch about x: positive pitch tips the top toward the viewer (we look down on it).
    out[o] = x1;
    out[o + 1] = y * this.cp - z1 * this.sp;
    out[o + 2] = y * this.sp + z1 * this.cp;
  }

  /** World point → view space, relative to the character's center. */
  toView(x: number, y: number, z: number, out: Float32Array, o: number) {
    this.rotate(x - this.center[0], y - this.center[1], z - this.center[2], out, o);
  }
}
