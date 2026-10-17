import type { CharacterFactory, MotionHints } from './types';
import { createOctopus } from './octopus';
import { fromSlices, type SlicedCharacterData } from './sliced';
import octopusRings from './octopus.rings.json';

const octopusMotion: MotionHints = {
  trunk: 'body',
  // The mantle sac breathes; the head (the first stretch of the body, from the crown) stays put.
  breathe: [{ part: 'body', from: 0.32, to: 1 }],
  sway: {
    body: 0.35,
    ...Object.fromEntries(Array.from({ length: 8 }, (_, k) => [`arm${k}`, 1])),
  },
};

export const characters = {
  /** Sliced from the sculpted octopus (ADR 0002). */
  octopus: (params) => ({ ...fromSlices(octopusRings as SlicedCharacterData, params), motion: octopusMotion }),
  /** The original procedural octopus, kept as a fallback until the sliced one is settled. */
  proceduralOctopus: (params) => ({
    ...createOctopus(params),
    motion: {
      trunk: 'mantle',
      breathe: [{ part: 'mantle', from: 0.3, to: 1 }],
      sway: { mantle: 0.35, ...Object.fromEntries(Array.from({ length: 8 }, (_, k) => [`arm${k}`, 1])) },
    },
  }),
} satisfies Record<string, CharacterFactory>;

export type CharacterName = keyof typeof characters;
export type { CharacterDef, CharacterFactory, CharacterParams, MotionHints } from './types';
