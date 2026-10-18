import { createNoise3D } from 'simplex-noise';
import type { CharacterDef } from '../characters';
import type { Settings } from './options';
import { mulberry32, smoothstep } from './math';

const TAU = Math.PI * 2;
/** One full open-and-close of the web pulse, seconds (see the motion reference: about 6–8 s). */
const PULSE_PERIOD = 7;

interface Chain {
  part: string;
  nodes: number[];
  /** The node on another part this chain hangs from, or -1. */
  parent: number;
  sway: number;
  pulse: boolean;
  uncurl: number;
  phase: number;
  /** Rest segment vectors (node i-1 → i) and the side axis each one bends around. */
  seg: Float32Array;
  side: Float32Array;
  /** The sculpted bend at each joint: axis (unit) and angle, from segment i-1 to i. */
  bendAxis: Float32Array;
  bendAngle: Float32Array;
}

/**
 * The character's life at rest, character-agnostic: it reads the
 * character's motion hints and turns time into a moving target pose for the
 * soft body, plus a breathing scale per node.
 *
 * - Every part bends with slow curvature waves that travel root to tip.
 * - Parts in the pulse open and close together, like an octopus's web.
 * - Sculpted tip curls relax open and now and then curl back.
 * - Breathing parts swell and shrink in a wave.
 * - The whole body slowly turns, tilts and bobs.
 */
export class Idle {
  private chains: Chain[] = [];
  private noise = createNoise3D(mulberry32(7));
  private m = new Float64Array(9);
  private tmp = new Float64Array(9);
  private breatheW: Float32Array;
  private breatheU: Float32Array;
  /** Per node: cross-section scale this frame (breathing). */
  readonly scale: Float32Array;

  constructor(private character: CharacterDef) {
    const { nodes, links, rest, motion } = character;
    const byPart = new Map<string, number[]>();
    nodes.forEach((n, i) => {
      if (!byPart.has(n.part)) byPart.set(n.part, []);
      byPart.get(n.part)!.push(i);
    });
    const rand = mulberry32(31);
    const chainOf = new Map<string, Chain>();
    for (const [part, list] of byPart) {
      list.sort((a, b) => nodes[a].u - nodes[b].u);
      const n = list.length;
      const seg = new Float32Array(n * 3);
      const side = new Float32Array(n * 3);
      const bendAxis = new Float32Array(n * 3);
      const bendAngle = new Float32Array(n);
      for (let i = 1; i < n; i++) {
        const a = list[i - 1] * 3, b = list[i] * 3;
        const dx = rest[b] - rest[a], dy = rest[b + 1] - rest[a + 1], dz = rest[b + 2] - rest[a + 2];
        seg.set([dx, dy, dz], i * 3);
        // Side axis: across the segment, horizontal where possible (segment × up).
        let sx = -dz, sz = dx;
        let sl = Math.hypot(sx, sz);
        if (sl < 1e-6) { sx = 1; sz = 0; sl = 1; }
        side.set([sx / sl, 0, sz / sl], i * 3);
        if (i >= 2) {
          // The sculpted bend at joint i-1: rotation from segment i-1 to segment i.
          const p = seg.subarray((i - 1) * 3, i * 3), q = seg.subarray(i * 3, i * 3 + 3);
          const pl = Math.hypot(p[0], p[1], p[2]), ql = Math.hypot(q[0], q[1], q[2]);
          let kx = p[1] * q[2] - p[2] * q[1], ky = p[2] * q[0] - p[0] * q[2], kz = p[0] * q[1] - p[1] * q[0];
          const kl = Math.hypot(kx, ky, kz);
          if (kl > 1e-9) {
            kx /= kl; ky /= kl; kz /= kl;
            bendAxis.set([kx, ky, kz], i * 3);
            bendAngle[i] = Math.atan2(kl / (pl * ql), (p[0] * q[0] + p[1] * q[1] + p[2] * q[2]) / (pl * ql));
          }
        }
      }
      chainOf.set(part, {
        part, nodes: list, parent: -1,
        sway: motion?.sway?.[part] ?? 0,
        pulse: motion?.pulse?.includes(part) ?? false,
        uncurl: motion?.uncurl?.[part] ?? 0,
        phase: rand() * TAU, seg, side, bendAxis, bendAngle,
      });
    }

    // Walk outward from the trunk: a part hangs from whichever already-placed
    // part its root is linked to. Parents always come before their children,
    // and there can be no cycles.
    const trunk = chainOf.get(motion?.trunk ?? '') ?? [...chainOf.values()].sort((a, b) => b.nodes.length - a.nodes.length)[0];
    const placed = new Set<string>([trunk.part]);
    this.chains.push(trunk);
    for (let i = 0; i < this.chains.length; i++) {
      const inParent = new Set(this.chains[i].nodes);
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

    this.scale = new Float32Array(nodes.length).fill(1);
    this.breatheW = new Float32Array(nodes.length);
    this.breatheU = new Float32Array(nodes.length);
    nodes.forEach((nd, i) => {
      for (const b of motion?.breathe ?? []) {
        if (nd.part !== b.part) continue;
        const span = b.to - b.from;
        this.breatheW[i] = smoothstep(b.from - span * 0.1, b.from + span * 0.2, nd.u) * (1 - smoothstep(b.to - span * 0.1, b.to + 1e-6, nd.u));
        this.breatheU[i] = (nd.u - b.from) / span;
      }
    });
  }

  /** Where the body wants to be at animation time `t` (seconds, already scaled by idle speed). */
  pose(t: number, motion: Settings['motion'], out: Float32Array) {
    const { rest, center, extent, nodes } = this.character;
    const { noise, m, tmp } = this;
    // The web pulse: 0 = arms spread, 1 = arms gathered beneath the body. Eased so it
    // lingers open and closes more briskly, the way the reference does.
    const cycle = (t / PULSE_PERIOD) % 1;
    const gather = Math.pow(Math.sin(Math.PI * cycle), 2.5);

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

      m.set([1, 0, 0, 0, 1, 0, 0, 0, 1]);
      const amp = motion.undulation * c.sway;
      // Each arm keeps its own timing within the shared pulse.
      const myGather = c.pulse ? motion.pulse * (gather + 0.15 * Math.sin(TAU * 0.13 * t + c.phase)) : 0;
      // Tip curl: mostly relaxed open, slowly re-curling now and then.
      const open = c.uncurl * (0.7 + 0.3 * Math.sin(TAU * 0.045 * t + c.phase * 2.3));

      for (let i = 1; i < c.nodes.length; i++) {
        const u = nodes[c.nodes[i]].u;
        const sx0 = c.side[i * 3], sy0 = c.side[i * 3 + 1], sz0 = c.side[i * 3 + 2];

        // The web pulse swings the arm down from its root (and back out).
        if (i === 1 && myGather !== 0) rotate(m, sx0, sy0, sz0, -0.55 * myGather, tmp);
        // Relax part of the sculpted curl, more toward the tip.
        if (open !== 0 && c.bendAngle[i] !== 0) {
          const relax = open * smoothstep(0.45, 0.9, u);
          rotate(m, c.bendAxis[i * 3], c.bendAxis[i * 3 + 1], c.bendAxis[i * 3 + 2], -c.bendAngle[i] * relax, tmp);
        }
        // Curvature waves traveling root to tip; tips bend more than roots.
        if (amp !== 0) {
          const reach = 0.25 + u;
          const n = noise(c.phase, u * 1.3, t * 0.1);
          const bendSide = amp * 0.1 * reach * (Math.sin(TAU * (0.7 * u - 0.08 * t) + c.phase) + 0.7 * n);
          const bendUp = amp * 0.07 * reach * Math.sin(TAU * (0.5 * u - 0.06 * t) + c.phase * 1.7);
          rotate(m, 0, 1, 0, bendSide, tmp);
          rotate(m, sx0, sy0, sz0, bendUp, tmp);
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
      // The body rises a little as the web opens, like a push off the water.
      const bob = d * 0.035 * extent * Math.sin(TAU * 0.043 * t + 0.4) - motion.pulse * 0.03 * extent * gather;
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

    // Breathing: a swell that travels down the breathing stretch.
    for (let i = 0; i < this.scale.length; i++) {
      this.scale[i] = this.breatheW[i] > 0 ? 1 + motion.breath * this.breatheW[i] * Math.sin(TAU * 0.18 * t - this.breatheU[i] * 1.6) : 1;
    }
  }
}

/** m = m · R(axis, angle), axis unit length. `tmp` is scratch. */
function rotate(m: Float64Array, x: number, y: number, z: number, a: number, tmp: Float64Array) {
  if (a === 0) return;
  const c = Math.cos(a), s = Math.sin(a), k = 1 - c;
  const r0 = c + x * x * k, r1 = x * y * k - z * s, r2 = x * z * k + y * s;
  const r3 = y * x * k + z * s, r4 = c + y * y * k, r5 = y * z * k - x * s;
  const r6 = z * x * k - y * s, r7 = z * y * k + x * s, r8 = c + z * z * k;
  for (let i = 0; i < 3; i++) {
    const a0 = m[i * 3], a1 = m[i * 3 + 1], a2 = m[i * 3 + 2];
    tmp[i * 3] = a0 * r0 + a1 * r3 + a2 * r6;
    tmp[i * 3 + 1] = a0 * r1 + a1 * r4 + a2 * r7;
    tmp[i * 3 + 2] = a0 * r2 + a1 * r5 + a2 * r8;
  }
  m.set(tmp);
}
