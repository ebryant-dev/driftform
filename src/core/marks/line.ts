import type { MarkStyle } from './types';

/** The default mark: each visible run of a ring as one crisp line. */
export const lineMark: MarkStyle = {
  paint: 'stroke',
  addRun(ctx, xy, n, closed) {
    ctx.moveTo(xy[0], xy[1]);
    for (let i = 1; i < n; i++) ctx.lineTo(xy[i * 2], xy[i * 2 + 1]);
    if (closed) ctx.closePath();
  },
};
