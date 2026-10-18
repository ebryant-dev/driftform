import type { CharacterDef } from './types';

/** The JSON half of a bake (tools/bake_*.py); the binary half holds the mesh. */
export interface BakedHeader {
  name: string;
  parts: string[];
  nodes: { pos: number[]; part: number[]; u: number[] };
  links: number[];
  center: [number, number, number];
  extent: number;
  mesh: {
    vertices: number;
    indices: number;
    indexType: 'uint16' | 'uint32';
    bboxMin: [number, number, number];
    bboxMax: [number, number, number];
    flowMax: number;
    eyeRadius: number;
  };
}

/** Fetch a baked character's mesh and assemble it with its header. */
export async function loadBaked(header: BakedHeader, binUrl: string): Promise<CharacterDef> {
  const res = await fetch(binUrl);
  if (!res.ok) throw new Error(`Driftform: could not load ${binUrl} (${res.status})`);
  const buf = await res.arrayBuffer();
  const n = header.mesh.vertices;
  let o = 0;
  // Copy each block out so every typed array starts aligned.
  const take = (bytes: number) => {
    const part = buf.slice(o, o + bytes);
    o += bytes;
    return part;
  };
  const position = new Int16Array(take(n * 6));
  const attach = new Uint8Array(take(n * 4));
  const weights = new Uint8Array(take(n * 3));
  const flow = new Uint16Array(take(n * 2));
  const eye = new Int16Array(take(n * 4));
  const indices =
    header.mesh.indexType === 'uint16' ? new Uint16Array(take(header.mesh.indices * 2)) : new Uint32Array(take(header.mesh.indices * 4));

  const links = [];
  for (let i = 0; i < header.links.length; i += 2) links.push({ a: header.links[i], b: header.links[i + 1] });

  return {
    name: header.name,
    rest: new Float32Array(header.nodes.pos),
    nodes: header.nodes.part.map((p, i) => ({ part: header.parts[p], u: header.nodes.u[i] })),
    links,
    mesh: {
      vertices: n,
      position,
      attach,
      weights,
      flow,
      eye,
      indices,
      bboxMin: header.mesh.bboxMin,
      bboxMax: header.mesh.bboxMax,
      flowMax: header.mesh.flowMax,
      eyeRadius: header.mesh.eyeRadius,
    },
    center: header.center,
    extent: header.extent,
  };
}
