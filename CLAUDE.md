# AGstudio

An FL Studio-style DAW that runs in Chrome (TypeScript, React, Web Audio + AudioWorklet), built so its owner
can keep adding features and, above all, their own instruments and effects as code plugins.

Read `docs/architecture.md` before making structural changes. Write code the way `docs/code-style.md` describes (plain names, small
files and functions, comments that say why). The plugin author guide is `docs/plugin-sdk.md`.

## Commands

On the owner's Mac, Node is at `~/.local/node/bin`, which is not on PATH: prefix shell commands with
`export PATH="$HOME/.local/node/bin:$PATH";`. That is specific to that machine: on Windows (and anywhere Node is installed the normal
way) `node` and `npm` are on the PATH already. AGstudio runs on Windows 10/11 too (Chrome or Edge): see "Windows" below.

- `npm run dev`: dev server (port 5390 by default, or `$PORT`). `bin/agstudio` (linked as `agstudio` in ~/.local/bin;
  `bin\agstudio.cmd` on Windows) starts it and opens the browser, or just opens it when it is already running. Both are thin
  wrappers that find Node and run `scripts/agstudio.mjs`, where the logic is.
- `npm run check`: everything CI would run (`scripts/check.mjs`): `tsc -b` (all five tsconfigs, incremental) and `eslint .`
  (cached) side by side, then four test stages one after the other: the unit project and the audio project (many files side by
  side, without the quiet-machine tests), then those quiet-machine tests alone, one file at a time: first in Node
  (`unit-timing`), then in Chrome (`audio-realtime`). A warm run with nothing changed spends seconds on the static checks.
- `npm test`: unit tests only (Node), every test. `npm run test:audio`: browser tests in headless Chrome (installed Chrome, no
  download), every test. Both run all the tests of their project side by side, as the stages of `check` do not.
- Two tags mark the tests that cannot share the machine with other tests: `perf` (asserts on speed, CPU cost or memory) and
  `realtime` (needs a live audio clock: a realtime AudioContext that must keep up, a loopback recording, playing while
  something changes). Put `{ tags: ['realtime'] }` in the options of the `it` or `describe`; the files that carry a tag are found
  by `tools/test/quiet-files.ts` and run last, sequentially (`scripts/lib/test-stages.mjs`, `vite.config.ts`). A realtime test
  that fails because the machine was overloaded (not because the code is wrong) is retried and, if every attempt was
  overloaded, skipped with the numbers: `retryWhenOverloaded` in `test/helpers/overload.ts`.
- `npm run test:perf`: only the tests tagged `perf` (speed assertions), with their real limits (`VITE_PERF_STRICT`); run it
  on a quiet machine. The regular run keeps loose bounds for them. Speed assertions use `cpuNow`/`settle` from
  `@agstudio/sdk/testing` (CPU time, best of a few attempts), never a single wall-clock sample. UI tests wait for a condition
  (`expect.poll`, `until`), never for a fixed number of frames or milliseconds, before they assert.
- `agstudio --app` (`bin/agstudio`): serves the production build on port 5391 (`$APP_PORT`) and opens the installed app; the
  installed app (PWA, `docs/architecture.md` "Installable app (PWA)") belongs to that origin, not to the dev server's.
- `npm run new:plugin -- --kind instrument|effect --style graph|worklet|faust --id user.my-thing`: scaffold a user plugin
  into `plugins/` (templates in `templates/`, guide in `docs/plugin-sdk.md`).

## Layers (enforced by ESLint `no-restricted-imports` + separate tsconfigs)

| Folder | What | May import |
|---|---|---|
| `src/sdk` | Public plugin API (`@agstudio/sdk`, `/params`, `/worklet`, `/dsp`, `/notes`, `/faust`, `/ui`) | react only in `sdk/ui` |
| `src/core` | Model, ops, history, time, queries, commands/keymap, schema, io. **No DOM** (tsconfig.core has no DOM lib) | immer, fflate, `@agstudio/sdk/params` |
| `src/engine` | Web Audio engine, scheduler, reconcile, offline render | core, sdk |
| `src/plugins/builtin` | Built-in instruments/effects | `@agstudio/sdk*` and react only |
| `src/platform` | File System Access, OPFS, IndexedDB, Web Locks | core |
| `src/sw` | The service worker (`sw.ts`, bundled into `dist/sw.js` by `tools/pwa`) and its pure routing; production only, never registered in dev | nothing (`tsconfig.sw.json`, WebWorker lib) |
| `src/app` | Composition root (`services.ts`), stores, persistence, plugin discovery | core, sdk, engine, platform |
| `src/ui` | React shell, workspace, canvases, `features/*` | core, sdk, app, `@engine/api` (types) |
| `plugins/` | User plugins (folders starting with `_` are ignored) | `@agstudio/sdk*`, react |

Cross-layer imports always use aliases (`@core/…`, `@engine/…`, `@app/…`, `@ui/…`, `@agstudio/sdk…`), never `../../`.

## Rules that are easy to break

- **Every document change goes through History** (`core/history`): `transact()` for one-shot edits, `gesture()` for drags
  (one undo entry per drag). Never write the project store directly. View/session state is not undoable.
- **Long-lived objects are created in `app/services.ts`**, never in React effects (StrictMode runs them twice).
- **Hot paths bypass React**: playhead, meters, drags and canvas redraws run on `ui/frame-loop.ts` or imperative
  controllers. Idle playback should cause zero React commits.
- **Built-in plugins use only the public SDK.** If a built-in needs something, add it to the SDK.
- **Audio-thread code** (`*.worklet.ts`, `src/sdk/worklet`, `src/sdk/dsp`): no DOM, no `import.meta.hot`, no dynamic
  import, no fetch, no npm deps, no allocation inside `process()`. Load processors with
  `import url from './x.worklet.ts?worker&url'` (never `new URL('./x.ts', import.meta.url)`; it breaks in production).
- Ticks are integers at **PPQ 960** (a 1/16 step = 240 ticks). Convert to seconds only through the TempoMap.
- Kernel and shared `params.ts` files must not contain React components (they are excluded from React Refresh
  in `vite.config.ts`); name pure DSP files `kernel.ts` or `*.kernel.ts`.
- `services.engine` is an `EngineHost` proxy: always go through it (never cache the inner engine) so engine
  reboots after worklet edits are transparent.
- **Unused audio is cleaned up** (`app/storage`, see architecture.md): a blob is kept while any stored value mentions its
  hash. Keep sample hashes in the project, an autosave or the IndexedDB `kv` store, write blobs only through the sample
  store (`defaultSampleStore()`), and wrap long work that reads a project in `whileBusy(…, { project })`.
- Assets must be self-hosted: the dev/preview servers send COOP/COEP headers (cross-origin isolation).

## Windows

Keep it working there, from the Mac: no Unix-only shell syntax in `package.json` or scripts (`VAR=value cmd`, `&&` chains, `rm`, `cp`);
start tools with `process.execPath` and their JS file (`scripts/lib/tools.mjs`), never `npm`/`npx`/`.bin/*` without a shell; build file paths
with `path.join` / `fileURLToPath` / `os.homedir()`, never a hard-coded `/` or `~`; spawn command line tools through `tools/platform`
(`planSpawn`, `cliCandidates`); name keys with `ui/shortcut-label.ts` or `formatChord`, never a literal ⌘. New code that depends on
the system takes the platform as an argument so a unit test can pass `win32`. Details: `docs/architecture.md`, "Windows, macOS and Linux".

## Adding a feature

Create `src/ui/features/<name>/register.ts` exporting `register(services)`. It is picked up automatically
(`src/ui/features/index.ts`). Register window types (`registerWindowType`), commands (`services.commands.register`),
key bindings (`services.keymap.add`), menu items (`addMenuItems`), toolbar slots (`addToolbarSlot`) and browser sections
(`addBrowserSection`) there. Put pure logic in `src/core` with unit tests next to it (`*.test.ts`); browser-only
tests are `*.browser.test.ts` or live in `test/browser/`.

The UI must explain itself:
- Give every command a plain `hint` and every control a `data-hint` with units. They show in the hint bar and as
  tooltips.
- Reach features from a menu or right-click, not only a shortcut. The action search (Mod+K) finds every menu entry;
  add others with `addActionProvider`.
- Empty windows say what to do next.
- Keep it usable without a mouse and with a screen reader (`docs/architecture.md`, "Accessibility"): every control has an
  accessible name (icon buttons an `aria-label`; `data-hint` is not a name), a button is a Tab stop and a dense group is one
  (`role="toolbar" data-roving`), knobs and faders are sliders with `aria-valuetext` in units, events worth hearing go through
  `announce()` (`ui/a11y/announce.ts`), a canvas editor gets a keyboard cursor and a text summary, canvas text sizes go through
  `fontPx()`, anything that glides asks `isReducedMotion()`, and colour is never the only clue (`theme.colorSafe` adds shapes).
  New colours use tokens: `test/browser/a11y-contrast.test.ts` holds every theme to 4.5:1 for text and 3:1 for marks.
- Give the AI studio matching actions (`src/app/ai/`) so the chat can drive the feature too. `test/unit/ai-coverage.test.ts`
  fails for a command or window with no AI path: add an `argsHint` for a command that takes an argument, or an action
  (and a `COVERED_BY_OP` entry); `NOT_FOR_AI` needs a written reason. New reads go in `src/app/ai/read/` (a tool module, listed in `read/index.ts`).

## Debugging

In dev, `window.__ag` is the services object (stores, history, commands, keymap, engine). Useful in the console and
for automated checks through the preview browser.
