import type { CharacterFactory } from './types';
import { createOctopus } from './octopus';

export const characters = {
  octopus: createOctopus,
} satisfies Record<string, CharacterFactory>;

export type CharacterName = keyof typeof characters;
export type { CharacterDef, CharacterFactory, CharacterParams } from './types';
