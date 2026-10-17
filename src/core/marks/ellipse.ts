import type { MarkStyle } from './types';

/** The default mark: the ring's visible arc of its projected ellipse, as one crisp stroke. */
export const ellipseMark: MarkStyle = {
  paint: 'stroke',
  addToPath(ctx, r) {
    // Start the subpath on the ellipse itself so rings sharing a path don't get joined by stray lines.
    const minor = Math.max(r.minor, 0.01);
    const ex = Math.cos(r.arcStart) * r.major;
    const ey = Math.sin(r.arcStart) * minor;
    const c = Math.cos(r.rotation), s = Math.sin(r.rotation);
    ctx.moveTo(r.x + ex * c - ey * s, r.y + ex * s + ey * c);
    ctx.ellipse(r.x, r.y, r.major, minor, r.rotation, r.arcStart, r.arcEnd);
  },
};
