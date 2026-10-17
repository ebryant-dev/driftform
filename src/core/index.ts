import { characters, type CharacterDef } from '../characters';
import { Loop } from './loop';
import { ellipseMark } from './marks/ellipse';
import { defaultOptions, merge, type ExperienceOptions, type ExperienceOptionsInput } from './options';
import { Renderer } from './render';

export type { ExperienceOptions, ExperienceOptionsInput, Settings } from './options';
export { defaultOptions, defaultSettings } from './options';

export interface Experience {
  /** Stop for good: cancels the loop, disconnects observers and listeners, removes the canvas. */
  destroy(): void;
  pause(): void;
  resume(): void;
  /** Merge new options in. Changing ring density rebuilds the character. */
  setOptions(patch: ExperienceOptionsInput): void;
  /** A copy of the current options; `settings` is what the tuning panel exports. */
  getOptions(): ExperienceOptions;
}

/**
 * Mount a Driftform experience into `container`. The canvas fills the
 * container; the container's size and position are the host's business.
 */
export function createExperience(container: HTMLElement, input: ExperienceOptionsInput = {}): Experience {
  let options = merge(defaultOptions, input);
  let destroyed = false;

  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-hidden', 'true');
  canvas.style.cssText = 'display:block;width:100%;height:100%;';
  container.appendChild(canvas);

  const renderer = new Renderer(canvas, ellipseMark);
  let character: CharacterDef;
  let pos: Float32Array;

  const build = () => {
    character = characters[options.character]({ density: options.settings.density });
    pos = new Float32Array(character.rest);
    renderer.setCharacter(character);
  };

  const draw = () => renderer.draw(character, pos, options.settings, options.transparent);

  let cssW = 0;
  let cssH = 0;
  const loop = new Loop(() => {
    // Cheap no-op unless devicePixelRatio changed (window dragged to another display).
    renderer.resize(cssW, cssH, options.maxDpr);
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

  build();
  renderer.setStyle(options.settings);
  ro.observe(container);
  resize();
  if (options.autoPause) loop.watch(container);
  loop.resume();

  return {
    destroy() {
      if (destroyed) return;
      destroyed = true;
      loop.stop();
      ro.disconnect();
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
      if (options.character !== prev.character || options.settings.density !== prev.settings.density) build();
      if (options.autoPause !== prev.autoPause) {
        if (options.autoPause) loop.watch(container);
        else loop.unwatch();
      }
      renderer.setStyle(options.settings);
      resize();
    },
    getOptions() {
      return structuredClone(options);
    },
  };
}
