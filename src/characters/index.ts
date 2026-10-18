import type { CharacterFactory, MotionHints } from './types';
import { loadBaked, type BakedHeader } from './baked';
import octopusHeader from './octopus.json';
import octopusBin from './octopus.bin?url';

const arms = (v: number) => Object.fromEntries(Array.from({ length: 8 }, (_, k) => [`arm${k}`, v]));

const octopusMotion: MotionHints = {
  trunk: 'body',
  // The mantle sac breathes; the head (the first stretch of the body, from the crown) stays put.
  breathe: [{ part: 'body', from: 0.32, to: 1 }],
  sway: { body: 0.35, ...arms(1) },
  // The web pulse: arms spread and close together (see the motion reference).
  pulse: Object.keys(arms(1)),
  // The sculpt's hooks relax most of the way open; live tips trail loosely.
  uncurl: arms(0.7),
};

export const characters = {
  /** The sculpted octopus (ADR 0003). */
  octopus: async () => ({ ...(await loadBaked(octopusHeader as unknown as BakedHeader, octopusBin)), motion: octopusMotion }),
} satisfies Record<string, CharacterFactory>;

export type CharacterName = keyof typeof characters;
export type { CharacterDef, CharacterFactory, CharacterMesh, MotionHints } from './types';
