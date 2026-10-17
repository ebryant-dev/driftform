import { createNoise3D } from 'simplex-noise';
import type { CharacterDef } from '../characters';
import type { Settings } from './options';
import { mulberry32, smoothstep } from './math';

const TAU = Math.PI * 2;

interface Chain {
  part: string;
  nodes: number[];
  /** The node on another part this chain hangs from, or -1. */
  parent: number;
  sway: number;
  phase: number;
  /** Rest segment vectors (node i-1 → i), and the side axis each one bends around. */
  seg: Float32Array;
  side: Float32Array;
}

/** Per-ring effects for one frame: how much each ring swells, and how far it floats off the body. */
export interface RingFx {
  scale: Float32Array;
  offset: Float32Array;
}

/**
 * The character's life at rest, character-agnostic: it reads the character's
 * motion hints and turns time into
 * - a moving target pose for the soft body: every part bends with slow
 *   curvature waves that travel root to tip, and the whole body drifts; and
 * - ring effects: breathing parts swell and shrink in a wave, and every ring
 *   floats a little off its place on smooth noise, so the form never locks.
 */
export class Idle {
  private chains: Chain[] = [];
  private noise = createNoise3D(mulberry32(7));
  private m = new Float64Array(9);
  private tmp = new Float64Array(9);
  /** Per ring: distance to its neighbor rings (float amount), position on its part, and a per-part noise seed. */
  private gap: Float32Array;
  private u: Float32Array;
  private seed: Float32Array;
  private breatheW: Float32Array;
  private breatheU: Float32Array;
  readonly fx: RingFx;

  constructor(private character: CharacterDef) {
    const { nodes, links, rest, rings, motion } = character;
    const byPart = new Map<string, number[]>();
    nodes.forEach((n, i) => {
      if (!byPart.has(n.part)) byPart.set(n.part, []);
      byPart.get(n.part)!.push(i);
    });
    const rand = mulberry32(31);
    const chainOf = new Map<string, Chain>();
    for (const [part, list] of byPart) {
      list.sort((a, b) => nodes[a].u - nodes[b].u);
      const seg = new Float32Array(list.length * 3);
      const side = new Float32Array(list.length * 3);
      for (let i = 1; i < list.length; i++) {
        const a = list[i - 1] * 3, b = list[i] * 3;
        const dx = rest[b] - rest[a], dy = rest[b + 1] - rest[a + 1], dz = rest[b + 2] - rest[a + 2];
        seg.set([dx, dy, dz], i * 3);
        // Side axis: across the segment, horizontal where possible (segment × up).
        let sx = -dz, sy = 0, sz = dx;
        let sl = Math.hypot(sx, sy, sz);
        if (sl < 1e-6) { sx = 1; sz = 0; sl = 1; }
        side.set([sx / sl, sy / sl, sz / sl], i * 3);
      }
      chainOf.set(part, { part, nodes: list, parent: -1, sway: motion?.sway?.[part] ?? 0, phase: rand() * TAU, seg, side });
    }

    // Walk outward from the trunk: a part hangs from whichever already-placed
    // part its root is linked to. Parents always come before their children,
    // and there can be no cycles.
    const trunk = chainOf.get(motion?.trunk ?? '') ?? [...chainOf.values()].sort((a, b) => b.nodes.length - a.nodes.length)[0];
    const placed = new Set<string>([trunk.part]);
    this.chains.push(trunk);
    for (let i = 0; i < this.chains.length; i++) {
      const parentChain = this.chains[i];
      const inParent = new Set(parentChain.nodes);
      for (const l of links) {
        for (const [from, to] of [[l.a, l.b], [l.b, l.a]]) {
          if (!inParent.has(from)) continue;
          const child = chainOf.get(nodes[to].part);
          if (!child || placed.has(child.part) || child.nodes[0] !== to) continue;
          child.parent = from;
          placed.add(child.part);
          this.chains.push(child);
        }
      }
    }
    // Anything not linked to the tree still idles, just without a parent.
    for (const c of chainOf.values()) if (!placed.has(c.part)) this.chains.push(c);

    // Ring spacing from rest positions (node lerp), per part.
    const at = (i: number) => {
      const r = rings[i];
      return [0, 1, 2].map((k) => rest[r.a * 3 + k] + (rest[r.b * 3 + k] - rest[r.a * 3 + k]) * r.t);
    };
    this.gap = new Float32Array(rings.length);
    this.u = new Float32Array(rings.map((r) => r.u));
    const partSeed = new Map<string, number>();
    this.seed = new Float32Array(rings.map((r) => {
      if (!partSeed.has(r.part)) partSeed.set(r.part, partSeed.size * 7.31);
      return partSeed.get(r.part)!;
    }));
    rings.forEach((r, i) => {
      const nb = [i - 1, i + 1].filter((j) => j >= 0 && j < rings.length && rings[j].part === r.part);
      const p = at(i);
      const d = nb.map((j) => { const q = at(j); return Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]); });
      this.gap[i] = d.length ? Math.min(...d) * 1.5 : r.radius * 0.1;
    });
    this.breatheW = new Float32Array(rings.length);
    this.breatheU = new Float32Array(rings.length);
    rings.forEach((r, i) => {
      for (const b of motion?.breathe ?? []) {
        if (r.part !== b.part) continue;
        const span = b.to - b.from;
        // Fade in and out at the ends of the breathing stretch.
        this.breatheW[i] = smoothstep(b.from, b.from + span * 0.25, r.u) * (1 - smoothstep(b.to - span * 0.1, b.to + 1e-6, r.u));
        this.breatheU[i] = (r.u - b.from) / span;
      }
    });
    this.fx = { scale: new Float32Array(rings.length).fill(1), offset: new Float32Array(rings.length * 3) };
  }

  /** Where the body wants to be at animation time `t` (seconds, already scaled by idle speed). */
  pose(t: number, motion: Settings['motion'], out: Float32Array) {
    const { rest, center, extent } = this.character;
    const { noise } = this;
    const { m, tmp } = this;

    for (const c of this.chains) {
      const root = c.nodes[0] * 3;
      // Follow the parent: the chain's root moves with the node it hangs from.
      let ox = 0, oy = 0, oz = 0;
      if (c.parent >= 0) {
        const p = c.parent * 3;
        ox = out[p] - rest[p]; oy = out[p + 1] - rest[p + 1]; oz = out[p + 2] - rest[p + 2];
      }
      out[root] = rest[root] + ox;
      out[root + 1] = rest[root + 1] + oy;
      out[root + 2] = rest[root + 2] + oz;

      // Accumulated rotation down the chain; each segment adds a small bend.
      m.set([1, 0, 0, 0, 1, 0, 0, 0, 1]);
      const amp = motion.undulation * c.sway;
      for (let i = 1; i < c.nodes.length; i++) {
        const u = this.character.nodes[c.nodes[i]].u;
        const reach = 0.25 + u; // tips bend more than roots
        const n = noise(c.phase, u * 1.3, t * 0.12);
        const bendSide = amp * 0.09 * reach * (Math.sin(TAU * (0.8 * u - 0.1 * t) + c.phase) + 0.7 * n);
        const bendUp = amp * 0.06 * reach * Math.sin(TAU * (0.6 * u - 0.07 * t) + c.phase * 1.7);
        if (amp !== 0) {
          rotate(m, 0, 1, 0, bendSide, tmp);
          rotate(m, c.side[i * 3], c.side[i * 3 + 1], c.side[i * 3 + 2], bendUp, tmp);
        }
        const sx = c.seg[i * 3], sy = c.seg[i * 3 + 1], sz = c.seg[i * 3 + 2];
        const a = c.nodes[i - 1] * 3, b = c.nodes[i] * 3;
        out[b] = out[a] + m[0] * sx + m[1] * sy + m[2] * sz;
        out[b + 1] = out[a + 1] + m[3] * sx + m[4] * sy + m[5] * sz;
        out[b + 2] = out[a + 2] + m[6] * sx + m[7] * sy + m[8] * sz;
      }
    }

    // The whole character hangs in the medium: a slow turn, tilt and bob.
    const d = motion.drift;
    if (d !== 0) {
      const yaw = d * 0.14 * Math.sin(TAU * 0.021 * t) + d * 0.06 * noise(9.1, 0, t * 0.05);
      const tilt = d * 0.07 * Math.sin(TAU * 0.017 * t + 1.3);
      const bob = d * 0.035 * extent * Math.sin(TAU * 0.043 * t + 0.4);
      const cy = Math.cos(yaw), sy = Math.sin(yaw), ct = Math.cos(tilt), st = Math.sin(tilt);
      for (let i = 0; i < out.length; i += 3) {
        const x = out[i] - center[0], y = out[i + 1] - center[1], z = out[i + 2] - center[2];
        const x1 = x * cy + z * sy, z1 = -x * sy + z * cy;
        const y2 = y * ct - z1 * st, z2 = y * st + z1 * ct;
        out[i] = center[0] + x1;
        out[i + 1] = center[1] + y2 + bob;
        out[i + 2] = center[2] + z2;
      }
    }
  }

  /** Update `fx` for animation time `t`. */
  rings(t: number, motion: Settings['motion']) {
    const { scale, offset } = this.fx;
    const { noise, breatheW, breatheU } = this;
    for (let i = 0; i < scale.length; i++) {
      // A breath travels down the breathing stretch, slightly behind at the far end.
      scale[i] = breatheW[i] > 0 ? 1 + motion.breath * breatheW[i] * Math.sin(TAU * 0.18 * t - breatheU[i] * 1.6) : 1;
      // Loose float: rings wander along with their neighbors (noise follows position
      // on the part, not ring order) and only by about their own spacing, so
      // contours stay ordered while the form never quite holds still.
      const amt = motion.looseness * this.gap[i];
      const q = this.seed[i] + this.u[i] * 3;
      offset[i * 3] = amt * noise(q, t * 0.25, 0.5);
      offset[i * 3 + 1] = amt * noise(q, t * 0.25, 13.7);
      offset[i * 3 + 2] = amt * noise(q, t * 0.25, 27.1);
    }
  }
}

/** m = m · R(axis, angle), axis unit length. `tmp` is scratch. */
function rotate(m: Float64Array, x: number, y: number, z: number, a: number, tmp: Float64Array) {
  if (a === 0) return;
  const c = Math.cos(a), s = Math.sin(a), k = 1 - c;
  const r = [
    c + x * x * k, x * y * k - z * s, x * z * k + y * s,
    y * x * k + z * s, c + y * y * k, y * z * k - x * s,
    z * x * k - y * s, z * y * k + x * s, c + z * z * k,
  ];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      tmp[i * 3 + j] = m[i * 3] * r[j] + m[i * 3 + 1] * r[3 + j] + m[i * 3 + 2] * r[6 + j];
    }
  }
  m.set(tmp);
}
