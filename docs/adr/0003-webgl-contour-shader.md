# Draw contours with a WebGL shader on the deformed mesh

Supersedes ADR 0002, and reverses the brief's choice of Canvas 2D.

ADR 0002 sliced the sculpted octopus into planar contour rings and drew them as polylines on Canvas 2D, hiding back lines by painting rings back to front and erasing what each one covers. It got the form right but failed where the parts meet. Each part was sliced along its own axis, so at the web and the arm roots the slices disagreed: lines crossed, stubbed out or left gaps. Canvas 2D has no depth buffer, so occlusion had to be estimated per ring from its center depth, which is exactly what breaks where forms merge. And at 720 rings, it cost about 4.4 ms per frame on desktop CPU, too heavy for phones.

Now the sculpted mesh itself is rendered with WebGL. Each vertex carries a baked **flow coordinate**: distance along the body from the arm crown, up through the head and mantle and out along each arm. A fragment shader draws an antialiased line of constant screen width wherever that coordinate crosses evenly spaced values. Because one continuous field covers the whole surface, contours flow from the mantle through the web into the arms without restarting. The depth buffer handles occlusion exactly, and the line count is a uniform, so density costs nothing and is live-tunable. The soft body and idle motion are unchanged; they now deform the mesh by skinning each vertex to its nearest nodes, instead of carrying rings.

## Considered Options

- **Keep Canvas 2D; re-slice along one continuous field.** Better line flow at the junction, but occlusion stays approximate and the cost stays on the CPU. Rejected.
- **WebGL contour shader on the mesh (chosen).** Exact occlusion, continuous lines, GPU-cheap on phones, still a crisp vector look (constant-width antialiased lines, depth fade, rim shading).

## Consequences

- WebGL is required. If a device lacks it, the experience shows nothing; the host's own design shows through. That's acceptable for a decorative hero.
- Rings are no longer individual objects. The Phase 2 trickle (rings detaching in a cascade) has to be redesigned. The likely route is cutting the mesh into one strip per contour band, so strips can detach. Body coordinates `(part, u)` still match characters.
- Characters are a mesh plus baked per-vertex data (flow coordinate, node weights), produced at build time by a Blender script. `tools/slice_octopus.py` and the ring renderer are retired.
- The glossary term **ring** now means one contour line drawn on the surface, not a stored object. **Mark style** becomes a shader option.
- `destroy()` must also release the WebGL context.
