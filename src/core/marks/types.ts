/**
 * How a ring is drawn. The renderer hands a mark each visible run of a ring
 * as screen-space points; the mark adds it to the current path, and the
 * renderer strokes or fills. A mark must not stroke or fill itself.
 */
export interface MarkStyle {
  /** 'stroke' marks are outlined with the depth bucket's line width; 'fill' marks are filled. */
  paint: 'stroke' | 'fill';
  /**
   * Add one run: `n` points as x, y pairs in `xy`. `closed` means the run is
   * the whole ring, so it should join back to its start.
   */
  addRun(ctx: CanvasRenderingContext2D, xy: Float32Array, n: number, closed: boolean, lineWidth: number): void;
}
