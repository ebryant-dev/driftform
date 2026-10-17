import type { CharacterName } from '../characters';

/**
 * Feel parameters: everything a designer tunes. This is the exact shape the
 * tuning panel exports as JSON, so tuned values can become the defaults.
 */
export interface Settings {
  /** Ring density multiplier. Rebuilds the character when changed. */
  density: number;
  /** Stroke width in CSS px for the nearest rings. */
  strokeWeight: number;
  /** 0 = far rings as strong as near ones, 1 = far rings nearly vanish. */
  depthFade: number;
  /** Solid: an opaque body showing only the front arcs of its rings. Off: ghost, every ring whole. */
  solid: boolean;
  colors: {
    /** Medium color behind the character (ignored when `transparent`). */
    background: string;
    /** Stroke color of the nearest rings. */
    near: string;
    /** Stroke color of the farthest rings. */
    far: string;
  };
  camera: {
    /** Distance from the character; smaller = stronger perspective. */
    distance: number;
    /** Looking down on the character, radians. */
    pitch: number;
    /** Turning the character, radians. */
    yaw: number;
    /** How much of the container's short side the character fills (0–1). */
    framing: number;
  };
}

export interface ExperienceOptions {
  character: CharacterName;
  /** Let the host's design show through instead of painting the medium color. */
  transparent: boolean;
  /** Cap on devicePixelRatio, to keep phones fast. */
  maxDpr: number;
  /** Pause automatically when the container is offscreen or the tab is hidden. */
  autoPause: boolean;
  settings: Settings;
}

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };
export type ExperienceOptionsInput = DeepPartial<ExperienceOptions>;

export const defaultSettings: Settings = {
  density: 1,
  strokeWeight: 0.9,
  depthFade: 0.72,
  solid: true,
  colors: {
    background: '#060b1a',
    near: '#f7f2ea',
    far: '#4a7fd4',
  },
  camera: {
    distance: 14,
    pitch: 0.85,
    yaw: -1.0,
    framing: 0.9,
  },
};

export const defaultOptions: ExperienceOptions = {
  character: 'octopus',
  transparent: false,
  maxDpr: 2,
  autoPause: true,
  settings: defaultSettings,
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Merge `patch` into a copy of `base`, recursing into plain objects. */
export function merge<T>(base: T, patch: DeepPartial<T> | undefined): T {
  if (!patch) return structuredClone(base);
  const out = structuredClone(base) as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? merge(out[k], v) : v;
  }
  return out as T;
}
