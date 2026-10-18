// A character is pure data: a sculpted mesh with per-vertex skinning and
// flow data, the soft-body nodes it's skinned to, and the links between
// them (ADR 0003). The engine never knows which creature it's drawing.

/** Where a node sits on the body: which part, and how far along it (0–1). */
export interface BodyCoord {
  /** e.g. 'body', 'arm3'. Shared names let two characters be matched for the trickle. */
  part: string;
  /** Normalized position along the part, 0 at its root, 1 at its tip. */
  u: number;
}

export interface NodeDef extends BodyCoord {}

export interface LinkDef {
  a: number;
  b: number;
}

/**
 * How a character comes alive at rest. The engine applies these to whatever
 * parts a character names, so it never needs to know what an arm or a mantle is.
 */
export interface MotionHints {
  /** The part everything else hangs from (it has no parent). Other parts attach to it, or to each other, through links. */
  trunk: string;
  /** Parts (or stretches of them, by u) that swell and shrink as the character breathes. */
  breathe?: { part: string; from: number; to: number }[];
  /** Undulation strength per part; parts left out don't undulate (they still follow their parent). */
  sway?: Record<string, number>;
  /** Parts that open and close together in a slow pulse, like an octopus's web. */
  pulse?: string[];
  /** Per part: how much of its sculpted tip curl relaxes open at rest (0 = keeps its curl). */
  uncurl?: Record<string, number>;
}

/** The sculpted surface, ready for the GPU. Layout matches tools/bake_octopus.py. */
export interface CharacterMesh {
  vertices: number;
  /** int16 xyz, quantized within [bboxMin, bboxMax]. */
  position: Int16Array;
  /** Per vertex: node a1, b1, a2, b2 (two chain segments). */
  attach: Uint8Array;
  /** Per vertex: t1, t2 (along each segment) and w (weight of the first), 0–255. */
  weights: Uint8Array;
  /** Per vertex: ring index along the body, quantized to 0–65535 of flowMax. */
  flow: Uint16Array;
  /** Per vertex: 2D position on the nearest eye's plane, quantized to ±32000 of eyeRadius (32767 = not near an eye). */
  eye: Int16Array;
  indices: Uint16Array | Uint32Array;
  bboxMin: [number, number, number];
  bboxMax: [number, number, number];
  flowMax: number;
  eyeRadius: number;
}

export interface CharacterDef {
  name: string;
  /** Rest pose of the nodes, xyz interleaved, world units (y up, +z toward the viewer). */
  rest: Float32Array;
  nodes: NodeDef[];
  links: LinkDef[];
  mesh: CharacterMesh;
  /** Center and radius of the rest pose's bounding sphere, used for framing. */
  center: [number, number, number];
  extent: number;
  motion?: MotionHints;
}

export type CharacterFactory = () => Promise<CharacterDef>;
