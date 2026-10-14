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
- Steps are notes (FL semantics): the rack's step row is a projection of notes on 240-tick boundaries, ≤ 1 step long,
  one per step. New steps use the channel's root key; a step may have its own key (the graph editor's pitch lane).
  Anything else shows as a mini piano-roll preview.
- Audio clips are channels (FL "Audio Clip" channel) so everything that makes sound routes the same way.
- Pattern clips loop their content: content tick = `(clipLocal + offset) mod patternLength`.
- Plugin instances are host-owned data: `{ pluginId, pluginVersion, params, state?, stateVersion?, samples? }`. Param values
  are plain (numbers in declared units, booleans, enum option ids).
- Automation clips are channels too (FL): an automation channel holds the target, the points and
  (tempo) the range; its playlist clips play that curve, so they all show the same points (M9).
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
channel: instrument.output → vol → StereoPanner → mute ──► insert chIn
insert : chIn/routeIn → slot 1…N → scTap → mute/solo gate → preTap → StereoPanner → fader → postTap ──► routes
slot   : in ─► bypass / dry / latency-aligned dry / fx … wet ─► out   (gates crossfade ~10 ms)
master : the same strip; postTap → masterOut → SafetyLimiter (worklet) → destination
         preview bus → masterOut;  monitor bus (metronome, later) → limiter only
```

Routes, sidechains, delay compensation and the persistent per-insert nodes are described in
[Mixer routing, sidechain and delay compensation (M10)](#mixer-routing-sidechain-and-delay-compensation-m10).

- `engine/insert-strip.ts` has `InsertStrip` (the master uses it too) and `FxSlotStrip`; `engine/mixer-graph.ts` owns
  them. Every insert id has one persistent channel input (`Engine.insertInput(id)`): it feeds the insert while the
  insert exists and the master otherwise (not created yet, deleted, unknown id), so channels never reconnect when
  inserts come and go, undo included.
- Reconcile `DocChange` by reference identity: inserts first (keyed by id; removals after the channels), then channels.
  Slots are keyed by `SlotId`: moving one only rewires the chain, enable/mix only change gains, a new `pluginId` replaces
  the instance. `plugin.id` change = async replace guarded by a generation token (stale completions are disposed;
  meanwhile instruments drop events and effects pass audio; a replaced effect fades out over 80 ms). Missing plugin =
  silent placeholder (effects: pass-through) that keeps its data on save. Insert mutes come from
  `query/mixer.ts` `effectivelyMutedInserts` (muted, or left out by a solo: see `soloState`; the master always plays).
- Slot gains: dry = 1 − mix, wet = mix (linear, from the slot's mix ConstantSource); bypassed, loading, missing or
  failed = the input alone. Changes glide (~10 ms) while the context runs and are set exactly before it starts:
  offline renders apply the document at time 0, so a bypassed slot renders bit-exact with no slot and nothing depends
  on timers.
- An effect's `latency` delays the slot's dry path, so the slot mix stays phase-aligned, and the mixer compensates
  it across inserts (PDC, see M10).
- Param changes from the UI: `setTargetAtTime(v, now, spec.smoothing ?? 8 ms)`. Enums/bools change via `onChange`.
- Meters: per insert, after the fader (postTap), a ChannelSplitter → 2 AnalyserNodes (fftSize 2048; realtime engines only).
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
VoicePool, dsp/* (OnePole, Svf, EnvelopeFollower, Biquad, Rng, mtof, dbToGain, flush)
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
  multiplies it by an automatic makeup gain `(1 / curve(1.0))^0.6`. The v1 Compressor divided out a model of
  Chromium's curve; since M10 the Compressor is an SDK worklet kernel with no look-ahead.
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
- Help that explains the app as you use it (the user asked for a UI that is very easy to understand):
  - Every control's `data-hint` shows in the hint bar and, after a short hover, as a tooltip next to it
    (`shell/HoverTip.tsx`, imperative, one element). Tooltips skip canvases, menu items, `data-hint-tip="off"` and hints
    that only repeat the label. A dragged control's live value (`HINT_EVENT`) follows the control.
    Options → Show tooltips turns them off.
  - Action search, Mod+K (`features/palette`):
    - It lists every menu entry (submenus and dynamic entries included, with their menu path), every entry from
      `addActionProvider()` (`shell/actions.ts`), and every command no menu shows. A command whose bindings all pass
      arguments, or that has `palette: false`, is left out.
    - Ranking is pure (`search.ts`): every query word must match, word starts and labels count most, a synonym table
      maps newcomer words (bpm → tempo, click → metronome), and recent actions float up.
    - The last row hands the text to the AI studio.
  - Getting started (`features/help`):
    - A welcome screen opens the first time the app starts (from `main.tsx`, never over crash recovery). Help → Getting
      started brings it back.
    - The guided tour highlights each area through `data-tour` / `data-window-type` anchors, followed every frame.
      Each step opens the window it explains.
  - New features ship with plain labels, hints with units, empty states that say what to do, and menu or right-click
    entry points, not shortcut-only.

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
- User presets (`app/presets.ts`, `services.presets`): a list in IndexedDB (`user-presets:v1`), loaded at startup;
  writes wait for that load so an early save can't replace what's stored. Each stores every param, the state and the
  plugin's `version` (older ones go through the plugin's `migrate` when loaded). `presetChoices(def, library)` is the
  factory presets then yours; `applyPreset` is one undo step and notes the name per owner (session only), so the preset
  bar shows "Name (edited)" after a tweak. Randomize keeps params that look like output levels. `.agpreset` files are
  JSON (`format: "agstudio-preset"`). Samples aren't part of a preset. The AI catalog lists your presets and
  `preset: "<name>"` finds yours before the factory ones.

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

## Beat assistant (`src/core/beat`, `src/core/voice`, `src/app/assistant`, `tools/ai`)

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

## v2 foundations (M8a)

The contracts the v2 features build on.

- **Schema v2** (`core/model/types.ts`, migration `MIGRATIONS[1]`): `Insert.routes` (one route per target,
  `{ to, level, pre }`; every insert starts with a route to the master, the master has none; no route =
  silent), `FxSlot.sidechain` (the insert feeding the slot's sidechain input), `Project.controllers`
  (MIDI links), `transport.key`, `InstrumentChannel.pitch` (cents), `Note.release`/`fine`, automation
  point `shape` and channel `range`. Repair breaks routing loops (routes win over sidechains, mixer
  order decides) and validates targets. Deleting an insert drops the routes and sidechains that
  pointed at it (an insert left with no route goes to the master) and the controller links to its
  controls; deleting a channel or slot drops its links.
- **Targets** (`core/model/targets.ts`): `ParamTarget` covers channel volume/pan/pitch, insert
  volume/pan, slot mix, route level, plugin params and the tempo; `targetKey()` is the string the engine
  and UI use for it (`parseTargetKey` is the inverse). Specs of the host's own controls are in
  `core/model/target-specs.ts`.
- **Routing graph** (`core/query/routing.ts`, `core/ops/routing.ts`): edges are routes plus sidechains
  (source → listening insert); `wouldCycle` guards every edit.
- **Param lanes** (`engine/param-lane.ts`): an `AutoLane` is the only writer of an automatable value.
  Live edits are `setTargetAtTime` towards the new value (exact `setValueAtTime(v, 0)` before an offline
  render); `cut(at)` keeps the schedule up to the first breakpoint at or after `at` (never touching a
  running ramp); `extend` appends linear ramps (steps for discrete params); `release` ramps back to the
  document value. Bindings made later (voices, async plugins, reboots) get the schedule replayed; `.value`
  is never written. Plugin params (`engine/param-handle.ts`), channel volume/pan/pitch and insert
  volume/pan register by target key in `EngineCore.params` (several per key while an instance is
  replaced). `ParamHandle.valueAt(t)` reads the lane, so instruments read once-per-note settings at
  the note's time.
- **Transport observers** (`TransportObserver` in `engine/sched/transport.ts`): `started`, `segment`
  (called before that segment's notes go out), `reanchored`, `seeked`, `stopped`. The automation driver
  (`engine/automation/driver.ts`) is one; the metronome and recorders hang off the same hook.
- **EngineApi additions**: `tickAt`, `contextTimeAt`, `readAutomation`, `touch`, `tempoNow`, `setSession`
  (metronome, count-in; replayed on reboot), `graphLatency`, `previewControl`, `previewPitchBend`.
- **SDK 1.1**: `valueAt`, `NoteOn.fine`, `NoteOff.release`, `controlChange`, `ChannelInfo.pitch` (a signal for
  voice detune; worklet instruments get it as the reserved `__pitch` param and `kernel.pitch`),
  `pitchAt`, effect `sidechain` (graph: `host.sidechain`; worklet: second input → fifth `process` argument),
  `tempoAt`/`onTempo(bpm, time)`, `ParamLane`, `sumSignals`, note scripts (`defineNoteScript`, a third
  definition kind; modules may export arrays).
- **UI registries**: `addParamMenuItems` (`ui/param-menu.ts`; SDK controls with a `param` prop open it,
  plugin windows provide it for plugin params and `HostParamMenus` for target keys), `addContextMenuItems`
  (`ui/context-menus.ts`: playlist clip/lane, mixer strip/slot, rack channel, piano-roll note/empty),
  submenus in context and menu-bar menus (`kind: 'submenu'`), `showFormDialog` (`ui/controls/FormDialog.tsx`).

### Time and automation model (M8b)

- **Tempo maps** (`core/time/tempo.ts`, interface in `core/time/ppq.ts`): piecewise-constant
  (`steppedTempo(steps)`, equal neighbours merged; `constantTempo(bpm)` when it never changes) with
  cumulative seconds, `bpmAt`, `secondsPerTick`, `tickToSeconds`/`secondsToTick` and `nextChange`.
  `tempoMapOf(project, mode)` (`core/automation/tempo.ts`): the base tempo, plus tempo automation clips
  in song mode evaluated once per 1/16 step (range per clip, default 60–180 BPM). It returns the same
  object while its inputs are unchanged and while the result describes the same tempo, so the
  transport re-anchors only on real tempo changes.
- **Scheduler**: `Timeline.tempo` replaces the constant seconds-per-tick; `plan()` splits segments at
  tempo changes (each `Segment` keeps its own `spt`, so the playhead mapping is unchanged), reads the
  tempo at the loop start after a wrap, and `timeInSegment` places swung starts and releases that fall
  past a segment's end on the map. Change detection compares the map by identity; the position is
  folded into the loop only when the loop itself changed. Audio-clip trims, splits, left-trims,
  waveforms, dropped-clip lengths, render length, export trim and the export dialog all convert through
  the map (audio keeps its speed through tempo changes; a clip's tick length doesn't follow later
  tempo edits, as in FL). Tempo-synced plugins get `tempoAt(time)` from the planned segments and
  `onTempo(bpm, time)` at scheduled changes (the Delay retimes at that time).
- **Seek while playing** (`Transport.seek`, used by `Engine.play` when already playing): notes that
  haven't started are cancelled, sounding ones released, then playback continues. (Before, seeking
  dropped the note table without note-offs: held notes hung and lookahead notes still played.)
- **Audio clips across edits**: after a re-anchor, a clip whose sample is still sounding isn't started
  a second time (it was, about 6 dB too loud); a clip that was itself edited restarts from the new model.
- **Automation model** (`core/automation/`): `curve.ts` (shapes curve/hold/stairs/smooth, tension bend,
  `curveAt`), `targets.ts` (`resolveTarget`: spec, document value and the 0–1 mapping per target;
  volume faders and send levels use the fader taper, plugin params their own scale, tempo its clip
  range), `model.ts` (`automationModelOf`: spans per target key, structurally shared so unchanged
  targets keep their object; `automationAt`: base before the first clip, the curve inside, hold after,
  latest-starting clip wins; muted clips, lanes and automation channels don't count).
- **Recording** (`app/recording.ts`): R arms record mode; Play then starts every registered recorder
  (`services.recording.register({ id, start, stop })`) and Stop stops them.
- **Knobs follow automation**: SDK controls given a `param` subscribe through `ParamFollowContext`
  (`sdk/ui/param-menu.ts`); `ui/follow-automation.ts` reads every followed key once per frame with
  `engine.readAutomation` and repaints knobs imperatively (no React commits during playback).

## Automation (M9)

Automation clips play through the param lanes (M8a) like notes play through the transport: the
driver plans every segment before its notes go out, so a plugin reading `valueAt(noteTime)` in
noteOn sees the curve.

### Driver (`engine/automation/driver.ts`, `curve-plan.ts`)

- **Breakpoints in ticks** (`CurvePlanner`, pure): a target's spans become pieces on the song
  timeline (automationAt's rules: document value before the first clip, the latest-starting clip
  inside, hold after), each piece a run of intervals: constants (holds, stairs steps, before the
  first / after the last point) and curve segments between two points. Breakpoints are the interval
  boundaries plus an equal subdivision of each curve interval: at most 25 ms apart, at least 1 ms,
  and dense enough that the lane's linear ramps stay within the error target in the domain the
  target's AudioParams most likely live in (`rampError`: volumes and send levels 0.1 dB with a
  −60 dB floor, Hz and log-scaled params 1 cent, cents/semitones 1 ct, dB params 0.1 dB both in dB
  and in the gain they are usually bound through, anything else 0.2 % of the range). The density
  comes from 16 probe sub-intervals per curve (error ∝ length², ×1.5 margin). Where the value jumps
  at a boundary (a hold or stairs step, a clip starting on another value, two points on one tick)
  the jump becomes a 3 ms ramp. Discrete params (int/enum/bool opted in) get exact steps where their
  value changes (grid search + bisection).
- **Times** come from the *run* the breakpoints belong to: where playback started, was sought, or
  the loop last wrapped, plus the tempo map (`time = run.time + T(tick) − T(run.tick)`), never from
  the transport's accumulated segment times. The breakpoints don't depend on how the timeline was cut
  into segments, so offline renders are bit-exact at any chunk size (verified at 128·16, 128·37 and
  128·256, and WAV exports hash-identical). A wrap computes its run start from the previous run's
  loop-end time.
- **Per segment**: each lane is scheduled from its last breakpoint through the first breakpoint at
  or after the segment's end (never past the loop end), so a ramp's end is always scheduled before
  the audio reaches its start. Holds extend in one long constant ramp (endless holds 2 bars at a
  time).
- **Re-anchoring** (a target's model, document value or spec changed, a touch ended, a param was
  registered, playback started or sought, the tempo or loop changed): `cut(now + guard)` (guard ≥
  20 ms and ≥ base latency + 2 render quanta) and a short ramp from the value there to the new curve
  (3 ms; 5 ms from the held value on play; 30 ms after a touch). Only targets whose
  `TargetAutomation` changed are re-planned; a timeline change starts a new run for all. Changes are
  picked up at the next segment, so there is at most one re-anchor per lane per pump. Offline
  renders start exactly: `AutoLane.start(value)` at time 0, the value at the start tick.
- **Stalls**: a continuous lane whose schedule ended in the past (the main thread was busy) starts
  again from its current value at now + guard instead of jumping along a stale ramp.
- **Touch** (`touch(key, on)`): the drag's target is released to its document value (a 20 ms ramp)
  so the drag is heard; when the touch ends it ramps back to the curve over 30 ms. Edits that
  aren't gestures (undo, presets, typed values, wheel) only change the document value, which the
  curve uses before the target's first clip.
- **Stopped**: automated params hold the value being heard (`cut(now + guard)`); an edit of a held
  target lets it go (it's heard); playing again ramps from the held value. **Pattern mode** plays
  no playlist automation: every target goes back to its document value. Targets that lose their
  automation are released the same way. Tempo automation isn't the driver's: `tempoMapOf` turns it
  into the transport's map.
- Params that a plugin reads only through `onChange` hear every scheduled value change at its time
  (`AutoLane.onScheduled` → `ParamHandleImpl.emitScheduled`).
- **Lane changes** (`engine/param-lane.ts`): `cut(at)` keeps only a *running non-constant* ramp
  (whose end can't be cancelled without a jump); holds, constant ramps, steps and setTargets are cut
  right at `at`, so touches and edits take effect within the guard even in a long hold.
  `scheduledUntil`, `start(value)`, `onScheduled`, `segmentCount`; `ParamRegistry.subscribe` tells
  the driver about params registered while playing (a replaced plugin instance picks the curve up).
- Measured (Node, M-series): 50 automated log-scale targets, a pump every 25 ms with 120 ms
  lookahead: mean 0.10 ms, p95 0.38 ms; lanes stay under ~240 remembered segments. A bent 10-octave
  cutoff sweep stays within 0.61 cent and a fader-taper fade within 0.045 dB of the curve.

### App (`app/automation.ts`, `services.automation`)

- `createClip(target, at?)`: "Create automation clip": an automation channel named after the target
  (`targetName`: "Cutoff · 3xOsc", "Volume · Insert 3", "Mix · Reverb (Insert 2)", "Tempo") with two
  points at its current value, and a clip on the first free track (a new track when none is free)
  over the loop region, or 4 bars from the song position. Tempo clips span 60–180 BPM, wider when
  the tempo is outside. One undo step; the clip is selected.
- Touch from History: a gesture's changed targets (`targetsChangedBy`, read from the patches) are
  touched while it lasts (`History.inGesture`); the service listens before the engine, so automation
  lets go before the engine hears the first edit.
- Recording (`services.recording`, id `automation`): while recording in Song mode every gesture or
  edit of a target adds a sample at the audible tick and latches the touch until the take ends.
  Passes through the loop replace each other where they overlap (`mergePasses`); a take is thinned
  with Ramer–Douglas–Peucker (0.005) and goes into the clip of that target that covers it
  (`spliceCurve` keeps the curve around it) or a new clip over the bars it was recorded in, holding
  the value from before the first move. One undo step per take; toasts say what is being recorded
  and what was.
- `watch(key, cb)` / `statusOf(key)`: automated, muted or recording, with the hint text controls show.

### UI

- Playlist (`features/playlist/automation.ts`, controller): automation clips are titled by what they
  drive and draw their curve; points and curve handles show when the clip is selected or under the
  pointer (smaller, then only the one under the pointer, when they crowd). Drag a point (playlist
  grid, Alt = off the grid; it stays between its neighbours and inside the clip), drag a handle up
  or down to bend a curve segment, double-click or right-click the curve to add a point (it takes
  the shape of the stretch it lands in), right-click a point for Point shape (Curve / Hold / Stairs
  / Smooth) / Straighten curve / Delete point, double-click a handle to straighten it. The title bar
  behaves like any clip's (move, resize with content offset, slice, right-click deletes). Every
  part explains itself in the hint bar, drags show a value readout in the target's units, and clips
  that are flat or whose target was deleted say so. Each drag is one gesture.
- Clip ▾ menu (`features/automation`): Generate LFO… (`showFormDialog` with a live preview through a
  gesture: shape, one cycle every 1 step … 4 bars, depth, center, start; `lfoPoints` puts sine and
  triangle points only on the peaks, exactly, unless phase or length cut a half cycle), Shape of
  every point, Show what this controls, Delete this automation (all its clips).
- Param menus: "Create automation clip" on every automatable control (hidden otherwise) and "Show
  its automation in the playlist" once it has some.
- Controls: `ParamStatusContext` / `useParamStatus` (`sdk/ui`): an SDK Knob driven by a clip shows a
  blue dot (a ring when its clip is muted, pulsing red while recording) and adds "Automated by clip
  ‘…’ – right-click to edit" to its hint. The host provides it around its own knobs and in plugin
  windows. The BPM display gets a blue frame when the tempo is automated and shows the tempo being
  heard while playing (written on the frame loop; no React renders).

Not done: automation channels have no channel-rack row yet, and the mixer's faders don't show the
status dot (`useParamStatus(param)` is all a control needs).

## Mixer routing, sidechain and delay compensation (M10)

The mixer is `engine/mixer-graph.ts` (`MixerGraph`, owned by the Engine), with the strips in
`engine/insert-strip.ts` and the delay compensation math in `engine/pdc.ts` (pure, unit-tested in Node).

### Graph

Every insert id has persistent nodes (an `InsertBus`) that outlive its strip, so channels, routes and
sidechains never reconnect when a strip is rebuilt, deleted or restored by undo:

```
channels ──► chIn ─[pad: arrival]─► routeIn ─► slot 1 … slot N ─► scTap ─► gate ─► preTap ─► pan ─► fader ─► postTap
other inserts' routes ─[pad]──────► routeIn            sidechain out ◄─┘  mute/solo  pre sends ◄─┘   post sends, meters ◄─┘
                                                                                     (master: postTap → masterOut → limiter)
route  : tap (pre or post) ─► level (AutoLane, `route:from:to`) ─[pad]─► target routeIn
key    : source scTap ─[pad]─► the slot's effect host.sidechain   (the slot's own input when no source is chosen)
slot   : in ─► bypass ──────────────────────────────────────► out   1 while not live (bypassed, loading, missing, failed)
          ├─► dryGate ──────────────────┐
          ├─► DelayNode(latency) ─► align ┴─► dryMix (1 − mix) ─► out   dryGate without latency, align with it
          └─► fx.input … fx.output ─► wetGate ─► wetMix (mix) ───► out
          mix = one ConstantSourceNode (offset written only by the `slot:…:mix` AutoLane) → wetMix.gain, → ×(−1) → dryMix.gain
```

- **Gate and tap order.** The mute/solo gate sits after the effects and before the pre-fader tap, so muting an insert
  (or a solo that leaves it out) silences its pre-fader sends too. The sidechain tap is taken before the gate: a
  muted or solo-silenced kick still keys a ducker, so soloing a ducked bass still ducks. The sidechain tap is also
  before pan and fader (the kick's fader doesn't change how hard it keys).
- **Channels** connect to `chIn` (`Engine.insertInput(id)`): it feeds the insert while it exists and the master
  otherwise (not created yet, deleted, unknown id). Routes land on `routeIn`. A route to a missing insert carries
  nothing; an insert with no route is silent.
- **Edges and loops.** The engine follows `playableEdges(mixer)` (`core/query/routing.ts`): routes in mixer order (each
  insert's routes in order), then sidechains (mixer order, slot order), skipping edges from or to a missing insert,
  routes from the master, repeated targets and anything that would close a loop. Repair and the ops refuse loops
  already; this keeps even a damaged document from looping. Each edit disconnects what went away (routes, and
  sidechain inputs whose source changed, which fall back to their own input) before anything new is connected, so
  audio never loops, not even for one render quantum.
- **Sidechains.** A slot with `sidechain = S` gets S's `scTap` into its effect's `host.sidechain` (worklet effects: the
  node's second input, the kernel's fifth `process()` argument). With no source chosen the slot feeds its **own input**
  to the sidechain, so sidechain effects key from themselves (a compressor compresses on its input) and their presets
  work anywhere. Changing the source only rewires; the effect is never recreated. Each instance owns its key
  connection: a replaced instance keeps its key while it fades out, a new one is keyed when its async `create()`
  resolves, and a bypassed effect's input and key are both disconnected after the fade.
- **Slot mix** is automatable through its own ConstantSource (target `slot:insert:slot:mix`); bypass, loading,
  missing, failed and instance swaps are separate gates that glide (~10 ms; exact at time 0 offline). A slot that isn't
  live is exactly its input: bypass 1, every other path 0, so a bypassed slot renders bit-exact with no slot.

### Delay compensation (PDC)

In whole frames: an effect's `latency` (seconds) is rounded to `Math.round(latency · sampleRate)` frames.

- Only live slots count (enabled, loaded, not faulted; an effect's latency is only known once its async `create()`
  resolves). Slots report changes (load, enable, bypass, replace, fault) and every routing edit recomputes; edits are
  batched per reconcile.
- For an insert X: `before(X, k)` is the latency ahead of slot k and `fx(X)` that of all its slots.
  `arrival(X) = max(0, out(S) for every route S → X, out(S) − before(X, k) for every sidechain S → X keying a live slot k)`
  and `out(X) = arrival(X) + fx(X)` (the latency at X's taps), solved in topological order (Kahn).
- Every shorter edge is padded up to that: channels into X by `arrival(X)` (on `chIn → routeIn`), a route S → X by
  `arrival(X) − out(S)`, a sidechain S → X (slot k) by `arrival(X) + before(X, k) − out(S)`. So a sidechain key arrives
  at its effect at the same time as the audio it controls, and a track keyed by a latent track waits for it.
- Paddings are DelayNodes of exactly `n / sampleRate`, created only where the padding is above 0, so paths without
  latency stay plain connections and bit-exact. Each padded link (`PadLink`) has its own gain: when its delay or
  target changes while a realtime context plays, the old path fades out over 10 ms as the new one fades in (a brief
  comb, instead of a click); offline and before the context starts it switches exactly.
- `graphLatency()` is `out(master)`: the longest path to the master's output, in seconds. The playhead, the step
  lights, `readAutomation` and `tempoNow` read the transport at `audibleTime() − graphLatency()`, so they follow what is
  heard. The engine notifies subscribers when it changes (the mixer shows "Delay comp. N ms").
- `tailSeconds()` follows the routing depth (effect tails add up along the deepest route path to the master) plus the
  latency. `renderOffline` keeps its defaults and reports `latency` in its result; WAV export doesn't trim it yet.
- Not compensated: automation of a control that sits after latent effects (an insert fader, a send level) lands early by
  that latency; the automation driver could offset by `MixerGraph.compensation.out(insert)` per target. The master
  limiter's 1.3 ms isn't part of `graphLatency()`.

### Solo

FL's rule, `soloState(inserts)` in `core/query/mixer.ts` (memoized; `effectivelyMutedInserts` uses it): with any
non-master insert soloed, the soloed inserts, everything routed into them (recursively: their sources play fully),
everything they route to (recursively, so they still reach the master) and the master stay audible; every other
insert is gated. Routes count, sidechains don't (see the tap order above). Channels routed straight to the master are
never silenced by an insert solo. The mixer dims strips a solo silences.

### Effects

- **Compressor** (`plugins/builtin/compressor`): a worklet kernel with the v1 param ids and ranges plus `scFilter`
  (12 dB/oct high-pass on the key, off at its 20 Hz minimum) and `listen` (hear the filtered key). Zero latency (no
  look-ahead, so it adds no delay compensation): a stereo-linked peak detector, the Giannoulis/Massberg/Reiss soft-knee
  static curve, and the gain reduction smoothed in dB by an `EnvelopeFollower` (attack/release time constants). Below
  the threshold it is bit-exact unity.
- **Ducker** (`plugins/builtin/ducker`): finds hits on the key (its envelope crossing the threshold, re-armed 3 dB
  below it, or jumping 6 dB within 8 ms on a tail that is still above it, with a 30 ms refractory time) and plays the
  same duck for each: down to 1 − depth over `attack`, `hold`, back up over `release` bent by `curve`. So a long kick
  tail doesn't hold the duck down and every hit pumps the same. Tempo-synced shapes need transport in kernels (later).
- **Gate** (`plugins/builtin/gate`): peak follower on the key, open above the threshold, closing 4 dB below it
  (hysteresis) after `hold`; exponential attack/release; `range` is the closed level; `listen` hears the key.
- New SDK DSP (`sdk/dsp`, exported from `@agstudio/sdk` and `/worklet`): `OnePole` (cutoff or time constant,
  low/high-pass), `Svf` (Cytomic trapezoidal state-variable filter: low/high/band/notch/peak/all-pass/bell/shelves,
  stable under per-sample modulation; `low + band + high` is the input), `EnvelopeFollower` (peak or RMS,
  attack/release). The worklet runner pads missing inputs and the sidechain without allocating.

### UI (`ui/features/mixer`)

Routing is relative to the selected insert, FL-style. Every strip says where it goes ("→ Master", "→ Reverb bus,
Master", "→ Speakers"); every other strip has a send arrow (lit when the selected insert sends there, disabled with
the reason when it would loop) and, when sending, a "Send to <name>" knob in dB (target `route:from:to`, so the
automation/MIDI param menu works). Badges: IN (feeds the selected insert), SC (keys one of its effects). Right-clicking
a strip keeps the selection and offers, for the selected insert: Send to this track, Route only to this track, Send
before the fader (pre), Sidechain to this track (its sidechain effects, or add a Ducker or Compressor keyed by it);
and for the strip itself: Route only to Master, Remove all sends. A slot's menu has "Sidechain from ▸" (tracks by
name, current checked, loops disabled); keyed slots show "SC: <name>". Menu entries carry hints, so disabled choices
explain themselves in the hint bar. Every edit is one undo step (`app/actions/mixer.ts`: `toggleRoute`, `routeOnly`,
`setRoutePre`, `removeAllRoutes`, `setSidechain`, `addSidechainEffect`).

### What M10 verified in Chrome

Measured with offline renders (`test/browser/routing.test.ts`, `mixer.test.ts` keep checking them):

- A DelayNode set to `n / sampleRate` delays by exactly n frames, bit-exact, at 22.05, 44.1, 48 and 96 kHz (any n
  tried, 1–2047), so delay compensation keeps parallel paths sample-identical: an impulse through a 375-frame effect
  and its dry parallel send sum to the bare impulse shifted by 375 frames, exactly.
- An AudioWorkletNode input connected to a node with nothing playing arrives with zero channels (it had 2 while its
  source was scheduled but not started), so a kernel can't tell "no sidechain" from "a silent one"; hence the host
  feeds a sidechain effect's own input when no source is chosen.
- Gains driven by a ConstantSourceNode into a GainNode's gain param (intrinsic 0 for wet, 1 + inverted mix for dry) are
  exact at mix 0 and 1.
- A −6 dB send adds exactly the expected energy: alone the target hears the source at the send level (energy × level²);
  in parallel the sum is 1 + level, sample for sample (≤ 1e-6).
- Disabled `<button>`s still receive `pointerover`, so the hint bar shows why a menu choice is disabled.

## Composition tools and note scripts (M11)

Piano-roll tools are note scripts (plugins), music theory lives in a public SDK module, and every tool goes through
History like any other edit.

- **`@agstudio/sdk/notes`** (`src/sdk/notes/`, pure TS, property-tested with fast-check):
  - `scales.ts`: 22 scales (`SCALES`, `getScale`; unknown ids read as major), `scaleMask`, `inScale`, `scaleNotes`,
    `snapToScale(key, root, scale, 'nearest' | 'up' | 'down')` (ties go down, stays in 0–127), absolute scale steps
    (`scaleStep`/`keyAtStep`), `transposeInScale` (out-of-scale notes keep their offset above the scale note below),
    `noteName` (FL octaves, 60 = C5), `keyLabel` ("C# minor").
  - `chords.ts`: 30 chords from power chords to 13ths (`CHORDS`), `chordNotes(root, id, { inversion, voicing })`,
    `invert`, `voice` (close, open, drop2, drop3, bass, spread), `diatonicChord` (stacked thirds of a scale),
    `diatonicQuality`, `detectChord` (prefers the reading with the root in the bass).
  - Transforms on `ScriptNote[]` (new objects; a kept `id` = an edit, no id = a new note): `quantize` (grid, strength,
    starts, ends or lengths, swing lattice, window; idempotent at 100%), `humanize`, `legato`, `chop` (grid or parts,
    gate), `glue`, `strum`, `arpeggiate` (8 patterns over overlap groups, rate, gate, octaves, range), `flip` (time or
    pitch, an involution), `stretch`, `transpose` and `transposeDegrees` (the shift shrinks instead of clipping),
    `snapNotesToScale`, `limit`, `chordify`, `scaleVelocities` / `fitVelocities` / `rampVelocities`, `randomize`, and
    `generate` (a fixed number of `rand()` values per grid cell, so raising the density only adds notes). Helpers:
    `clampNote`, `span`, `chordGroups`, `overlapGroups`, `bend`, `seeded`.
- **Running a script** (`app/actions/note-scripts.ts`): `scriptTarget(s)` is the selected instrument channel's notes in
  the current pattern (the selection, or all of them), the piano roll's snap (`gridTicks`), the bar and pattern lengths
  and `transport.key`; `scriptTargetFor(s, { channelId, patternId, noteIds?, grid? })` builds the same from explicit ids
  and `applyNoteScriptById(s, id, values, where?)` runs an installed script as one undo step (the entry point for the
  AI and other tools). `runNoteScript(def, input, values)` freezes the input, resolves values, seeds `rand` from the
  script id, the notes and the script's `seed` param only (dragging another knob doesn't reshuffle the result), catches
  errors and checks the output (finite numbers, ≤ 50 000 notes) into `NoteScriptError`s that the UI toasts.
  `planNoteReplacement` (core, `ops/note-replace.ts`) turns the result into removes and full target notes (an id that
  isn't an input, or repeats one, becomes a new note; optional fields left out keep the input's value; neutral values
  clear them) and `applyNoteReplacement` writes it with `writeNotes`, which only touches notes that differ from the
  state the recipe started from (no draft proxies for 10k unchanged notes).
- **Live preview** (`ScriptPreview`): one history gesture per dialog. Each `update(values)` re-runs the script on the
  original notes and applies an absolute recipe on top of the previous preview (new notes reuse a pool of ids; the ones
  a smaller result no longer needs are removed), so the engine plays the preview and the patches stay small; `commit`
  is one undo step, `cancel` restores the notes and the selection. `openNoteScript` (ui) coalesces dialog changes to one
  update per animation frame (50 ms when frames are paused) and remembers each script's last values for the session.
  Scripts without params run directly; a failed update keeps the last good preview and toasts once per message.
- **Built-in tools** (`src/plugins/builtin/note-tools`): one module exporting 20 `defineNoteScript`s over the SDK
  (Quantize, Humanize, Make legato, Strum, Stretch, Chop, Glue, Flip, Set length, Limit range, Transpose, Snap to
  scale, Make chords, Scale velocities, Velocity range, Velocity ramp, Arpeggiate, Randomize, Generate melody, Chord
  progression), categories Timing/Edit/Pitch/Velocity/Generate. Descriptions are written as the dialog's first line;
  labels carry units (note values for times, note names for keys, %, st, beats). `templates/note-script` +
  `npm run new:plugin -- --kind note-script --id user.x` scaffold a user script.
- **Menus**: the toolbar's "Tools ▾", Edit > Piano roll tools and the right-click menus list `registry.scripts()` by
  category, built when they open (hot-reloaded scripts appear at once). The common tools come first by plain name.
  Dialog tools have FL-style shortcuts (Alt+Shift+Q, Alt+A, Alt+S, Alt+U, Alt+G, Alt+R; Mod+L makes legato).
- **Right-click in the piano roll**: erases with Draw/Paint/Delete/Mute/Slice (FL). With the Select tool, or with
  Ctrl/Cmd held, it opens the note menu (on a note: it becomes the selection) or the empty-space menu; a right-click on
  empty space that doesn't drag or erase anything opens the empty-space menu too. Both menus append
  `extraMenuItems('pianoRoll.note' | 'pianoRoll.empty')`.
- **Song key** (`setSongKey`, one undo step): "Key: A minor ▾" in the toolbar and the empty-space menu. "Highlight
  scale" shades out-of-scale rows, tints the root's rows and dots the scale's keys; "Snap to scale" snaps drawn and
  painted keys and moves dragged notes by scale steps (`stamp.ts`, pure). Both are editor state, not document.
- **Chord stamp**: drawing or painting places `stampKeys(key, chord, inversion, songKey)` (any chord type, or the
  key's triads/7ths) as one "Add chord" step; the outline and the chord's name follow the pointer and the hint bar
  lists its notes.
- **Event lanes** (`lanes.ts`): velocity, pan, release or fine pitch (bipolar lanes draw from a centre line with
  R/L or ±100 ct marks), a live readout in units next to the lane name, right-drag resets. `NoteEdit`/`editNotes` handle
  pan, muted, release and fine (neutral values remove the field). The Mute tool (T), select same key, mute/unmute and
  transpose-by-scale-step are commands too.
- **Step sequencer** (`core/ops/steps.ts`, `ui/features/channel-rack/steps.ts`): fill every 2/4/8 steps, rotate
  (wraps), shift (drops what falls off), reverse, randomize and clear, from the rack header's "Steps ▾", the channel
  menu and Patterns > Steps of the selected channel; Mod+Shift+Left/Right rotate. The graph editor (one channel at a
  time, `editor.stepGraph`) draws velocity, pan, release, pitch (±24 st from the root key) or fine pitch per step on a
  canvas lined up with the step buttons, redrawn from document subscriptions rather than React renders.
- Measured (headless Chrome, M-series, `?perf=notes10k`): piano roll redraw median ~1.0 ms, p95 ~2 ms with a song key,
  the pan lane and a chord stamp on.

## Metronome, MIDI and note recording (M12)

- **Live input** (`app/live-input.ts`): MIDI (`app/midi-input.ts` parses notes, CCs, the sustain pedal and
  14-bit pitch bend with each message's timestamp), the typing keyboard and the on-screen piano all go
  through `services.live`: it plays the selected channel (notes, `previewControl` for controllers,
  `previewPitchBend` ±2 semitones) and tells listeners with the AudioContext time the event was heard
  at (`engine.contextTimeAt(performance time)`).
- **Metronome** (`engine/metronome.ts`): a transport observer that schedules a click on every beat of each
  planned segment (an accent on the downbeat) on the monitor bus (after the master track, before the
  limiter; realtime engines only, so exports never hear it), cancelled on re-plans, seeks and stop.
  **Count-in**: while record is armed the engine plays `countInBars` of clicks and starts the transport
  after them. Session settings come from the prefs (`metronome`, `countInBars`) through `setSession`.
- **Record mode** (`app/recording.ts`): R arms; Play starts registered recorders. **Note recording**
  (`app/note-recorder.ts`): live notes go into the current pattern on the selected channel at the tick they
  were heard (`engine.tickAt`; song mode: where that pattern's clip is under the playhead), starts snapped to
  the record-quantize grid, loop passes keep adding, "replace" mode removes the notes a new note overlaps;
  one History gesture per take.
- **MIDI files** (`core/io/midi.ts`, `app/actions/midi.ts`): SMF formats 0/1 in (running status, FIFO note
  pairing, PPQ rescaled to 960, tempo/time-signature/name/program meta), format 1 out (conductor track +
  one track per channel). Import: GM drums go to the kit's sampler channels (reused when present), other
  parts get an instrument by GM family (keys/pluck/bass/pad/lead), one pattern per track or one for all,
  optional tempo and time signature, tempo changes as a held tempo automation clip, optional playlist
  placement; one undo step. Export: the song as it plays (swing included) or the current pattern; kit
  channels as GM drums on channel 10. File menu and drops of .mid files anywhere.
- **MIDI learn** (`app/controllers.ts`): "Link to controller…" on every param menu waits for the next
  control change (sustain, bank select and channel-mode messages are ignored) and stores a link in the
  project; a linked controller writes its target through `setTargetValue` (`core/ops/targets.ts`) with one
  merged undo step per move and touches the target so automation lets go while it moves.
- **Hum to notes** (`app/actions/hum.ts`): record over the pattern after a count-in; the voice analysis
  (tonal mode) and the grid quantizer turn it into notes on the selected channel (one undo step).
- **On-screen keyboard** (`ui/features/midi/PianoKeyboard.tsx`, Alt+7): plays with the mouse (velocity
  from where the key is pressed) and lights up what any input plays.
- **AI**: `transport` actions can `record` (arm and play) and switch the metronome.

## AI studio: the AI controls the project (M16a)

The assistant window is an AI studio: every turn, Claude answers with `{ message, actions[] }`
(`app/ai/schema.ts`, structured output: `anyOf` per op, closed objects, plugin settings as
`[{ name, value }]`), and `app/ai/apply.ts` applies the actions as **one History transaction**
(one undo step per answer).
- **Ops**: `song` (tempo, swing, key, time signature), channels (`add_channel` with plugin, kit sample,
  preset, params, volume, pan, mixer track; `edit_channel` incl. instrument swap; `remove_channel`),
  mixer (`add_insert`, `edit_insert`, `remove_insert`, `add_effect`, `edit_effect` incl. replace and
  move, `remove_effect`, `route`, `unroute`, `route_only`, `sidechain`), patterns (`add_pattern`,
  `edit_pattern`, `remove_pattern`, `write_notes`, `clear_notes`), the playlist (`place_pattern`,
  `clear_playlist`), `beat` (the beat writer, sharing `planBeat`/`writeBeat` with the beat assistant),
  and after the edit `transport` (play/stop/mode) and `open` (windows).
- **References**: ids from the context, exact names, mixer numbers or "master", and `@refs` for things
  created earlier in the same answer. Plugin settings are coerced to each param's spec (option ids or
  labels, on/off, "50" for a 0–1 % param, clamped ranges); levels are dB. An action that can't apply is
  skipped with a warning (shown in the chat and sent back with the next turn); the rest still apply.
- **Context** (`app/ai/context.ts`) each turn: song, channels with non-default plugin settings and
  routing, mixer tracks with levels, routes, effects (settings, bypass, sidechains), patterns (notes of
  the current one), playlist clips and the selection. The **plugin catalog** (`app/ai/catalog.ts`:
  every param with type, range, unit, default, plus presets) is sent at the start of a conversation
  and whenever it changes. The system prompt (`app/ai/prompt.ts`) carries the control rules and the
  beat/mixing know-how.
- **Transport**: `ClaudeChat` (`app/assistant/claude.ts`) posts each turn to `/api/ai/chat` (`/beat`
  still works) with the system prompt, schema and text; a malformed answer is sent back once for a fix.
  The subscription backend's CLI prompt is task-neutral. Without Claude, beat requests still go to the
  offline generator.
- **Rule for new features**: each feature adds its ops here (and what the context needs), so the AI can
  drive it.
- **More ops since M16a**:
  - `automate`: an automation clip for any target, with points in the control's own unit or an LFO;
  - `note_tool`: any piano-roll tool from the catalog;
  - `steps`;
  - `marker`;
  - `edit_audio_clip`, and audio-channel pitch, reverse and tempo-follow through `edit_channel`;
  - `build_plugin` (below).
- **App commands**:
  - The `command` action runs any registered command by id (`app/ai/commands.ts`). The first turn, and any
    turn after the list changes, sends `<commands>` with every command's id, title, hint and `argsHint`.
    So every menu entry, button and shortcut is something the AI can do: save, export, undo, windows,
    layouts, settings… New features' commands join automatically.
  - `CommandDef.gesture` marks commands that open a file dialog. The AI studio shows a one-click
    confirmation, and that click is the user activation the browser needs.
  - `ai: false` keeps a command away from the AI.
  - The context's App line names the file and its saved state, recent projects, what is switched on, and
    what Undo would revert.
- **Plugin builder** (`app/ai/builder*.ts`, `tools/ai/drafts.ts`, `plugin-test.html`):
  1. `build_plugin` hands a spec to a separate builder conversation. Its system prompt is the SDK guide
     plus the templates, and it answers with files.
  2. The dev server writes the draft to `plugins/_drafts/<name>/` and checks it: flat names, size caps, SDK
     and React imports only, no network, storage, eval or dynamic import, then `tsc` in the main and worklet
     scopes, run with the server's own Node.
  3. A hidden iframe renders it offline: it must define a valid plugin, make sound, stay finite and stay
     under the master limiter.
  4. Problems go back to Claude, for at most three fix rounds.
  5. Install moves the folder to `plugins/<name>/`, backing up an older one in `plugins/_backup/`, and hot
     reload registers it. `plugins/_*` is outside `tsc -b`, eslint, vitest and git.

## Wave 2 foundations

- Kernel transport:
  - Worklet kernels see the song as `this.transport` (`playing`, `bpm`, `beatAt(i)`).
  - `engine/kernel-transport.ts`, a transport observer, sends `EV_TRANSPORT` anchors through each port's event
    queue: at a start, seek, re-plan, stop, loop wrap or tempo change (including tempo changes while stopped).
  - A re-plan anchor drops the anchors queued at or after its frame, the way a noteOff cancels a pending note.
  - Anchors come only at real discontinuities, never at the scheduler's own slices, so offline renders stay
    bit-exact at any chunk size (`test/browser/kernel-transport.test.ts`).
  - Effect kernels get the anchors due in a block at its start; instrument kernels get them at the exact frame.
  - A port created mid-song gets the recent anchors replayed (`PortSet.onAdd`).
- Shared DSP in `src/sdk/dsp` (exported from `@agstudio/sdk` and `/worklet`): `Adsr`, `BlepOscillator`/`polyBlep`,
  `DelayLine` (linear/cubic), `Lfo` (free or `atBeat`), next to `Biquad`, `Svf`, `OnePole` and `EnvelopeFollower`.

## Instruments (M13)

Five worklet instruments in `src/plugins/builtin/` (public SDK only), each with a custom editor, presets, kernel tests
in Node (`*/kernel.test.ts`) and offline renders through the real engine (`test/browser/instruments.test.ts`).

### Shared patterns

- **Heavy data is built on the main thread.** `defineWorkletInstrument({ setup(port, host) })` (new, additive) runs
  once the processor exists and before any note reaches it: the Wavetable sends its bank, Drum Pads its rendered
  sounds, the Slicer its demo loop. Building them in a kernel constructor would stall the audio thread (the bank
  takes ~40 ms). The bank lives in a `SharedArrayBuffer` when the page is cross-origin isolated (dev, preview), so
  every kernel reads one copy; elsewhere (Vitest's browser) each port gets a structured-clone copy (3.3 MB).
- **Notes start inside `render`.** Params only arrive with `render()`, and an event at frame 0 of a block reaches
  `noteOn` before that block renders. So `noteOn`/`noteOff` queue and the queue is handled at the top of the next
  `render(from, …)`, which starts at the event's frame, with `at(p.x, from)`. Presets and voice modes therefore
  apply from the first note of an export (a test renders the first note with two settings and compares).
- **Control rate.** Wavetable (every 32 samples) and FM (16) run envelopes (`new Adsr(sampleRate / CONTROL)`),
  LFOs, the mod matrix, pitch and filter coefficients per step and glide levels, morphs and gains linearly in
  between; voices render in segments that end at control points, with their hot state in locals.
- **Click-free stealing.** A stolen voice keeps its level and oscillator phases and restarts its envelopes from
  where they are (Adsr retriggers from its value); a new voice resets phases (FM: Yamaha-style phase 0).
- **Determinism.** Unison start phases come from `host.rand()` at note start, noise from per-voice seeded `Noise`,
  drum hits from seeded models: two renders are bit-identical, also at other chunk sizes (tested).
- **One-shot drums.** Drum Pads, Drum Synth and the one-shot Slicer ignore note lengths; hard all-notes-off fades
  or cuts within 5 ms; a note-off before the voice rendered cancels it.

### Wavetable (`wavetable/`)

- **Bank** (`sdk/dsp/wavetable.ts`): tables are `WavetableSpec`s writing a Fourier series per morph position
  (k = 1…256): `addPiecewise` integrates straight-line shapes exactly (saw, pulse, hard-sync saw: no aliasing even
  at level 0), `addSampled` FFTs smooth curves at 8192 points. Each frame is synthesized at 9 mip levels by inverse
  FFT: level m keeps harmonics 1…256≫m, stored at 2048, 1024, 512 and then 256 samples (+1 wrap-around sample), so
  linear reads stay ≥ 8 samples per period of the top harmonic; frames are normalized to peak 1 at level 0.
  `levelFor(cyclesPerSample)` = ⌈log2(512·f/sr)⌉: the richest level whose top harmonic stays below Nyquist (for the
  highest unison copy, per control step). 10 tables × 16 frames = 3.3 MB, ~40–50 ms to build. The private radix-2
  FFT in wavetable.ts only builds tables (the effects milestone owns the SDK's FFT file; consolidate later).
- **Tables** (`tables.ts`, in the order of the `oscNTable` enum): basic (sine → triangle → saw → square, all with a
  +sin fundamental so blends don't cancel), pulse width (50 % → 3 %), sync sweep (slave 1× → 8×), harmonic series
  (1 → 24 partials), vocal (a e i o u formants at a 110 Hz voice), formant sweep, organ registrations, glass, CZ-style
  resonant sweep, digital grit. Additive tables use Schroeder phases (low crest factor, so they stay loud).
- **Voice**: 2 oscillators × 1–8 unison copies (detune spread evenly, ±spread across the stereo field, 1/√n gain),
  morph between adjacent frames (crossing a frame boundary is continuous, neighbours share a frame); a sub (sine,
  triangle, PolyBLEP square; 1 or 2 octaves down) and one-pole-filtered noise; drive (`softClip`, normalized) into
  the `Svf` (12 dB, 24 dB = two stages, high-pass, band-pass, notch), cutoff × 2^(8·(envAmount·modEnv + mods) +
  keyTrack·(pitch − 60)/12); amp ADSR × velocity × volume mod; balance pan.
- **Mod matrix** (6 slots, amount −1…1): sources mod env (0…1), LFO 1/2 (−1…1), velocity, mod wheel (CC 1,
  smoothed 20 ms), key ((key − 60)/60); destinations pitch (100 % = ±24 st), positions (±1), cutoff (±8 octaves),
  resonance (±1), volume (×(1 + m), 0…2), pan (±1), LFO speeds (×2^(4m), from the previous step, so an LFO can't
  feed its own rate).
- **LFOs** are per voice: synced and playing → `lfo.atBeat(transport.beatAt(i), beats)` (lands on the beat, tested at
  120 and 93 BPM through the engine); synced while stopped → free at the tempo's rate (so previewing still wobbles);
  "Restart each note" off → a voice starts at a shared free-running phase.
- **Voice modes**: poly (16 voices; glide slides each new note from the last one), mono and legato on voice 0 with a
  note stack (last-note priority, releasing returns to the newest held key without a new attack); legato doesn't
  retrigger overlapping notes; glide is constant-time and linear in semitones.

### FM (`fm/`)

- `FM_ALGORITHMS` (`sdk/dsp/fm.ts`): the TX81Z/DX21 set — 1: 4→3→2→1, 2: (3+4)→2→1, 3: (4 + 3→2)→1,
  4: (4→3 + 2)→1, 5: 2→1 and 4→3, 6: 4→(1, 2, 3), 7: 4→3 plus 1 and 2, 8: 1+2+3+4. Modulators always have higher
  numbers, so the kernel computes 4, 3, 2, 1 each sample through a 4×4 matrix (no branches per algorithm).
- Operator: `sinCycles` (4096-point table) with phase modulation in radians; a modulator at full level shifts by 2π
  (`MOD_DEPTH`); levels follow level² × envelope × velocity factor; frequency = note × ratio (0 = ½) × (1 + fine),
  capped below Nyquist. Operator 4's feedback averages its last two outputs (Yamaha) and is capped at 1.5 rad, where
  it is a saw; above ~1.7 rad it turns to noise (measured). Carriers sum × 1/√n; an optional `Svf` low-pass (off at
  the top of its range); vibrato; the mod wheel brightens (modulators × (1 + wheel)) or adds 50 ct of vibrato.
- The editor draws the algorithm from the same table (heard operators orange, the feedback loop when on) and names
  each operator's role and effective ratio. Kernel tests check each algorithm: heard operators are pure sines at
  their frequencies, modulators alone are silent, a first-order sideband exists on a heard operator exactly where
  an arrow points, and a modulator changes nothing once the operator it feeds is silenced.

### Drum Pads (`drum-pads/`)

- Sample slots `pad1…pad16` on keys 36–51; an empty pad plays the built-in sound its `padNSound` enum picks (21
  sounds rendered from the SDK drum models on the main thread, cached per sample rate, each normalized to a mixed-
  kit peak level: kicks 0.9 … cymbals 0.35–0.4). The default kit is the General MIDI map 36–51 (hats in choke group
  1), so GM drum files and the AI's beats play it directly, and kits are just params (presets, AI).
- Per pad: tune (resampling: `SampleReader` speed = srcRate/sr × 2^(st/12)), level, pan (balance: the centre keeps
  both sides at full level, like the Sampler with stereo sounds), decay (T60 fade; the maximum plays everything),
  reverse, choke group 0–4. A hit fades out (4 ms) every sounding voice whose pad is in its group, earlier hits of the
  same pad included. 32 voices, oldest stolen.
- Editor: FPC layout (pad 1 bottom left); a press plays the pad (higher up = louder) and selects it; drops go through
  `PluginUIProps.samples.drop` (desktop files, sample-browser files, browser-panel kit sounds); the selected pad's
  strip has Choose file…, Kit sound…, Remove sample and its params.

### Slicer (`slicer/`)

- Sample slot `main`; slice n plays on key 60 + n (up to 64). While the slot is empty it slices a built-in demo
  break (`demo.kernel.ts`: two bars at 120 BPM from the drum models, rendered at a fixed 48 kHz so the editor and the
  kernel slice identical audio; the kernel resamples).
- Slicing (`slices.kernel.ts`, shared by kernel and editor) runs on the 256-frame peak overview — in the editor the
  host's `waveform(slot)`, in the kernel `peakOverview` of the same decoded buffer — so markers and playback agree.
  `detectSlicesInto`: a bucket starts a slice when its level (dB) jumps above the quietest of the previous three
  buckets by 14 dB (sensitivity 0) … 2 dB (1) and is no quieter than −30 … −60 dB under the loudest point; only the
  first bucket of a rise counts; hits closer than the shortest slice merge; silence before the first hit is skipped
  (sound before it stays in slice 1). Grid mode cuts equal parts. Slices are recomputed (O(buckets), no allocation)
  only when the audio or a slicing setting changes; slicing params aren't automatable (it would remap keys).
- Playback: one-shot (to the slice end, 2 ms end fade) or gated (linear release); cut fades the previous slice (4 ms);
  tune (resampling), reverse, attack, velocity.
- Caveat: an export at another sample rate decodes the sample at that rate, so a borderline hit can slice
  differently than in the editor (the demo loop never does: it is always 48 kHz).

### Drum Synth (`drum-synth/`)

- Seven models from `sdk/dsp/drums.ts` on the GM keys: kick 35/36 (sine with an exponential pitch drop, noise click,
  drive), perc 37 (two PolyBLEP squares through a band-pass: cowbell at ratio 1.48, rim/clave near 1), snare 38/40
  (two head modes + high-passed noise), clap 39 (band-passed noise, three bursts and a tail), closed hat 42 (44 =
  shorter, darker pedal hat) and open hat 46 (the 808's six square oscillators at its metallic ratios, band- and
  high-passed), tom 45 with 41/43/47/48/50 at −7, −4, +3, +5, +8 st. Small voice pools per model (2–4), oldest
  stolen; "Closed cuts open" (default on) chokes ringing open hats on any hat hit.

### What M13 verified

- Wavetable mips: for keys 84–120 the energy that isn't a harmonic stays below −63 dB (C7) … −90 dB (a naive saw at
  the same pitch is above −30 dB); a note whose 2nd harmonic would pass Nyquist plays a pure sine (< −60 dB).
- 16 voices × 4 unison × 2 oscillators (lp24, osc 2 on): 8.5 s of audio renders in 0.57 s, **about 15× real time**
  (headless Chrome, M-series Mac; `instruments.test.ts` logs the factor and asserts > 2×).
- Every instrument: sound at the first note, nothing before it, silence after the release, finite, peak below 0.95 (the
  limiter never acts), no DC; bit-identical renders at chunk sizes 128·256 and 128·37; every pair of presets differs by
  more than 1.5 dB in a spectrum + loudness-envelope fingerprint.

### Limits and follow-ups

- The AI can't fill Drum Pads' pads with samples: `add_channel`'s `sample` only sets a `main` slot. It drives the kit
  through `padNSound`/`padNTune`/… and the kit presets; the Slicer takes a kit sound as its `main` sample (or plays
  the demo loop, though the AI still warns "has no sample yet"). The catalog grows by ~26 KB for these five plugins,
  mostly the 21-option pad-sound enum repeated 16 times: `catalog.ts` could print shared option lists once.
- Pad and slice clicks in the editors play through `engine.previewNoteOn` and aren't recorded into patterns.
- Wavetable: no crossfade between mip levels (a fast pitch sweep across an octave boundary drops the top octave of
  harmonics at once); the shape preview shows the knob's position, not the modulated one. FM: operator envelope
  times are read at note start.
- Slices are derived, not stored: no hand-moved markers yet.

## Faust plugins (M18)

- `tools/faust/compile.ts` compiles `.dsp` source with faustwasm's own WebAssembly build of the Faust compiler,
  in Node: `-ftz 2`, single precision, results cached by a hash of the source.
- `tools/faust/vite-plugin.ts` (also registered for worker bundles) turns `import dsp from './x.dsp'` into
  `{ name, kind, meta, processor, processorName }`.
  - `processor` is a virtual worklet module `x.dsp.<hash>.faust.js`. Its `.js` name makes the dev server serve it
    as a module, and the hash makes each edit a new module and processor name (a context can't re-register one).
  - That module calls `registerFaustKernel(name, meta, base64Wasm, kind)`.
  - A compile error becomes an import error (a broken plugin with the Faust line). `?raw` passes through.
- `@agstudio/sdk/faust`:
  - `faustControls(meta)` (shared by both threads) maps the Faust UI JSON to ParamSpecs: labels, ranges, units,
    log scale, tooltips, groups, camelCase ids, `[n]` order. For instruments it sets the voice controls
    (`freq/gain/gate/key/vel`) apart.
  - `defineFaustEffect` and `defineFaustInstrument` build plugin definitions on `host.worklet({ name })`.
- The kernel (`sdk/faust/kernel.ts`):
  - It instantiates the wasm (internal memory, math imports only) with faustwasm's layout: the struct at 0, then
    the channel pointer arrays, then one 128-frame buffer per channel.
  - It sets changed params per block and computes in 128-frame slices.
  - Instruments get 8 voice instances, with frame-exact notes, the channel pitch on `freq`, per-note pan and
    oldest-first stealing; a released voice is freed after 50 ms of silence.
- The plugin builder's drafts may contain `.dsp` files, and its prompt includes the Faust templates.
- Tests: `test/unit/faust.test.ts` (compile, controls, errors) and `test/browser/faust.test.ts` (effect params,
  polyphonic onsets, release, chunk-size determinism).

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
