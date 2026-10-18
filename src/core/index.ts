import { characters, type CharacterDef } from '../characters';
import { SoftBody, STEP } from './body';
import { GLRenderer } from './gl';
import { Idle } from './idle';
import { Loop } from './loop';
import { defaultOptions, merge, type ExperienceOptions, type ExperienceOptionsInput } from './options';

export type { ExperienceOptions, ExperienceOptionsInput, Settings } from './options';
export { defaultOptions, defaultSettings } from './options';

export interface Experience {
  /** Stop for good: cancels the loop, disconnects observers and listeners, frees the GPU, removes the canvas. */
  destroy(): void;
  pause(): void;
  resume(): void;
  /** Merge new options in. Changing the character reloads it. */
  setOptions(patch: ExperienceOptionsInput): void;
  /** A copy of the current options; `settings` is what the tuning panel exports. */
  getOptions(): ExperienceOptions;
  /** Resolves once the character has loaded and the first frame is drawn. */
  ready: Promise<void>;
}

/**
 * Mount a Driftform experience into `container`. The canvas fills the
 * container; the container's size and position are the host's business.
 * The character loads asynchronously; until then the canvas stays empty,
 * so the host's own design shows through.
 */
export function createExperience(container: HTMLElement, input: ExperienceOptionsInput = {}): Experience {
  let options = merge(defaultOptions, input);
  let destroyed = false;

  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-hidden', 'true');
  canvas.style.cssText = 'display:block;width:100%;height:100%;';
  container.appendChild(canvas);

  const renderer = new GLRenderer(canvas);
  let character: CharacterDef | null = null;
  let body: SoftBody;
  let idle: Idle;
  let target: Float32Array;
  let time = 0; // animation time, scaled by idle speed
  let carry = 0; // physics time not yet stepped
  let loading = 0; // guards against an older load finishing after a newer one

  const load = async () => {
    const ticket = ++loading;
    const next = await characters[options.character]();
    if (destroyed || ticket !== loading) return;
    character = next;
    body = new SoftBody(next);
    idle = new Idle(next);
    target = new Float32Array(next.rest);
    renderer.setCharacter(next);
    idle.pose(time, options.settings.motion, target);
    body.settle(target);
    draw();
  };

  const draw = () => {
    if (character) renderer.draw(body.pos, idle.scale, options.settings, options.transparent, time);
  };

  /** Advance the medium and the body by `dt` seconds of real time. */
  const advance = (dt: number) => {
    if (!character) return;
    const motion = options.settings.motion;
    carry += dt;
    let steps = 0;
    while (carry >= STEP && steps < 8) {
      time += STEP * motion.idleSpeed;
      idle.pose(time, motion, target);
      body.step(target, motion);
      carry -= STEP;
      steps++;
    }
    if (steps === 8) carry = 0; // fell far behind (slow device or long stall): drop the backlog
  };

  let cssW = 0;
  let cssH = 0;
  const loop = new Loop((dt) => {
    // Cheap no-op unless devicePixelRatio changed (window dragged to another display).
    renderer.resize(cssW, cssH, options.maxDpr);
    advance(dt);
    draw();
  });

  const resize = () => {
    const rect = container.getBoundingClientRect();
    cssW = rect.width;
    cssH = rect.height;
    renderer.resize(cssW, cssH, options.maxDpr);
    draw(); // repaint immediately, even while paused, so a resize never shows a blank canvas
  };
  const ro = new ResizeObserver(resize);

  ro.observe(container);
  resize();
  const ready = load();
  if (options.autoPause) loop.watch(container);
  loop.resume();

  return {
    ready,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      loop.stop();
      ro.disconnect();
      renderer.dispose();
      canvas.remove();
    },
    pause() {
      if (!destroyed) loop.pause();
    },
    resume() {
      if (!destroyed) loop.resume();
    },
    setOptions(patch) {
      if (destroyed) return;
      const prev = options;
      options = merge(options, patch);
      if (options.character !== prev.character) void load();
      if (options.autoPause !== prev.autoPause) {
        if (options.autoPause) loop.watch(container);
        else loop.unwatch();
      }
      resize();
    },
    getOptions() {
      return structuredClone(options);
    },
  };
}
