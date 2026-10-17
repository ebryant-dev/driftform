// A character is pure data: soft-body nodes with rest positions, the links
// between them, and the rings that hang on those nodes. The engine never
// knows which creature it's drawing.

/** Where a node or ring sits on the body: which part, and how far along it (0–1). */
export interface BodyCoord {
  /** e.g. 'mantle', 'arm3', 'eyeL'. Shared names let two characters be matched for the trickle. */
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
 * One contour ring. Its center sits between nodes `a` and `b` at `t`, and its
 * normal points from `a` to `b`, so rings follow the body as the nodes move.
 * Ring density is independent of node count: many rings can share a segment.
 */
export interface RingDef extends BodyCoord {
  a: number;
  b: number;
  t: number;
  radius: number;
}

export interface CharacterDef {
  name: string;
  /** Rest pose, xyz interleaved, world units (y up, +z toward the viewer). */
  rest: Float32Array;
  nodes: NodeDef[];
  links: LinkDef[];
  rings: RingDef[];
  /** Center and radius of the rest pose's bounding sphere, used for framing. */
  center: [number, number, number];
  extent: number;
}

export interface CharacterParams {
  /** Ring density multiplier; 1 is the designed default. */
  density: number;
}

export type CharacterFactory = (params: CharacterParams) => CharacterDef;
