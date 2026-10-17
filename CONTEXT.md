# Driftform

An interactive generative-art piece: a character made of loosely held contour rings floats in an invisible medium. The medium is never drawn. People feel it only through how the character moves when they disturb it. Above everything else, it exists to give people a sense of joyful play.

## Language

### The piece

**Experience**:
One running instance of Driftform, mounted into a host element. It owns nothing outside that element.
_Avoid_: app, widget, scene

**Host**:
The page or element an experience is mounted into: the standalone page, or later the portfolio hero.
_Avoid_: container, parent, site

**Medium**:
The invisible substance the character floats in: water for the octopus, space for the astronaut. It is never rendered.
_Avoid_: water (except when speaking of the octopus specifically), fluid, background, flow field

### Characters

**Character**:
A creature or figure defined purely as data: its rings, how they link, and its rest pose. The engine knows nothing about any specific character.
_Avoid_: model, sprite, figure

**Ring**:
One contour circle in 3D space around part of a character's body (mantle or tentacle). It is drawn as an ellipse.
_Avoid_: point, particle, ellipse (the ellipse is only how a ring appears on screen)

**Mark style**:
How each ring is drawn on screen: a projected ellipse (the default), a dotted ring, or later glyphs. Changing the mark style never changes how the character moves.
_Avoid_: skin, theme, render mode

**Rest pose**:
The shape a character drifts back toward when the medium is calm.
_Avoid_: default shape, base mesh

### Play

**Stir**:
Moving the pointer through the medium. Faster movement disturbs it more.
_Avoid_: hover, repel, push

**Curiosity**:
The character slowly drifting toward a pointer that rests nearby and reaching out to it.
_Avoid_: follow, attract

**Startle**:
The character's reaction to a fast stir close by: it contracts, jets away, then calms and returns.
_Avoid_: flee, repel

**Ripple**:
A radial pulse sent through the medium by a tap or click.
_Avoid_: shockwave, click effect

**Settling**:
The medium calming and the character easing back toward its rest pose after any disturbance.
_Avoid_: reset, decay (decay is a parameter, settling is what people see)

### Later (Phase 2)

**Trickle**:
The morph between characters: rings detach in a staggered cascade, drift through the medium, and settle into the next character's form.
_Avoid_: transition, morph (too generic), tween
