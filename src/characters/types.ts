// A character is pure data: soft-body nodes with rest positions, the links
// between them, and the rings that hang on those nodes. The engine never
// knows which creature it's drawing.

/** Where a node or ring sits on the body: which part, and how far along it (0–1). */
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
 * A ring's contour at rest: closed 2D points in the ring's own plane. The
 * plane is centered on `c` and spanned by `N` and `B` (= T × N), where T is
 * the direction along the body. Rings in one part share a point count and a
 * starting angle, so together they form a surface grid.
 */
export interface RingShape {
  /** x, y pairs in the (N, B) plane. */
  pts: Float32Array;
  c: [number, number, number];
  N: [number, number, number];
}

/**
 * One contour ring. It hangs between nodes `a` and `b` at `t`, so it follows
 * the body as the nodes move. Ring density is independent of node count.
 * Without a `shape`, the ring is a circle of `radius`.
 */
export interface RingDef extends BodyCoord {
  a: number;
  b: number;
  t: number;
  radius: number;
  shape?: RingShape;
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
