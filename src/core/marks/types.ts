/** A ring after projection: a screen-space ellipse plus how near it is (0 far … 1 near). */
export interface ProjectedRing {
  x: number;
  y: number;
  /** Semi-axes in CSS px. `minor` shrinks as the ring turns edge-on to the camera. */
  major: number;
  minor: number;
  rotation: number;
  near: number;
  /** The visible part of the ellipse, as canvas ellipse angles. 0…2π when the whole ring shows. */
  arcStart: number;
  arcEnd: number;
}

/**
 * How a ring is drawn. Marks only add to the current path; the renderer
 * strokes or fills once per depth bucket, so a mark must not stroke itself.
 */
export interface MarkStyle {
  /** 'stroke' marks are outlined with the bucket's line width; 'fill' marks are filled. */
  paint: 'stroke' | 'fill';
  addToPath(ctx: CanvasRenderingContext2D, ring: ProjectedRing, lineWidth: number): void;
}
