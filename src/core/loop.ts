/**
 * requestAnimationFrame loop with three independent reasons to stop:
 * the host paused it, the container is offscreen, or the tab is hidden.
 * It runs only when none apply.
 */
export class Loop {
  private raf = 0;
  private last = 0;
  private userPaused = false;
  private offscreen = false;
  private hidden = typeof document !== 'undefined' && document.hidden;
  private io?: IntersectionObserver;
  private onVisibility = () => {
    this.hidden = document.hidden;
    this.sync();
  };

  constructor(private tick: (dt: number, time: number) => void) {}

  /** Watch `el`'s visibility and the tab's, pausing automatically. */
  watch(el: Element) {
    document.addEventListener('visibilitychange', this.onVisibility);
    this.io = new IntersectionObserver((entries) => {
      this.offscreen = !entries[entries.length - 1].isIntersecting;
      this.sync();
    });
    this.io.observe(el);
  }

  unwatch() {
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.io?.disconnect();
    this.io = undefined;
    this.offscreen = false;
    this.hidden = false;
    this.sync();
  }

  get running() {
    return this.raf !== 0;
  }

  pause() {
    this.userPaused = true;
    this.sync();
  }

  resume() {
    this.userPaused = false;
    this.sync();
  }

  stop() {
    this.userPaused = true;
    this.unwatch();
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private sync() {
    const shouldRun = !this.userPaused && !this.offscreen && !this.hidden;
    if (shouldRun && !this.raf) {
      this.last = performance.now();
      this.raf = requestAnimationFrame(this.frame);
    } else if (!shouldRun && this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
  }

  private frame = (now: number) => {
    // Clamp dt so a long stall (debugger, slow frame) never explodes the physics.
    const dt = Math.min((now - this.last) / 1000, 1 / 20);
    this.last = now;
    this.raf = requestAnimationFrame(this.frame);
    this.tick(dt, now / 1000);
  };
}
