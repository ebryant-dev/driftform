import type { MarkStyle } from './types';

/** The default mark: the ring's full projected ellipse as one crisp stroke. */
export const ellipseMark: MarkStyle = {
  paint: 'stroke',
  addToPath(ctx, r) {
    // Start the subpath on the ellipse itself so rings sharing a path don't get joined by stray lines.
    ctx.moveTo(r.x + Math.cos(r.rotation) * r.major, r.y + Math.sin(r.rotation) * r.major);
    ctx.ellipse(r.x, r.y, r.major, Math.max(r.minor, 0.01), r.rotation, 0, Math.PI * 2);
  },
};
