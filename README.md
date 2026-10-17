# Driftform

An interactive generative-art piece. An octopus made of soft 3D contour rings floats in water you never see — you only feel it through how the octopus moves when you disturb it.

> Work in progress. Phase 1a: the octopus renders at rest. Motion, the medium and play arrive in later phases.

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

exp.pause();
exp.resume();
exp.setOptions({ settings: { strokeWeight: 1.4 } });
exp.destroy(); // removes the canvas, stops the loop, disconnects every observer
```

The canvas fills its container, so size the container however you like.

## Bringing it into an Astro site (later)

Not set up yet; this section is completed in Phase 1e.
