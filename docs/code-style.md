# Code style: written for people

AGstudio is read far more often than it is written, by its owner, by plugin authors and by AI agents. Code should be
easy for a person to follow on a first read. These rules apply to all new code and to readability passes.

## Names
- A name says what the thing is, in plain words: `deckIndex`, `sampleRate`, `channelStrip`, not `idx`, `sr`, `chan`.
- Short names are fine only where they are universal: loop counters (`i`, `j`), coordinates (`x`, `y`), and math in DSP
  code that mirrors a cited formula (then name the formula in a comment).
- Units go in the name when the type can't carry them: `fadeMs`, `gainDb`, `startTick`, `durationSec`, `cutoffHz`.
- Booleans read as questions: `isPlaying`, `hasLoop`, `canRecord`.
- Avoid boolean parameters at call sites (`render(true)`): use an options object (`render({ offline: true })`).

## Files and functions
- One file, one job. When a file passes ~500 lines, look for a second job hiding in it and move it to its own module.
  Split by responsibility (the graph lifecycle, the cue logic, the recording), never into arbitrary "part 2" files.
- A function does one thing and fits on a screen (~40 lines as a guide). Name the steps by extracting small helpers.
- Prefer early returns over deep nesting. No nested ternaries. One statement per line.
- Don't pack several steps into one clever expression; a few named locals read better.

## Comments
- Every exported function, type and constant has a short doc comment in plain English, with units.
- Comments say *why* (the reason, the trap avoided, the spec followed), not *what* the next line does.
- Keep the repo's tone: full sentences, plain words, no jargon the musician-facing docs wouldn't use without explaining.

## Structure
- Types over loose objects; a named type for anything passed between modules.
- Magic numbers become named constants next to where they're used, with units and a reason.
- Keep layers and aliases as `CLAUDE.md` describes; readability work never crosses a layer boundary.

## Readability passes
- They never change behaviour. Tests stay green before and after, and nothing user-visible changes.
- Hot paths and audio-thread code stay as fast as before: no new allocation in `process()`, no extra work per frame.
- Public SDK names (`@agstudio/sdk*`) and stored data shapes (project files, IndexedDB keys) don't change: user plugins
  and saved projects depend on them.
- Keep diffs reviewable: one module or one concern per commit.
