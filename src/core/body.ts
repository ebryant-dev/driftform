import type { CharacterDef } from '../characters';
import type { Settings } from './options';
import { lerp } from './math';

/** Fixed physics step: steady and frame-rate independent. */
export const STEP = 1 / 120;

/**
 * The soft body: Verlet nodes, each pulled by a spring toward where the
 * moving pose wants it, with links holding segment lengths. Springs weaken
 * toward the tip of every part, so tips lag behind, overshoot and follow
 * through; that lag is what makes the medium feel thick.
 */
export class SoftBody {
  readonly pos: Float32Array;
  private prev: Float32Array;
  private weight: Float32Array;
  private links: Int32Array;
  private lengths: Float32Array;

  constructor(character: CharacterDef) {
    const { rest, nodes } = character;
    this.pos = new Float32Array(rest);
    this.prev = new Float32Array(rest);
    // Tips are held loosely, so they trail and whip rather than hold their shape.
    this.weight = new Float32Array(nodes.map((n) => lerp(1, 0.12, Math.pow(n.u, 0.8))));
    this.links = new Int32Array(character.links.flatMap((l) => [l.a, l.b]));
    this.lengths = new Float32Array(character.links.length);
    character.links.forEach((l, i) => {
      const a = l.a * 3, b = l.b * 3;
      this.lengths[i] = Math.hypot(rest[b] - rest[a], rest[b + 1] - rest[a + 1], rest[b + 2] - rest[a + 2]);
    });
  }

  /** Jump straight to a pose with no motion (first frame, or after a rebuild). */
  settle(target: Float32Array) {
    this.pos.set(target);
    this.prev.set(target);
  }

  step(target: Float32Array, motion: Settings['motion']) {
    const { pos, prev, weight } = this;
    // `damping` is the share of motion kept per 1/60 s; convert to this step.
    const keep = Math.pow(Math.min(Math.max(motion.damping, 0), 0.999), STEP * 60);
    const k = motion.stiffness * STEP * STEP;
    for (let n = 0, i = 0; i < pos.length; n++, i += 3) {
      const w = k * weight[n];
      for (let j = i; j < i + 3; j++) {
        const p = pos[j];
        pos[j] = p + (p - prev[j]) * keep + (target[j] - p) * w;
        prev[j] = p;
      }
    }

    // Links keep segment lengths, softly (half the error, two passes).
    const { links, lengths } = this;
    for (let pass = 0; pass < 2; pass++) {
      for (let l = 0; l < lengths.length; l++) {
        const a = links[l * 2] * 3, b = links[l * 2 + 1] * 3;
        const dx = pos[b] - pos[a], dy = pos[b + 1] - pos[a + 1], dz = pos[b + 2] - pos[a + 2];
        const d = Math.hypot(dx, dy, dz) || 1e-9;
        const f = ((d - lengths[l]) / d) * 0.25;
        pos[a] += dx * f; pos[a + 1] += dy * f; pos[a + 2] += dz * f;
        pos[b] -= dx * f; pos[b + 1] -= dy * f; pos[b + 2] -= dz * f;
      }
    }
  }
}
