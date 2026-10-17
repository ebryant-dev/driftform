// Embed test bed: mount into a hero region the host owns, over its own background.
import { createExperience } from './core';

const art = document.getElementById('hero-art')!;
const experience = createExperience(art, { transparent: true });

if (import.meta.env.DEV) {
  (window as unknown as { driftform: typeof experience }).driftform = experience;
}
