# Expose a plain function API, not a web component

Driftform has to run full-screen on its own page now, and inside the portfolio's Astro hero later. Fridgeface, the sibling project, ships as a custom element with Shadow DOM. Driftform instead exposes one function, `createExperience(container, options)`, which returns `{ destroy, pause, resume, setOptions, getOptions }` and mounts a single canvas into an element the host owns. A web component earns its keep when it has its own styles and UI to isolate. Driftform is one canvas with almost no CSS. Its embed mode also has to cooperate closely with the host: read pointer movement from the hero section rather than from itself, sit under the host's text and buttons, and be torn down cleanly by Astro page transitions. All of that is simpler as explicit options and an explicit `destroy()` than as attributes and element lifecycle callbacks.

## Considered Options

- **Custom element (the Fridgeface pattern).** Consistent across the two projects, but it adds Shadow DOM and attribute plumbing for no isolation benefit, and a hero would still need imperative access to `pause()` and `setOptions()`. Rejected.
- **Plain function API.** Framework-agnostic, trivial to wrap in an Astro component's `<script>`, and lifecycle is explicit. Chosen.

## Consequences

- Hosts write a small wrapper: a container element plus a script that calls `createExperience` and calls `destroy()` on `astro:before-swap`. The README documents it.
- A custom element can still be layered on top later if it's ever wanted. The reverse would be harder.
