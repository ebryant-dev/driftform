import type { CharacterFactory, LinkDef, NodeDef, RingDef } from './types';
import { lerp, mulberry32, smoothstep } from '../core/math';

// Procedural octopus. The mantle is a bulb on a short spine that leans back;
// eight arms leave a crown just below it, sweep down and out, and curl at
// the tips. Two eyes sit on the collar. All proportions are in mantle radii.

const MANTLE_R = 1;
const MANTLE_HEIGHT = 2.3;
const SPINE_NODES = 6;
const ARM_COUNT = 8;
const ARM_NODES = 13;
const SEED = 11;

/** Mantle silhouette: a narrow collar swelling to a bulb that closes at the top. */
function mantleRadius(u: number) {
  const bulb = Math.sqrt(Math.max(0, 1 - ((u - 0.42) / 0.58) ** 2));
  return MANTLE_R * Math.max(bulb, 0.04);
}

/** Spine leans back (away from the viewer) and a touch sideways as it rises. */
function spinePoint(u: number): [number, number, number] {
  return [0.12 * u * u, u * MANTLE_HEIGHT, -0.75 * u * u];
}

export const createOctopus: CharacterFactory = ({ density }) => {
  const rand = mulberry32(SEED);
  const pos: number[] = [];
  const nodes: NodeDef[] = [];
  const links: LinkDef[] = [];
  const rings: RingDef[] = [];

  const addNode = (p: [number, number, number], part: string, u: number) => {
    pos.push(p[0], p[1], p[2]);
    nodes.push({ part, u });
    return nodes.length - 1;
  };

  /** Hang `count` rings along a chain of node indices, radius from `radiusAt(u)`. */
  const ringChain = (chain: number[], part: string, count: number, radiusAt: (u: number) => number, u0 = 0, u1 = 1) => {
    const segs = chain.length - 1;
    for (let i = 0; i < count; i++) {
      const u = lerp(u0, u1, count === 1 ? 0.5 : i / (count - 1));
      const f = Math.min(u * segs, segs - 1e-6);
      const s = Math.floor(f);
      rings.push({ a: chain[s], b: chain[s + 1], t: f - s, radius: radiusAt(u), part, u });
    }
  };

  // Mantle spine.
  const spine: number[] = [];
  for (let i = 0; i < SPINE_NODES; i++) {
    const u = i / (SPINE_NODES - 1);
    spine.push(addNode(spinePoint(u), 'mantle', u));
    if (i > 0) links.push({ a: spine[i - 1], b: spine[i] });
  }
  ringChain(spine, 'mantle', Math.max(5, Math.round(16 * density)), mantleRadius, 0, 0.97);

  // Eyes: a node sticking out from the collar on each side; rings face outward.
  const eyeU = 0.3;
  const eyeBase = spinePoint(eyeU);
  const eyeR = mantleRadius(eyeU);
  for (const side of [-1, 1]) {
    const ang = side * 0.75; // radians from facing the viewer
    const dir: [number, number, number] = [Math.sin(ang), 0.08, Math.cos(ang)];
    const eye = addNode(
      [eyeBase[0] + dir[0] * eyeR * 0.92, eyeBase[1] + dir[1], eyeBase[2] + dir[2] * eyeR * 0.92],
      side < 0 ? 'eyeL' : 'eyeR',
      1,
    );
    links.push({ a: spine[1], b: eye });
    // Normal runs spine → eye, so the rings face outward like an eye on a dome.
    rings.push({ a: spine[1], b: eye, t: 0.97, radius: 0.24, part: side < 0 ? 'eyeL' : 'eyeR', u: 0 });
    rings.push({ a: spine[1], b: eye, t: 1.03, radius: 0.11, part: side < 0 ? 'eyeL' : 'eyeR', u: 1 });
  }

  // Arms.
  const crownY = -0.12;
  const crownR = 0.5;
  for (let k = 0; k < ARM_COUNT; k++) {
    const theta0 = ((k + 0.5) / ARM_COUNT) * Math.PI * 2 + (rand() - 0.5) * 0.25;
    const length = 3.3 * lerp(0.88, 1.1, rand());
    const sway = (rand() - 0.5) * 0.9; // sideways twist along the arm
    const lift = lerp(0.8, 1.5, rand()); // how far the arm sweeps back up
    const curl = lerp(1.8, 3.2, rand()); // tip curl strength
    const part = `arm${k}`;

    const chain: number[] = [];
    let rho = crownR;
    let y = crownY;
    const step = length / (ARM_NODES - 1);
    for (let i = 0; i < ARM_NODES; i++) {
      const u = i / (ARM_NODES - 1);
      const theta = theta0 + sway * u;
      chain.push(addNode([Math.cos(theta) * rho, y, Math.sin(theta) * rho], part, u));
      if (i > 0) links.push({ a: chain[i - 1], b: chain[i] });
      // Heading in the arm's radial plane: down-and-out first, sweeping
      // outward, then curling up and in at the tip.
      const alpha = -1.05 + lift * Math.pow(u, 1.4) + curl * smoothstep(0.68, 1, u);
      rho += Math.cos(alpha) * step;
      y += Math.sin(alpha) * step;
    }
    links.push({ a: spine[0], b: chain[0] });

    ringChain(chain, part, Math.max(4, Math.round(10 * length * density)), (u) => 0.27 * Math.pow(1 - u, 0.9) + 0.025);
  }

  const rest = new Float32Array(pos);

  // Bounding sphere around the rest pose (center = midpoint of the AABB).
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < rest.length; i += 3) {
    for (let j = 0; j < 3; j++) {
      lo[j] = Math.min(lo[j], rest[i + j]);
      hi[j] = Math.max(hi[j], rest[i + j]);
    }
  }
  const center: [number, number, number] = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
  let extent = 0;
  for (let i = 0; i < rest.length; i += 3) {
    extent = Math.max(extent, Math.hypot(rest[i] - center[0], rest[i + 1] - center[1], rest[i + 2] - center[2]));
  }

  return { name: 'octopus', rest, nodes, links, rings, center, extent: extent + MANTLE_R * 0.3 };
};
