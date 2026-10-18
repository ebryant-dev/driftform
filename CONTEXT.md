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
One contour line around a character's body, like a line on a topographic map. Rings are evenly spaced along the body and flow without a break from the mantle into the arms.
_Avoid_: point, particle, ellipse, circle, slice

**Mark style**:
How each ring is drawn on screen: a solid line (the default), a dotted line, or later glyphs. Changing the mark style never changes how the character moves.
_Avoid_: skin, theme, render mode

**Solid**:
The look where the character's body is opaque: each ring shows only the arc facing the viewer, and nearer parts of the body hide farther ones.
_Avoid_: occluded, hidden-line mode, opaque mode

**Ghost**:
The see-through look: every ring is drawn whole, front and back.
_Avoid_: transparent (that word belongs to the host background), wireframe, x-ray

**Flow coordinate**:
How far along the body a point on its surface is, measured from the arm crown up through the mantle and out along each arm. Rings are drawn where it crosses evenly spaced values.
_Avoid_: u, distance field, parameter

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
