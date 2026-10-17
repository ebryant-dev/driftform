# Rings are cross-section curves sliced from a sculpted mesh, not 3D circles

The original brief defined a ring as a circle in 3D space (center, orientation, radius), projected to an ellipse. Phase 1a built exactly that, and the octopus came out as tubes on a stick: every cross-section round, the parts unable to blend at junctions, no web between the arms, and contour lines that restart at every part boundary. The form we want (the reference image in the planning folder) is one continuous sculpted surface whose contour lines flow from the mantle into the arms. So a character's rings are now closed cross-section curves of any shape, sliced at build time from a mesh sculpted in Blender. They're stored in the character's data file as points in each ring's local frame, and attached to the soft-body nodes as before.

## Considered Options

- **Keep circles; add elliptical cross-sections and a procedural web.** Cheapest, but still can't reach a continuous, art-directed form, and every shape decision stays a formula tuned blind. Rejected.
- **Sculpt a mesh and slice it into curves (chosen).** Form is art-directed in a real 3D tool. The engine, physics, play and Canvas 2D rendering are unchanged; only the ring primitive grows from ellipse to closed curve.
- **Render the mesh itself (WebGL).** Truest occlusion, but abandons the vector-contour look and the Canvas 2D decision. Rejected for now; revisit only if painter's-order occlusion artifacts become a problem.

## Consequences

- Rings are drawn as polylines, not `ctx.ellipse()`. Front-facing arcs come from each curve point's surface normal rather than the circle formula.
- Characters get a build step: mesh (`.glb`) → slicing script → ring data. Runtime bundle size and dependencies don't change.
- Ring-to-ring matching for the Phase 2 trickle still works through body coordinates `(part, u)`. Curves of different point counts get resampled to a common count.
- The procedural octopus stays as a fallback until the sliced one replaces it.
