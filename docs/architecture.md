# AGstudio architecture

This is the design reference. `CLAUDE.md` has the short rules; this file explains the why and the hard parts.

## Goals

- Recreate FL Studio's core workflow in Chrome: Channel Rack (step sequencer), Patterns, Piano Roll, Playlist (pattern and
  audio clips, PAT/SONG modes), Mixer with insert FX, Browser, save/open, WAV export.
- Make the owner's **custom instruments and effects** first-class: a plugin is a folder in `plugins/` that shows up in the
  browser like the built-ins and hot-reloads. Built-ins are written against the same public SDK.
- Leave room for later: automation, MIDI mapping, themes, note scripts, WASM/Faust DSP, a desktop wrapper.

## Layers

```
src/sdk       public plugin API (the only thing plugins import)
src/core      pure model + logic (no DOM)          ← unit tested in Node
src/engine    Web Audio engine (no React, no stores)
src/platform  browser storage/file APIs
src/app       composition root, stores, persistence, plugin discovery
src/ui        React shell, workspace, canvas editors, features/*
src/plugins/builtin, plugins/ (user), templates/
```

Enforcement: ESLint `no-restricted-imports` per folder (see `eslint.config.js`), plus four tsconfigs run by `tsc -b`:
`app` (DOM), `core` (no DOM lib, keeps core pure), `worklet` (`types: ["audioworklet"]`), `node` (build config).

## Data model (`src/core/model`)

- **Ticks**: integers at PPQ 960 (step = 240, beat = 960, bar = 3840 in 4/4). Seconds come only from a `TempoMap`
  (one constant tempo in v1; piecewise later). Audio-clip trims are stored in seconds so tempo changes don't shift audio.
- **Ids**: prefix + 10 random base64url chars (`ch_`, `pat_`, `n_`, `clip_`, `lane_`, `ins_`, `fx_`, `smp_`). Injectable
  generator (seeded in tests). Clone/paste always mints new ids.
- **Records + order arrays** (`channels` + `channelOrder`, …): Immer patches stay single add/remove/replace ops and every
  entity keeps reference identity, which the engine and canvases use to skip unchanged items.
- Steps are notes (FL semantics): the rack's step row is a projection of notes on 240-tick boundaries at the channel's
  root key, ≤ 1 step long. Anything else shows as a mini piano-roll preview.
- Audio clips are channels (FL "Audio Clip" channel) so everything that makes sound routes the same way.
- Pattern clips loop their content: content tick = `(clipLocal + offset) mod patternLength`.
- Plugin instances are host-owned data: `{ pluginId, pluginVersion, params, state?, stateVersion?, samples? }`. Param values
  are plain (numbers in declared units, booleans, enum option ids).
- Automation types exist but are not creatable in v1 so `switch (clip.kind)` stays exhaustive.
- `schemaVersion` + `migrations[n]` (untyped JSON n → n+1) + `repairProject()` that reports fixes. Each bump adds a
  fixture in `test/fixtures/projects/`; tests migrate every fixture.

## State tiers

| Tier | Undoable | Saved | Examples |
|---|---|---|---|
| Document | yes | `project.json` | channels, notes, mixer, plugin params |
| View | no | `view.json` | windows, PAT/SONG mode, current pattern, zoom |
| Session | no | no | selection, hint text, toasts |
| Prefs | no | localStorage/IDB | audio settings, recent files |

### History (`src/core/history`)

- One write funnel wrapping Immer `produceWithPatches`. Invariant: every document change is undoable (load clears history).
- `transact(label, recipe, { mergeKey })`: one entry; `mergeKey` merges repeated edits (wheel, nudges) within 1 s.
- `gesture(label)` → `update(recipe)` (idempotent absolute recipes, applied live so the engine hears drags) / `commit()`
  (exactly one compact entry) / `cancel()` (Escape).
- Geometry drags (note/clip move/resize/marquee) preview on an overlay and commit once on pointer-up.
- Dirty = history cursor ≠ cursor at last save. Cap ≈ 500 entries. Entries may carry selection before/after.
- `DocChange { next, prev, patches | null, origin }` feeds the engine (`origin`: edit | gesture | undo | redo | load).

### Derived data (`src/core/query`)

Memoized with WeakMaps keyed by immutable inputs: sorted note indexes, step projection, pattern length, clip expansion,
effective mute/solo, swing offsets. Engine and UI share these; neither re-implements semantics.

## Audio engine (`src/engine`)

### Context and clock

- One `AudioContext({ latencyHint: 'interactive' })`, resumed on the first user gesture. All graph code targets
  `BaseAudioContext` so export reuses it with an `OfflineAudioContext`.
- **Main-thread lookahead scheduler**. A module Worker ticks every 25 ms (main-thread timers get throttled in background
  tabs) and calls `transport.pump()`; also pump immediately on play/seek/edit.
- Lookahead 120 ms, auto-raised to 250 ms when lateness counters trip (main thread: events dispatched with
  `time < currentTime + 5 ms`; processors: events arriving after their frame).
- Why not a sequencer inside the worklet: graph plugins schedule native nodes, which only the main thread can do, so a
  worklet sequencer would still need main-thread lookahead (two clocks, a project mirror in the audio thread). The core
  stays DOM-free so it could move later.

### Pure scheduling core (`engine/sched/core.ts`)

```ts
interface Timeline { spt: number; loop: { start: number; end: number } | null; endTick: number } // spt = seconds per tick
interface Cursor   { tick: number; time: number; iter: number }   // iter++ on each loop wrap
interface Segment  { tick0: number; tick1: number; time0: number; iter: number }
plan(cursor, horizonTime, timeline) → { segs, next, ended }       // splits at loop end; wraps exactly at loop-end time
collect(index, seg) → events with time = time0 + (start - tick0) * spt
```

- Pattern mode = a virtual looping clip of the current pattern (length rounded up to a bar). Song mode = playlist
  clips with the loop region (or loop the whole song).
- Every event carries a `noteId`. Rule: **a noteOff timed ≤ its noteOn cancels the note.** This gives cancellation of
  already-scheduled notes with no extra API.
- Open-notes table: noteOff comes from the table's end tick, not from re-reading the project, so deleting a sounding note
  can't leave it stuck. Open notes close at loop wrap and clip end.
- Live edits: rebuild the index, re-patch `[now + 10 ms, frontier)` using segment history: dispatch keys
  (`clipId:noteId:iter`) not yet dispatched; send `noteOff(now + 10 ms)` for dispatched keys that vanished; update end
  ticks. Tempo/loop/mode/pattern changes re-anchor the cursor at the frontier.
- Pause: stop pumping, `allNotesOff(now)` on every instrument, clear tables. Stop: pause + jump to start. Seek while
  playing: pause + `start(tick, at = now + 40 ms)`.
- `allNotesOff(t, hard?)`: release every voice sounding at `t`, drop everything scheduled at or after `t`.
- Playhead: keep a ring of segments; each frame compute the audible time from `getOutputTimestamp()`
  (`contextTime + (performance.now() − performanceTime) / 1000`, includes output latency, e.g. Bluetooth) and map it
  through the ring. Never store the playhead in React state.
- Preview/MIDI input bypass the scheduler (`time = ctx.currentTime`, flush the worklet port). Velocity-0 noteOn = noteOff.
- Metronome and audio-clip starts are core events consumed by engine-internal players; the metronome goes to a monitor
  bus that export excludes. Clips overlapping a segment start begin mid-clip with an offset.

### Graph

```
channel: instrument.output → vol → StereoPanner → mute ──► insert input
insert : input → slot 1…N → StereoPanner → fader → mute ──► master input   (+ meter tap: ChannelSplitter → 2× AnalyserNode)
slot   : in ─► dry ─────────────────────────────────► out
          ├─► fx.input … fx.output ─► wet ──────────► out   (bypass = 10 ms crossfade, then disconnect fx.input)
          └─► DelayNode(fx.latency) ─► aligned dry ─► out   (only for effects that report latency)
master : input → slots → pan → fader → mute → masterOut → SafetyLimiter (worklet) → destination
         preview bus → masterOut;  monitor bus (metronome, later) → limiter only
```

- `engine/insert-strip.ts` has `InsertStrip` (the master uses it too) and `FxSlotStrip`. Every insert id has one
  persistent input node (`Engine.insertInput(id)`): it feeds the insert's strip while the insert exists and the master
  otherwise (not created yet, deleted, unknown id), so channels never reconnect when inserts come and go, undo included.
- Reconcile `DocChange` by reference identity: inserts first (keyed by id; removals after the channels), then channels.
  Slots are keyed by `SlotId`: moving one only rewires the chain, enable/mix only change gains, a new `pluginId` replaces
  the instance. `plugin.id` change = async replace guarded by a generation token (stale completions are disposed;
  meanwhile instruments drop events and effects pass audio; a replaced effect fades out over 80 ms). Missing plugin =
  silent placeholder (effects: pass-through) that keeps its data on save. Insert mutes come from
  `query/mixer.ts` `effectivelyMutedInserts` (muted, or another non-master insert soloed; the master always plays).
- Slot gains: dry = 1 − mix, wet = mix (linear); bypassed, loading, missing or failed = dry 1, wet 0. Changes glide
  (~10 ms) while the context runs and are set exactly before it starts: offline renders apply the document at time 0,
  so a bypassed slot renders bit-exact with no slot and nothing depends on timers.
- An effect's `latency` delays the slot's dry path, so the slot mix stays phase-aligned. There is no delay compensation
  across inserts yet.
- Param changes from the UI: `setTargetAtTime(v, now, spec.smoothing ?? 8 ms)`. Enums/bools change via `onChange`.
- Meters: per insert, after the mute, a ChannelSplitter → 2 AnalyserNodes (fftSize 2048; realtime engines only).
  `EngineApi.readMeters(order, out)` writes [peakL, peakR] per insert through one scratch buffer (no allocation). The
  mixer's `MeterBank` (`ui/features/mixer/meters.ts`) calls it once per frame, does the ballistics (26 dB/s fall, 1.5 s
  peak hold) and repaints a canvas only when it changes. Exact clip detection only in the master limiter.
- Insert volume is linear gain up to 1.905 (+5.6 dB). Faders and the toolbar master knob use the taper in
  `core/model/fader.ts` (0 dB at 80 % of travel, gain = (pos / 0.8)^k); meters share that scale so they line up with
  the fader cap.
- SafetyLimiter: SDK `EffectKernel`, ~1.3 ms lookahead sliding-window max, −0.3 dBFS ceiling, 50 ms release, final clamp,
  NaN/Inf scrub. (Not DynamicsCompressorNode: it adds makeup gain and a fixed 6 ms look-ahead.)

### Built-in sounds

- Procedural drum kit: pure generators `(sampleRate, seed) → Float32Array[]` with a seeded PRNG, cached per
  `(name, sampleRate)`, referenced as `{ kind: 'builtin', generator, version }`. Never change a published version's output.
  Recipes: kick = phase-accumulated sine with pitch 48 + 130·e^(−t/35 ms) Hz, amp e^(−t/250 ms), 2 ms noise click, tanh;
  snare = sine modes 185/330 Hz (~80 ms) + noise HP 1.5 kHz (~180 ms); clap = noise BP 1.2 kHz, 3 bursts 10 ms apart,
  150 ms tail; hats = 6 detuned squares at 808-style ratios, BP 10 kHz + HP 7 kHz (closed 50 ms, open 400 ms);
  toms = kick at 90/130/180 Hz; rim, cowbell (540 + 800 Hz squares), crash.
- Reverb IR (`plugins/builtin/reverb/ir.kernel.ts`): decorrelated L/R noise (seeded) × e^(−6.91·t/RT60), 3 bands
  with their own decay (lows ×1.3, highs ×(1 − 0.8·damping)), 8–12 early reflections from 10 ms to 12–80 ms (size),
  5 ms fade-in, unit energy, `disableNormalization`. Pre-delay is a DelayNode. Decay/damping/size changes: debounce
  150 ms (immediately when offline), regenerate on the main thread (10–25 ms for a 10 s tail; a Worker can come later),
  crossfade two ConvolverNodes over 120 ms (setting `.buffer` in place would click and cut the tail). IRs are cached.
- 808 Bass (`plugins/builtin/bass808`, graph instrument, mono legato): each hit is a fresh zero-phase sine whose pitch
  starts `punch` semitones up (the oscillator's initial detune: Chrome feeds a starting oscillator automation from up to
  127 frames earlier in its first render quantum) and decays with τ = punchTime/4; amp e^(−t·4/decay), 50 ms release,
  8 ms choke of the previous hit. A note that starts while the current one is held glides (exponential frequency ramp,
  no attack). The performance is re-derived from all known notes after every event (`legato.ts`) and rescheduled from
  the first difference with rewindable AudioParam lanes (`lane.ts`), so the scheduler's note-ons-before-note-offs order,
  cancellations and swing don't change the sound; times within 1e-6 frames of a frame are snapped onto it. tanh drive
  (4× WaveShaper, voices start 192 frames early to cancel its latency), Butterworth low-pass tone.

## Plugin SDK (`src/sdk`)

One contract: `create(host) → instance`. Worklet plugins are a preset of the same contract.

```ts
defineInstrument({ id, name, version, category?, params, defaultState?, migrate?, processor?, ui?, presets?, create(host) })
defineEffect({ … same … })
defineWorkletInstrument({ …, processor })   // processor = import url from './x.worklet.ts?worker&url'
defineWorkletEffect({ …, processor })

host: { audioContext, params, state, updateState(next), transport: { bpm, ppq, onTempo }, samples: { load, procedural },
        offline, signal /* aborted on dispose */, worklet(opts) → WorkletPort }
InstrumentInstance: { output, noteOn(e), noteOff(e), allNotesOff(time, hard?), setState?, dispose, tailTime? }
EffectInstance:     { input, output, setState?, reset?, dispose, latency?, tailTime? }
NoteOn  { time, noteId, key, velocity, pan?, fine? }     NoteOff { time, noteId, key }
ParamHandle: { spec, value, bind(audioParam, map?) → unbind, signal(map?) → ParamSignal, onChange(cb) }
```

- Params (`sdk/params.ts`): `p.float/int/enum/bool`, scale linear/log/db, units, normalization for knobs, AudioParam
  descriptors (float a-rate, others k-rate). Values are host-owned in the document: undo, presets, save, hot reload free.
- `ParamSignal` = one smoothed ConstantSourceNode fanned out to many voices (target intrinsic value must be 0).
- `GraphVoices` (main thread): per-note node bookkeeping, polyphony cap, steal with 5 ms fade, cancel-before-start,
  proactive `gc(now)` (don't rely on `onended`; export needs determinism).
- `WorkletPort`: packs note events into a `Float64Array` (type, frame, noteId, key, velocity, extra), one transfer per
  node per pump; `sync()` = FIFO barrier (processor echoes an id).

### Worklet kernels (`src/sdk/worklet`)

Plugin authors write kernels, not `AudioWorkletProcessor`s:

```ts
abstract class InstrumentKernel<P> { noteOn(key, vel, noteId); noteOff(noteId, key); allNotesOff(hard);
  render(out: Float32Array[], from: number, to: number, params: ParamBlock<P>)  /* ADD into out */ }
abstract class EffectKernel<P> { process(inp, out, n, params); reset?() }
registerKernel(id, params, KernelClass)   // duplicate registration warns instead of throwing
VoicePool, dsp/* (OnePole, SVF, DelayLine, ADSR, PolyBLEP, mtof, dbToGain, flush)
```

The SDK-owned processor: preallocated sorted event ring; splits each block at event frames (late events land at the
current position); `f0 = max(currentFrame, lastF0 + n)` (Chromium bug 442866743: `currentFrame` can be stale for a
quantum while the main thread holds the graph lock); never assumes 128 frames (`renderSizeHint` is shipping); try/catch
around render → silent + `faulted` report; NaN/Inf scrub (`x - x !== 0`) → zero block + `reset()`; returns `false` only
after dispose. Unconnected inputs arrive with zero channels → pass zero buffers. Effects use `channelCount: 2`,
`channelCountMode: 'explicit'`; instruments `outputChannelCount: [2]`. No `fetch` in worklets and no global
`AudioWorklet.port` in Chrome: transfer sample data per node.

Processor code rules: allocate in constructors; index loops; no closures/array literals/spread/destructuring in
`process()`; monomorphic voice classes; copy messages into rings; never keep `inputs`/`outputs` references; post from the
audio thread at ≤ 30 Hz.

### Vite specifics (verified against Vite 8.3)

- Load processors with `?worker&url` (bundled + hashed in prod; dev serves `?worker_file&type=module`).
- `worker.format: 'es'` (default 'iife' rewrites `import.meta.url` to `self.location`; worklets have no `self`).
- Exclude audio-thread files from `@vitejs/plugin-react` (no React Refresh code injected).
- Never `addModule(new URL('./x.ts', import.meta.url))` (shipped raw in prod) or `?url` on `.ts`.
- Discovery: `import.meta.glob` over `/src/plugins/builtin/*/index.ts` and `/plugins/*/index.{ts,tsx}` (ignore `_*`);
  the glob re-runs when matching files are added/removed, so new plugin folders appear without a restart.
- Hot reload, main thread: the discovery module accepts its own updates; the long-lived registry diffs definitions by id
  and identity; the engine recreates affected instances (state lives in the document) with a 10 ms crossfade.
- Hot reload, worklet code: editing a processor would otherwise full-reload (worker_file has no importers), re-adding the
  module to the same context is a no-op (cached), cache-busting makes `registerProcessor` throw, and modules can't be
  unloaded. So a dev plugin (`ag:worklet-hmr`) turns worklet-only changes into a custom event and the engine **reboots**:
  close the context, create a new one (resume), re-add modules, reconcile ∅ → store, restore transport position.
  ~100–300 ms dropout, dev only. AudioBuffers aren't tied to a context, so the sample cache survives.

### Offline export

Drive the same Transport from a virtual clock and render in `suspend()`/`resume()` chunks (128 × 256 frames), with a
2048-frame pre-roll and a per-worklet `sync()` barrier each chunk. Graph plugins only create nodes for the next chunk.
Uncertain browser behaviours (verify with the chunk-boundary impulse matrix: notes at `k·C−1`, `k·C`, `k·C+1` for chunk
sizes 128, 128·37, 128·256 must land on exact frames): port messages during suspension; processor constructed before the
first quantum; suspend rounding direction (always schedule through next boundary + 50 ms); stale `.value` after resume
(never set `.value` during export, only `setValueAtTime` well past the boundary). Plan B: send the whole song's events in
one message + `sync()` before `startRendering()`. Determinism: render twice, compare PCM hashes (plugins use seeded RNG).
WAV: 16-bit TPDF dither, 24-bit, 32-bit float, encoded in a Worker; pick the file first (user activation lasts ~5 s).

As built (M6, `app/export`): File > Export WAV (Mod+R) opens a dialog (range: song, current pattern or the playlist's loop
region; format; sample rate). Its Export button is the user gesture for the save picker, so the picker comes before the
render. `renderOffline` takes `fromTick` (loop regions), `tail: 'auto'` (instrument and effect tails, measured on a
128-frame probe context), `onProgress` and an abort `signal` (an aborted render stays suspended and is dropped).
`trimRender` drops the pre-roll and cuts the silence (< −90 dBFS) after the last tail. Measured in Chrome: the export
decodes back to the float render within one 24-bit step, and renders of kit/synth projects are hash-identical. The
exception is **ConvolverNode** (the Reverb): two renders differ by about one float ULP (≤ 6e-8, inaudible), so a
project with reverb can produce byte-different files. A deterministic convolution would need our own worklet.

### What M2 verified in Chrome

- **Worklet note timing offline**: with `suspend()`/`resume()` chunks and a per-port `sync()` barrier, impulse
  notes at chunk boundary −1/0/+1 land on the exact frame for chunk sizes 128·16, 128·37 and 128·256
  (`test/browser/worklet.test.ts`). Messages *are* processed while an OfflineAudioContext is suspended.
- `suspend(0)` is rejected before rendering starts (time must be > currentTime), so the first stop is at
  frame 128; the 2048-frame pre-roll covers it. Events dispatched before rendering are flushed by that first
  barrier.
- The master SafetyLimiter adds `round(0.0013 · sampleRate)` frames of latency (62 at 48 kHz); timing tests
  account for it.
- Chrome's native OscillatorNode output can differ by ~1e-8 between two renders; worklet kernels and samplers
  are bit-exact.
- Worklet hot reload: Vite reports a processor edit as two modules: the main-thread `?worker&url` stub
  (imported by the plugin's index.ts) and the `?worker_file&type=module` node (no importers). `ag:worklet-hmr`
  ignores the stub and sends `ag:worklet-changed` when everything else is audio-thread-only. The app then
  reboots the engine through `EngineHost` (fresh AudioContext, same project/view/transport; `resume()` is not
  awaited because it can stay pending without a gesture). Files shared by both threads (`params.ts`) still
  trigger a page reload, which is fine thanks to session restore.
- `import.meta.glob` with lazy loaders + `Promise.allSettled` isolates broken user plugins (error entries in
  the browser panel). Adding or deleting a plugin folder re-runs the self-accepting discovery module.

### What M5 verified in Chrome

Measured with offline renders (`test/browser/mixer.test.ts` keeps checking them):

- DynamicsCompressorNode delays its output by `floor(0.006 · sampleRate)` frames (288 at 48 kHz, 264 at 44.1 kHz) and
  multiplies it by an automatic makeup gain `(1 / curve(1.0))^0.6`. `compressor/makeup.kernel.ts` reproduces
  Chromium's curve (within ~1e-4), the Compressor divides it out and reports the look-ahead as `latency`.
- WaveShaperNode oversampling delays by 128 frames (`'2x'`) or 192 frames (`'4x'`) at every sample rate. ConvolverNode
  adds no latency. Biquads, convolvers, compressors and shapers render identically twice offline.
- A feedback cycle through a DelayNode takes one render quantum (128 frames) longer per trip than its `delayTime`:
  Chrome breaks the cycle by reading one link's previous quantum (the link into the cycle node first reached from the
  destination). The Delay compensates (straight loop one quantum short behind a one-quantum pre-delay; in ping-pong
  the right delay is one quantum short) and its echoes land within 2 frames of the beat.
- AnalyserNodes run in an OfflineAudioContext too; the meter test reads them during a `suspend()`.
- Vitest 5's persistent module cache (`fsModuleCache`) keys a module by its own source, so an `import.meta.glob`
  kept stale matches after plugin folders were added. It is off in `vite.config.ts`.

## UI (`src/ui`)

- Shell: toolbar (menus + hint bar, transport, PAT/SONG, BPM, position, master volume, CPU, window buttons), browser
  sidebar, workspace of floating windows. Everything is contributed by `features/*/register.ts`.
- Workspace: windows drag by the title bar and resize from 8 handles with pointer capture on the grabbed element; DOM is
  moved directly while dragging and the rect is committed on pointer-up. z-order, focus, maximize (double-click title),
  hide (F-key toggles: visible+focused → hide, else show+focus).
- Commands + keymap (`core/commands`): canonical chords (Ctrl, Alt, Shift, Meta order; `Mod` = Cmd on macOS);
  letters/digits come from `event.code` so Option combos work on macOS. One capture-phase keydown listener; handled keys
  are swallowed (also on keyup) and toolbar buttons never take focus, so Space can't click a button. Mac F-keys need Fn:
  every F-key binding has an Alt+digit alternate. Chrome reserves Cmd+W/T/N/Q.
- Controls (`sdk/ui`, public so plugin UIs match): Knob (vertical drag 200 px/full range, Shift fine ×0.1, double-click
  reset, wheel with `mergeKey`, optional `format` for the displayed value), Fader (dB taper), StepButton (paint/erase
  drag = one gesture), Meter (canvas). The mixer's Fader and canvas meters live in `features/mixer` for now; they can
  move to `sdk/ui` once a plugin UI needs them.
- Timeline canvas core (Piano Roll + Playlist): `Viewport` (scrollTick, pxPerTick, scrollRow, rowHeight; tick↔x,
  row↔y), snap grids incl. triplets and zoom-adaptive auto, `ItemSource` with sorted-by-start arrays + binary search
  (extended back by the longest item), layered canvases (grid / content / overlay), 1-px DOM playhead moved with
  `transform`, tools as small state machines, native non-passive wheel listener (React's `onWheel` is passive; trackpad
  pinch = wheel + ctrlKey → zoom at cursor), edge auto-scroll, `devicePixelContentBoxSize` for crisp canvases.
- Performance budgets: 60 fps with 10k notes (3k visible) and 2k clips; content redraw < 4 ms; single-note transact
  < 1 ms; zero React commits during idle playback.
- Theme: CSS custom properties in `ui/theme/tokens.css`; canvases resolve tokens via `getComputedStyle` and re-resolve
  when a theme version counter changes.

## Persistence (`src/app/persistence`, `src/platform`)

- `.agproj` = zip (fflate, `core/io/project-file.ts`): `meta.json` (`{ format: 1, appVersion, savedAt }`),
  `project.json` and `view.json` (deflate 6), `samples/<sha256>.<ext>` (original bytes, stored uncompressed). Plugin code
  is never embedded; plugins are referenced by id + version. Reading migrates and repairs (`core/schema/migrate.ts`) and
  throws `ProjectFileError` with a user-facing message; a damaged `meta.json`/`view.json` is tolerated and reported in
  `repairs`. Opening verifies each embedded sample against its hash before it enters the store.
- Runtime sample store: OPFS `blobs/<sha256>.<ext>` (`platform/opfs.ts`), layered over memory when OPFS is missing or
  full (`app/persistence/blob-store.ts`); decode per `(hash, sampleRate)`; undo removes references, not blobs; idle GC of
  unreferenced blobs (count references from autosaves too). `decodeAudioData` resamples and detaches its input; Chrome
  rejects AIFF, so the engine's bytes provider transcodes AIFF to float WAV with the PCM parser in `core/io/wav.ts`
  (which also reads `smpl` and AIFF `INST`/`MARK` loop/root data).
- Save/Open (`app/project-files.ts`, `services.files`): `showSaveFilePicker`/`showOpenFilePicker`, keep the handle for
  Cmd+S, `createWritable()` swaps atomically. Fallback: `<input type=file>` / `<a download>`. Pickers need a recent
  user gesture, so a command shows its picker before any slow work, and the unsaved-changes prompt is an in-app dialog
  (its button click is a fresh gesture). Handles of recent files live in IndexedDB (`persistence/recent-files.ts`);
  a reopened handle asks for permission again when the browser wants it. `.agproj` files dropped on the window open
  (Chrome gives a handle for them, so Save writes back). `beforeunload` guard while dirty (production builds only:
  in dev it would block Vite's full reloads).
- Dirty state is History's: `checkpoint()` pins the state a save writes (edits made during the save stay unsaved) and
  `markSaved(cursor)` records it, so undoing back to the saved state is clean again; `load(project, { dirty })` marks
  recovered work as unsaved.
- `view.json` (`persistence/view-snapshot.ts`): mode, current pattern, loop, song position, windows, browser, piano
  roll/playlist settings, selected channel. Applying it validates every field and drops windows whose channel or
  insert is gone; a project without a layout gets the default one.
- Reloads (`persistence/session.ts`): each tab keeps a session id in sessionStorage and mirrors project, view and file
  link there (synchronously on pagehide), so a reload, including a dev full reload, returns to the same state and
  still saves to the same file. A duplicated tab copies sessionStorage, so its id is already locked: it takes a new id.
- Autosave: OPFS `autosave/<session>/{a,b}.agproj` plus `{a,b}.json` (meta with size and SHA-256, written after the
  data, so an interrupted save leaves the other slot valid). 3 s after the last edit (≤ every 30 s) and on tab hide,
  alternating A/B slots. Autosaves are thin: no sample bytes (samples stay in the blob store). Encoding runs on the main
  thread for now; the storage interface allows moving it to a worker. Each tab holds a Web Lock
  `agstudio:session:<id>`; on startup, autosaves whose lock is free and not marked clean are recovery candidates. Only a
  clean project ends clean (on pagehide, save, open or new), so closing a tab with unsaved changes keeps them
  recoverable; only unsaved work is autosaved. The recovery dialog offers the newest candidate first (Recover /
  Discard / Not now); recovering autosaves into this tab before deleting the old copy. `navigator.storage.persist()`.
- Sample folders (`persistence/sample-folders.ts`, browser section "Sample folders"): `showDirectoryPicker({ id: 'samples',
  mode: 'read' })`, handles in IndexedDB, "Reconnect…" when permission is `prompt` (usual after a reload), recursive
  listing capped at 5000 files. Click previews (`engine.previewAudio(bytes)`, nothing stored), double-click adds a
  sampler channel. Drags carry a token for the file handle (`ui/audio-drag.ts`, type `application/x-agstudio-file`);
  files dragged from the desktop arrive as DataTransfer files. Drops: on a sampler/audio-clip channel the sound replaces
  its sample (FL), elsewhere on the rack each file becomes a sampler channel, on the playlist each file becomes an audio
  clip on consecutive tracks. Imported files are hashed into the sample store and embedded in saved projects.
- Decoding (`engine/decode.ts`): `decodeAudioData`, falling back to the PCM parser (AIFF and unusual WAVs) at the file's
  own rate.

## Voice analysis (`src/core/voice`)

Recorded mouth sounds (beatboxing "boom ts pf ts", a hummed 808 line) become step-grid events and a text summary for
the AI. Pure TypeScript (core rules: no DOM, no deps), so it runs in Node tests, a Worker or the main thread.

```ts
analyzeVoice(samples, sampleRate, { sensitivity?, minGapSec?, mode?: 'auto' | 'drums' | 'tonal' }) → VoiceEvent[]
  // { time, duration, strength, kind: kick|snare|hat|tonal, confidence, pitch, pitchEnd, features }
estimateBpm(events, { min?, max? }) → number | null
quantizeToGrid(events, { bpm, startSec, bars?, beatsPerBar?, stepsPerBeat? }, { resolution?: 0.5 | 1, swing? }) → GridEvent[]
describeEvents(gridEvents, { stepsPerBar?, stepsPerBeat? }) → string  // + VOICE_SUMMARY_LEGEND for a prompt
trackPitch(samples, sampleRate, { minHz?, maxHz?, hop?, window? }) // YIN; FFT/RealFFT/hannWindow helpers in fft.ts
```

- Onsets: spectral flux on log-compressed quarter-octave bands (100 frames/s, moving-median threshold), then each
  candidate is checked and timed on 1 ms-block envelopes (11 ms RMS for rises and levels, 3 ms RMS for the time) in three
  bands, so a hat over a kick's tail still shows. Gates against the recording's noise floor and loudest moment; rises
  are re-measured over two pitch periods after low notes (their level ripples) and against the median after noise;
  noisy sounds slower than 40 ms to half level are swells (breaths) and dropped.
- Classification from the first 60 ms (attack-weighted window, the pre-onset background subtracted per band): tonal
  needs YIN periodicity, ≥ 120 ms sustain, pitched frames, little energy over 4 kHz and no kick-like pitch drop; else
  soft scores on centroid / energy below 150 Hz / above 4 kHz / length pick kick, snare or hat. Every threshold lives
  in `VOICE_THRESHOLDS` (`analyze.ts`).
- Hums: legato note changes come from the pitch track (> 1.5 semitones, stable ≥ 60 ms); a glide that never settles is
  one event with `pitchEnd`; same-pitch re-articulations need a real level dip. YIN runs on audio decimated to ~8 kHz,
  only where needed.
- Grid: swing follows the engine (odd 1/16 steps late by swing × half a step); same-kind collisions keep the stronger
  drum or merge tonal notes; `describeEvents` uses beat.sixteenth positions and scientific note names (C4 = MIDI 60).
- Measured (Node 22, M-series): 30 s of 48 kHz audio in ~65 ms; on randomized synthetic sequences (kick/snare/hat/hum,
  100–150 BPM, ±10 ms jitter, −40…−60 dB noise) no missed or extra onsets, 100 % kinds, onsets within ~7 ms (soft hum
  attacks read 3–6 ms late), hum pitch within 0.01 semitone. Known limits: a voiced "boom" kick longer than ~120 ms
  reads as tonal (`mode: 'drums'` fixes it), mic pops on "p"/"b" add low energy, lip smacks are events, and tempo can
  come out at half/double time near the ends of the BPM range.

## Beat assistant (`src/core/beat`, `src/core/voice`, `src/app/assistant`, `tools/ai-proxy.ts`)

- **Beat format** (`core/beat/spec.ts`): `{ title, message?, bpm?, swing?, bars (1–4), tracks: [{ name, sound, notes:
  [{ step, len?, key?, vel? }], volume?, pan?, params? }] }` on a 1/16-step grid (steps snap to 1/6 step = 40 ticks, so
  1/32 and triplet rolls fit). `validateBeatSpec` clamps everything and drops what doesn't fit; nothing unvalidated
  reaches the project. Sounds: the kit pieces (samplers), `808` (`agstudio.bass808`: overlapping notes glide), `bass`,
  `lead`, `pad` (3xOsc settings) and `pluck`.
- **Applying** (`app/assistant/apply.ts`): one history transaction writes a pattern and its channels, reusing the
  project's channels that already play the same kit sound (or its 808), so beats share channels like FL patterns do.
  Mix and sound settings only go to channels the assistant created. Follow-ups rewrite the same pattern.
- **Performance**: the engine records the mic on its own clock (`engine/recorder.ts`: an AudioWorklet writing into a
  SharedArrayBuffer, count-in and click scheduled on the context, optional play-along from bar 1). Bar 1 is located
  in the audio from the scheduled time plus output and input latency (`MediaTrackSettings.latency`). The voice
  analysis (`core/voice`) finds onsets, classifies kick/snare/hat/tonal, tracks hummed pitch (YIN), quantizes to the
  grid and writes a compact text summary for the AI.
- **Claude** (`app/assistant/claude.ts`, server side in `tools/ai/`): the browser posts each turn to `/api/ai/beat` on
  the dev/preview server, which keeps the conversation (session id) and answers with the beat as JSON under a
  structured-output schema (`BEAT_JSON_SCHEMA`: `additionalProperties: false` everywhere, ranges in descriptions,
  enforced by `validateBeatSpec`; a beat that fails validation is sent back once for a fix). Two backends:
  - **subscription** (`tools/ai/subscription-backend.ts`): the musician's own Claude Code CLI, signed in with their
    Claude plan, run in print mode per turn with no tools, resuming its session for follow-ups;
  - **api** (`tools/ai/api-backend.ts`): the Anthropic SDK with `ANTHROPIC_API_KEY` from `.env.local` (re-read per
    request): streaming, `output_config` effort `medium` + JSON schema, server-side refusal fallback
    (`fallbacks: "default"`) on models that have it, an append-only history (thinking blocks kept).
  "Auto" picks the subscription when it's set up, else the key, else the offline generator. Claude Opus 5.5 and
  Sonnet 5.5 reject forced tool choice, which is why the answer is a structured output rather than a tool call. The
  endpoint refuses requests without the `x-agstudio` header or from another origin.
- **Offline** (`core/beat/local.ts`): when no key is set, a deterministic generator reads style, tempo, key and
  "busier/simpler" from the description, uses per-style drum grids, writes an 808 that follows the kick, and maps a
  performance onto drums (beatbox) or an 808/melody (hummed contour moved into register and key, connected notes
  overlapping so they glide).

## Testing

- Unit (Vitest, Node): scheduler core, time/snap, queries, ops, history invariants (fast-check: random ops then undo-all
  = initial), params, migrations, zip, WAV, DSP kernels, generators.
- Audio (Vitest browser mode, headless installed Chrome via Playwright `channel: 'chrome'`): offline-render fixtures
  returning `{ rms, peak, onsets, hash }`; onsets ±1 frame for worklets, ±1–2 ms for graph plugins; mute → silence;
  gain math; limiter ceiling; determinism; export chunk-boundary matrix; WAV export (hash-identical renders,
  24-bit round trip, trimming, start tick, progress and cancel).
- App smoke test (`test/browser/app-smoke.test.ts`): the whole app with the real engine and React shell in headless
  Chrome: open a project file → play → seek → stop → save → reopen, with no errors logged and no late events.
- In the app: `window.__ag` (dev) exposes services (stores, history, commands, engine, files) and `__ag.perf`
  (piano roll draw times, React commit count; `?perf=notes10k` loads a 10k-note fixture).
- Measured at M7 (Chrome, M-series Mac): piano roll redraw with 10k notes median 0.6 ms, p95 0.9 ms; 0 React
  commits during idle playback (mixer open); an 8-bar song with reverb and delay exports (24-bit) in ~1.1 s.

## Risks to keep in mind

Autoplay policy (resume on first gesture, overlay); main-thread jank → late notes (lookahead, lateness counters, keep the
frame loop light, workers for IR/WAV/peaks); background throttling (Worker clock); GC/NaN in the audio thread (kernel
rules, scrubbing, fault isolation); sample-rate mismatches (decode per rate, coefficients from `sampleRate`); Bluetooth
latency (playhead compensation); StrictMode double effects; user plugins are trusted code in the same JS context (error
boundaries, lazy import with `allSettled`, NaN guard + limiter on master).
