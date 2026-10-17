// Standalone page: the experience fills the viewport.
import { createExperience } from './core';

const stage = document.getElementById('stage')!;
const experience = createExperience(stage);

if (import.meta.env.DEV) {
  (window as unknown as { driftform: typeof experience }).driftform = experience;
}
