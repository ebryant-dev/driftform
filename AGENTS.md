# driftform — interactive generative-art piece (satellite repo)

Agent entry point for this repo (`CLAUDE.md` is a symlink to this file). When a session is rooted here, load THIS file — not the workspace root CLAUDE.md.

Edward (Bryant) Hamel goes by **Edward** professionally; close friends/family (and you) call him **Bry**.

## Read the planning folder first

Code lives here. Planning, decisions and progress live in the private workspace repo, kept out of this **public** repo on purpose. Read, by absolute path:

```
/Users/edwardhamel/Dropbox (Personal)/Bryant-AI-Workspace/creative/personal-brand/working/driftform/
  CLAUDE.md
  state/PROJECT-STATE.md   <- current phase, what's verified (source of truth)
  docs/PLAN.md             <- locked decisions, architecture, phases
  state/DECISION-LOG.md
```

In this repo: `CONTEXT.md` (the glossary; use its terms exactly) and `docs/adr/` (architecture decisions).

**This repo is public.** Never commit personal, career or internal planning material here.

## What this project is

A character made of 3D contour rings floats in an invisible medium. People stir, tap and tease it; it reacts with personality, then settles. It runs full-screen on its own page and is designed to mount later into the portfolio hero via `createExperience(container, options)` (ADR 0001).

## Sacred rules (never change without asking Bry)

- **Joyful play outranks everything** — fidelity, physics accuracy, architecture purity.
- **The medium is never drawn.** No cursor circles, no visible field; it's felt only through motion.
- **The engine knows no specific character.** Characters are data.
- **The core never assumes it owns the page.** Everything it touches is inside its container or passed in as an option, and `destroy()` removes all of it.

## Safety

- Never `rm -rf` a directory. Delete only files you created, by exact name.
- Never touch the portfolio repo from here. Deploys and portfolio integration need Bry's go-ahead.
