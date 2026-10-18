# Driftform

An interactive generative-art piece. An octopus drawn in flowing contour lines floats in water you never see — you only feel it through how the octopus moves when you disturb it. Rendered with WebGL 2 (ADR 0003).

> Work in progress. Phase 1b: the octopus idles (soft body, web pulse, breathing). The medium and play arrive in later phases.

## Run it

```bash
npm install
npm run dev
```

- `/` — standalone, full viewport
- `/embed.html` — test bed: a fake site hero with copy over a transparent canvas

## Use it

```ts
import { createExperience } from './src/core';

const exp = createExperience(document.getElementById('stage')!, {
  background: 'transparent',
});

await exp.ready; // the character loads asynchronously
exp.pause();
exp.resume();
exp.setOptions({ settings: { strokeWeight: 1.4, density: 1.5 } });
exp.destroy(); // stops the loop, disconnects every observer, frees the GPU, removes the canvas
```

The canvas fills its container, so size the container however you like.

## Characters

A character is a sculpted mesh baked in Blender: `tools/bake_octopus.py` writes `src/characters/octopus.{json,bin}` (skeleton, per-vertex skinning, flow coordinate, eye coordinates). Re-bake after changing the sculpt:

```bash
blender --background path/to/octopus-clean.blend --python tools/bake_octopus.py -- src/characters/octopus
```

## Bringing it into an Astro site (later)

Not set up yet; this section is completed in Phase 1e.
