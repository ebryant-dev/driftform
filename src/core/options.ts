import type { CharacterName } from '../characters';

/**
 * Feel parameters: everything a designer tunes. This is the exact shape the
 * tuning panel exports as JSON, so tuned values can become the defaults.
 */
export interface Settings {
  /** Ring density multiplier: 1 is the designed spacing, 2 doubles the rings. Live, costs nothing. */
  density: number;
  /** Stroke width in CSS px for the nearest rings. */
  strokeWeight: number;
  /** 0 = far rings as strong as near ones, 1 = far rings nearly vanish. */
  depthFade: number;
  /** Solid: an opaque body showing only rings on the side facing you. Off: ghost, back rings show faintly through. */
  solid: boolean;
  /** Solid only: how strongly the hidden far side glows through in blue (0 = fully hidden). */
  backGlow: number;
  colors: {
    /** Medium color behind the character (ignored when `transparent`). */
    background: string;
    /** Stroke color of the nearest rings. */
    near: string;
    /** Stroke color of the farthest rings. */
    far: string;
  };
  motion: {
    /** Overall speed of idle life (breathing, undulation, drift). 0 freezes it. */
    idleSpeed: number;
    /** How much the breathing parts swell and shrink (fraction of their size). */
    breath: number;
    /** Strength of the slow waves that travel down each arm. */
    undulation: number;
    /** How far the whole character bobs and turns as it hangs in the medium. */
    drift: number;
    /** How much the surface shimmers, so the form never quite holds still (0 = still). */
    looseness: number;
    /** Strength of the web pulse: arms gathering beneath the body and spreading again. */
    pulse: number;
    /** Spring pulling the body toward its moving pose; higher = tighter, quicker. */
    stiffness: number;
    /** Share of its motion the body keeps each frame; lower = thicker water. */
    damping: number;
  };
  camera: {
    /** Distance from the character, in character radii; smaller = stronger perspective. */
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
  density: 1.35,
  strokeWeight: 0.8,
  depthFade: 0.25,
  solid: true,
  backGlow: 0.22,
  colors: {
    background: '#060b1a',
    near: '#f4f1ff',
    far: '#3d5fe0',
  },
  motion: {
    idleSpeed: 1,
    breath: 0.05,
    undulation: 1,
    drift: 1,
    looseness: 0.5,
    pulse: 1,
    stiffness: 30,
    damping: 0.92,
  },
  camera: {
    distance: 2.6,
    pitch: 1.25,
    yaw: -0.6,
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
