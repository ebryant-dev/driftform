import type { CharacterFactory } from './types';
import { createOctopus } from './octopus';
import { fromSlices, type SlicedCharacterData } from './sliced';
import octopusRings from './octopus.rings.json';

export const characters = {
  /** Sliced from the sculpted octopus (ADR 0002). */
  octopus: (params) => fromSlices(octopusRings as SlicedCharacterData, params),
  /** The original procedural octopus, kept as a fallback until the sliced one is settled. */
  proceduralOctopus: createOctopus,
} satisfies Record<string, CharacterFactory>;

export type CharacterName = keyof typeof characters;
export type { CharacterDef, CharacterFactory, CharacterParams } from './types';
