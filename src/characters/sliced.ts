import type { CharacterDef, CharacterParams, RingDef } from './types';

/** The JSON written by tools/slice_*.py (see ADR 0002). */
export interface SlicedCharacterData {
  name: string;
  parts: string[];
  nodes: { pos: number[]; part: number[]; u: number[] };
  links: number[];
  rings: {
    part: number;
    u: number;
    a: number;
    b: number;
    t: number;
    c: number[];
    T: number[];
    N: number[];
    pts: number[];
  }[];
}

const v3 = (a: number[]): [number, number, number] => [a[0], a[1], a[2]];

/**
 * Turn sliced data into a character. Density below 1 thins the rings evenly
 * within each part (always keeping each part's first and last ring); above 1
 * it has nothing more to add, since density is baked in at slicing time.
 */
export function fromSlices(data: SlicedCharacterData, { density }: CharacterParams): CharacterDef {
  const nodes = data.nodes.part.map((p, i) => ({ part: data.parts[p], u: data.nodes.u[i] }));
  const links = [];
  for (let i = 0; i < data.links.length; i += 2) links.push({ a: data.links[i], b: data.links[i + 1] });

  const keep = Math.min(1, Math.max(0.05, density));
  const rings: RingDef[] = [];
  let acc = 0;
  data.rings.forEach((r, i) => {
    const first = i === 0 || data.rings[i - 1].part !== r.part;
    const last = i === data.rings.length - 1 || data.rings[i + 1].part !== r.part;
    if (first) acc = 0;
    acc += keep;
    if (!first && !last && acc < 1) return;
    acc -= Math.floor(acc);
    let radius = 0;
    for (let k = 0; k < r.pts.length; k += 2) radius = Math.max(radius, Math.hypot(r.pts[k], r.pts[k + 1]));
    rings.push({
      part: data.parts[r.part],
      u: r.u,
      a: r.a,
      b: r.b,
      t: r.t,
      radius,
      shape: { pts: new Float32Array(r.pts), c: v3(r.c), N: v3(r.N) },
    });
  });

  // Bounding sphere over every contour point at rest.
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  const pts: number[] = [];
  for (const r of data.rings) {
    const T = r.T, N = r.N;
    const B = [T[1] * N[2] - T[2] * N[1], T[2] * N[0] - T[0] * N[2], T[0] * N[1] - T[1] * N[0]];
    for (let k = 0; k < r.pts.length; k += 2) {
      for (let j = 0; j < 3; j++) {
        const v = r.c[j] + N[j] * r.pts[k] + B[j] * r.pts[k + 1];
        pts.push(v);
        lo[j] = Math.min(lo[j], v);
        hi[j] = Math.max(hi[j], v);
      }
    }
  }
  const center: [number, number, number] = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
  let extent = 0;
  for (let i = 0; i < pts.length; i += 3) {
    extent = Math.max(extent, Math.hypot(pts[i] - center[0], pts[i + 1] - center[1], pts[i + 2] - center[2]));
  }

  return { name: data.name, rest: new Float32Array(data.nodes.pos), nodes, links, rings, center, extent };
}
