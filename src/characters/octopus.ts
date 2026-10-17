import type { CharacterFactory, LinkDef, NodeDef, RingDef } from './types';
import { lerp, mulberry32, smoothstep } from '../core/math';

// Procedural octopus, drawn from anatomy rather than a cartoon:
// - the body is a head (where the arms and eyes are) continuing into a
//   mantle sac that leans back and droops behind it, slightly off-axis;
// - the eyes are small raised turrets on the upper sides of the head;
// - eight long arms, thick at the base and hair-fine at the tip, each with
//   its own length, sinuous S-curves and tip curl.
// Proportions are in head radii.

const SPINE_NODES = 9;
const ARM_COUNT = 8;
const ARM_NODES = 24;
const SEED = 23;

/**
 * Body profile from the arm crown (u=0) to the mantle tip (u=1), as
 * designed control points: a broad head, a barely-there waist behind the
 * eyes, the mantle sac swelling past it, then closing to a soft point.
 */
const PROFILE: [number, number][] = [
  [0, 0.62], [0.1, 0.78], [0.2, 0.8], [0.3, 0.78], [0.45, 1.0],
  [0.6, 1.16], [0.75, 1.1], [0.88, 0.82], [0.96, 0.45], [1, 0.05],
];

function bodyRadius(u: number) {
  let i = 0;
  while (i < PROFILE.length - 2 && u > PROFILE[i + 1][0]) i++;
  const [u0, r0] = PROFILE[i];
  const [u1, r1] = PROFILE[i + 1];
  return lerp(r0, r1, smoothstep(u0, u1, u));
}

/** Spine: rises from the crown, then bends back and droops, so the sac trails behind the head. */
function spinePath(): [number, number, number][] {
  const pts: [number, number, number][] = [];
  const steps = 64;
  const length = 4.4;
  let x = 0, y = 0, z = 0;
  for (let i = 0; i <= steps; i++) {
    const u = i / steps;
    pts.push([x, y, z]);
    // Angle from vertical, leaning back (−z) and a little sideways.
    const lean = 0.3 + 1.2 * smoothstep(0.12, 0.7, u);
    const side = 0.18 * smoothstep(0.3, 1, u);
    const ds = length / steps;
    x += Math.sin(side) * ds;
    y += Math.cos(lean) * ds;
    z -= Math.sin(lean) * ds;
  }
  return pts;
}

function sampleSpine(path: [number, number, number][], u: number): [number, number, number] {
  const f = u * (path.length - 1);
  const i = Math.min(Math.floor(f), path.length - 2);
  const t = f - i;
  return [0, 1, 2].map((k) => lerp(path[i][k], path[i + 1][k], t)) as [number, number, number];
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

  /**
   * Hang `count` rings along a chain of node indices, radius from `radiusAt(u)`.
   * Spacing wanders a little so the contours never look machine-ruled.
   */
  const ringChain = (chain: number[], part: string, count: number, radiusAt: (u: number) => number, u0 = 0, u1 = 1) => {
    const segs = chain.length - 1;
    const step = (u1 - u0) / Math.max(count - 1, 1);
    for (let i = 0; i < count; i++) {
      const jitter = i > 0 && i < count - 1 ? (rand() - 0.5) * step * 0.2 : 0;
      const u = u0 + i * step + jitter;
      const f = Math.min(u * segs, segs - 1e-6);
      const s = Math.floor(f);
      rings.push({ a: chain[s], b: chain[s + 1], t: f - s, radius: radiusAt(u), part, u });
    }
  };

  // Body: head + mantle sac on one spine.
  const path = spinePath();
  const spine: number[] = [];
  for (let i = 0; i < SPINE_NODES; i++) {
    const u = i / (SPINE_NODES - 1);
    spine.push(addNode(sampleSpine(path, u), 'body', u));
    if (i > 0) links.push({ a: spine[i - 1], b: spine[i] });
  }
  ringChain(spine, 'body', Math.max(8, Math.round(56 * density)), bodyRadius, 0.02, 0.985);

  // Eyes: small turrets on the upper sides of the head, angled up and out.
  const eyeU = 0.2;
  const eyeBase = sampleSpine(path, eyeU);
  const eyeR = bodyRadius(eyeU);
  const spineSeg = Math.round(eyeU * (SPINE_NODES - 1));
  for (const side of [-1, 1]) {
    const ang = side * 0.8; // radians around the head from facing the viewer
    const dir = [Math.sin(ang), 0.35, Math.cos(ang)];
    const dl = Math.hypot(dir[0], dir[1], dir[2]);
    const part = side < 0 ? 'eyeL' : 'eyeR';
    const eye = addNode(
      [eyeBase[0] + (dir[0] / dl) * eyeR, eyeBase[1] + (dir[1] / dl) * eyeR, eyeBase[2] + (dir[2] / dl) * eyeR],
      part,
      1,
    );
    links.push({ a: spine[spineSeg], b: eye });
    // A low dome: the outer ring sits just inside the skin, the inner one slightly proud of it.
    rings.push({ a: spine[spineSeg], b: eye, t: 0.96, radius: 0.17, part, u: 0 });
    rings.push({ a: spine[spineSeg], b: eye, t: 1.03, radius: 0.1, part, u: 1 });
  }

  // Arms: they leave a thick, webbed crown and splay out nearly flat, each
  // wandering in its own S-curve before winding into a tight spiral at the tip.
  const crownY = -0.1;
  const crownR = 0.3;
  for (let k = 0; k < ARM_COUNT; k++) {
    const theta0 = ((k + 0.5) / ARM_COUNT) * Math.PI * 2 + (rand() - 0.5) * 0.35;
    const length = lerp(4.0, 5.4, rand());
    const droop = lerp(-0.9, -0.45, rand()); // initial pitch below horizontal
    const settle = lerp(-0.25, 0.1, rand()); // pitch the arm settles to once it has spread
    const wave = lerp(0.25, 0.5, rand()); // sideways S-curve swing (radians of heading)
    const freq = lerp(0.8, 1.6, rand()); // S-curves along the arm
    const phase = rand() * Math.PI * 2;
    const spiral = lerp(6, 10, rand()) * (rand() < 0.5 ? 1 : -1); // tip curl, winding left or right
    const rootR = lerp(0.3, 0.36, rand());
    const part = `arm${k}`;

    const chain: number[] = [];
    let x = Math.cos(theta0) * crownR;
    let z = Math.sin(theta0) * crownR;
    let y = crownY;
    let curl = 0; // accumulated tip curl
    const step = length / (ARM_NODES - 1);
    // Integrate finely between nodes so curvature stays smooth.
    const sub = 8;
    for (let i = 0; i < ARM_NODES; i++) {
      const u = i / (ARM_NODES - 1);
      chain.push(addNode([x, y, z], part, u));
      if (i > 0) links.push({ a: chain[i - 1], b: chain[i] });
      if (i === ARM_NODES - 1) break;
      for (let j = 0; j < sub; j++) {
        const uu = (i + j / sub) / (ARM_NODES - 1);
        const ds = step / sub;
        const pitch = lerp(droop, settle, smoothstep(0, 0.45, uu));
        // Heading swings around the arm's radial direction in S-curves (so the
        // arms keep radiating), plus a curl that tightens toward the tip.
        curl += spiral * Math.pow(smoothstep(0.72, 1, uu), 1.5) * ds;
        const heading = theta0 + wave * (Math.sin(Math.PI * 2 * freq * uu + phase) - Math.sin(phase)) * smoothstep(0.03, 0.3, uu) + curl;
        x += Math.cos(pitch) * Math.cos(heading) * ds;
        z += Math.cos(pitch) * Math.sin(heading) * ds;
        y += Math.sin(pitch) * ds;
      }
    }
    links.push({ a: spine[0], b: chain[0] });

    ringChain(chain, part, Math.max(6, Math.round(14 * length * density)), (u) => rootR * Math.pow(1 - u, 1.15) + 0.022);
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

  return { name: 'octopus', rest, nodes, links, rings, center, extent: extent + 0.3 };
};
