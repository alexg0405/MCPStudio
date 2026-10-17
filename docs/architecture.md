# AGstudio architecture

This is the design reference. `CLAUDE.md` has the short rules; this file explains the why and the hard parts.

## Goals

- Recreate FL Studio's workflow in Chrome: Channel Rack (step sequencer), Patterns, Piano Roll, Playlist (pattern, audio
  and automation clips, markers, PAT/SONG modes), Mixer (inserts, sends, sidechains, delay compensation), Browser,
  recording (notes and audio), save/open, and export (WAV, FLAC, MP3, stems, MIDI).
- Make the owner's **custom instruments and effects** first-class: a plugin is a folder in `plugins/` that shows up in the
  browser like the built-ins and hot-reloads, written in TypeScript (graph or worklet style) or Faust. Built-ins
  (9 instruments, 22 effects) are written against the same public SDK.
- An **AI studio** that can drive every feature (it acts through the same ops and commands as the UI), listens to the
  mix, and can write new plugins.
- The UI explains itself: hints and tooltips on everything, a "?" on every window, the action search, lessons.
- Still open: a desktop wrapper, a clip launcher.

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
  playing: pause + `start(tick, at = now + startLead)`. `startLead` (`Engine.startLead()`, `stats().startLead`) is the time
  the first notes need to reach the audio thread: `6 ms + 1.5 × baseLatency` (14 / 21 / 38 ms for the small, medium and
  large buffer), plus up to 30 ms learned when a start still dispatched late. It was a fixed 50 ms.
- `allNotesOff(t, hard?)`: release every voice sounding at `t`, drop everything scheduled at or after `t`.
- Playhead: keep a ring of segments; each frame compute the audible time from `getOutputTimestamp()`
  (`contextTime + (performance.now() − performanceTime) / 1000`, includes output latency, e.g. Bluetooth) and map it
  through the ring. Never store the playhead in React state.
- Preview/MIDI input bypass the scheduler (`time = ctx.currentTime`, flush the worklet port) and the mixer's delay
  compensation (which is done in the song's event times, see PDC). Velocity-0 noteOn = noteOff.
  `currentTime` only moves once per audio callback, so a quick tap's release could carry the press's own time and cancel
  the note: `previewNoteOff` holds the release until `2.5 × baseLatency` (at least 10 ms) after the press.
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
- Meters: per insert, after the fader (postTap), a ChannelSplitter → 2 AnalyserNodes (fftSize 2048; realtime engines only). They join the graph on the first `readMeters` and leave 2.5 s after the last read (a closed mixer costs nothing; the first read returns 0).
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
- Reverb (`plugins/builtin/reverb`): two engines behind the same params (Decay = RT60 of the mids, Pre-delay,
  Damping, Size, Mix) and an `engine` enum param, `'algorithmic'` by default (projects saved before it existed get the
  default, so they turn algorithmic; no version bump: missing params resolve to their default). Switching crossfades
  the two over 50 ms; the one faded out stops getting input (the convolution chain is torn down, the kernel sleeps).
  Tail for exports: preDelay + 0.1 + 1.3 · Decay. Measured in Chrome: ten 7 s reverbs made the realtime audio clock
  run at 0.4–0.6× (convolution, on a busy machine) and 1.00× (algorithmic); ten alone render offline at 20–30×.
  - Algorithmic (`kernel.ts`, `reverb.worklet.ts`, mix inside the kernel): pre-delay (linear interpolation, a-rate) →
    the input's high shelf → 4 Schroeder allpasses a side → an 8-line FDN (lines 29–94 ms × (0.45 + 0.55 · size),
    fast Walsh–Hadamard mixing, left into the even lines and right into the odd ones, negated in lines 4–7). Per line:
    first-order allpass interpolation (linear while gliding faster than 0.01 frames/frame after a Size change), two
    first-order shelves for three decay bands (lows ×1.2 below 250 Hz, highs ×(1 − 0.6 · damping) above 8 kHz,
    tuned so every band's energy is within ~2 dB of the convolution IR's), an allpass in the loop (density), and a
    gain e^(−ln 1000 · len / (RT60 · sr)). All 8 lines drift ±0.5 ms at 0.3–1.1 Hz. L/R outputs are two orthogonal
    sign sums of the lines. The input level is set from the estimated tail energy (Σ G²/(1 − G²) over 24
    frequencies), so a Decay change alters new tails, not the one ringing, and the IR has unit energy like the
    convolution one. Decay/Damping/Size glide at control rate (32 frames; gains and input level ramp per frame;
    line lengths glide ≤ 0.25 frames/frame). Processed in 32-frame chunks stage by stage (possible because the
    shortest line is longer than a chunk). Silence in and a tail under −100 dBFS for 0.5 s clears the network and it
    idles; the runner then sleeps. About 0.3 % of a core per instance in Node at any Decay.
  - Convolution (`ir.kernel.ts`, built only while chosen): decorrelated L/R noise (seeded) × e^(−6.91·t/RT60), 3
    bands with their own decay (lows ×1.3, highs ×(1 − 0.8·damping)), 8–12 early reflections from 10 ms to 12–80 ms
    (size), 5 ms fade-in, unit energy, `disableNormalization`. Pre-delay is a DelayNode. Decay/damping/size changes:
    debounce 150 ms (immediately when offline), regenerate on the main thread (10–25 ms for a 10 s tail), crossfade
    two ConvolverNodes over 120 ms (setting `.buffer` in place would click and cut the tail). IRs are cached. Each
    instance with a 3–7 s tail costs 3–4 % of a core.
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
  descriptors for the automatable ones (float a-rate, int k-rate; the rest travel as `EV_PARAM` events, see
  Performance). Values are host-owned in the document: undo, presets, save, hot reload free.
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

As built (M6, `app/export`; WAV, FLAC, MP3 and stems since M15, see
[Audio recording, editing and export (M15)](#audio-recording-editing-and-export-m15)): File > Export audio (Mod+R) opens a
dialog (range: song, current pattern or the playlist's loop region; format; sample rate). Its Export button is the user
gesture for the save picker, so the picker comes before the render. `renderOffline` takes `fromTick` (loop regions), `tail: 'auto'` (instrument and effect tails, measured on a
128-frame probe context), `onProgress` and an abort `signal` (an aborted render stays suspended and is dropped).
`trimRender` drops the pre-roll and cuts the silence (< −90 dBFS) after the last tail. Measured in Chrome: the export
decodes back to the float render within one 24-bit step, and renders of kit/synth projects are hash-identical. The
exception is **ConvolverNode** (the Reverb's convolution engine): two renders differ by about one float ULP (≤ 6e-8,
inaudible), so a project with it can produce byte-different files. The default algorithmic engine is a deterministic
worklet.

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
  Follow playhead (`timeline/follow.ts`, pref `followPlayhead`, command `view.followPlayhead`): each controller's
  `frame()` asks a `PlayheadFollow` for the scroll. Smooth style (default, pref `followStyle`, command
  `view.followSmooth`): once the playhead reaches 40% of the width the view moves with it every frame (never back,
  not while the loop end shows; a gap after a hand scroll closes with a 240 ms glide). Page style: at 88% the view
  glides (240 ms ease-out) so the playhead sits at 15%. Either way a playhead off-screen (loop, seek) snaps back. It holds still during drags and while a
  context menu is open, and after a hand scroll (wheel, scrollbar, middle-drag) until the playhead is back in view,
  playback restarts, or 3 s pass (then it glides back). Zooming never pauses it: the view glides back to the playhead.
  The scroll is saved to the editor store only when playback stops, so following causes no React commits.
  **Scrolling does not redraw** (`timeline/panned.ts`): the playlist's grid, clips and ruler and the piano roll's
  grid, notes (and ghosts), ruler and event lane are `PannedLayer`s. Each is drawn once into a picture wider than the
  view (30 % behind and 90 % ahead while the view scrolls sideways; exactly the view's size otherwise, so edits cost
  what they always did) and a scroll frame only moves it: a CSS `translate3d` of the canvas (the layers over the
  grid) or one `drawImage` (the rulers, which stay view-sized because they take events and are measured). A layer is
  drawn again when it is dirty (an edit, a hover, a theme change), when zoom, size, vertical scroll or pixel ratio
  changed, or when the view leaves the drawn part; a zoom draws view-sized, not wide. The view's scroll is snapped to
  whole device pixels (`Viewport.snapForFrame`) and every x is drawn through `tickToPx`, so the picture drawn from
  any origin is the same picture moved by whole device pixels: a slid layer equals a direct redraw
  (`panned.browser.test.ts`, at dpr 1, 1.25 and 2). Hit-testing reads the viewport, never the canvases; things
  recorded while drawing (the ruler's marker flags) are in picture coordinates and `PannedLayer.offset()` moves them
  into the view. The controllers' scroll code therefore does not call `invalidate()` for these layers (only the
  overlay, when something is drawn at the pointer). Measured (`scripts/perf-follow.mjs`, 12 s of smooth follow with
  both windows open): JS per frame 0.36 -> 0.12 ms (stacked-song), 0.90 -> 0.18 ms (notes10k), allocation per second
  down by 60 % (what remains is the audio scheduler).
  "Play this" (`app/actions/transport.ts`; commands `transport.playPattern`, `transport.playFrom`,
  `transport.playRange`): the piano roll's and channel rack's ▶/■ (`transport/PlayPatternButton`), the browser's
  pattern menu and the playlist's clip, marker, empty-spot and ruler menus set the transport view (pattern + mode,
  or the loop region) and then play, so the toolbar's play button is never needed. The buttons subscribe to the
  engine's play/stop events and the view's mode and current pattern, never the playhead. Pattern bodies in playlist
  clips (`playlist/render.ts`) are built once per pattern and zoom as a path per velocity step, and blitted from a
  small canvas when the pattern fits one, so a dense pattern used by dozens of clips costs a blit per clip. Canvases
  redraw when the screen's pixel ratio changes (`timeline/canvas.ts`). Frame-loop code never reads layout
  (`getBoundingClientRect`, `offsetLeft`): measure in a ResizeObserver callback and cache (a read after the
  position readout's text changed forces a ~2.5 ms relayout). A drag whose button was released out of reach
  (outside the window) ends on the next move with no button down (`e.buttons === 0`).
- Context menus (`controls/ContextMenu.tsx`): one host; a first `label` entry is the header, with a × (Esc). The
  press that closes a menu outside it is swallowed whole (pointer up, click, contextmenu), so it never opens another
  menu or edits what is under it. It opens beside the pointer, flipped above/left near the edges. Submenu panels are
  `position: fixed` inside the blurred parent panel, which is their containing block, so their viewport coordinates
  are made relative to it (and the panels animate opacity only); a submenu closes 180 ms after another row is entered.
- Performance budgets: 60 fps with 10k notes (3k visible) and 2k clips; content redraw < 4 ms; single-note transact
  < 1 ms; zero React commits during idle playback.
- Theme: CSS custom properties in `ui/theme/tokens.css` (and `themes.css`, below); canvases resolve tokens via
  `getComputedStyle` and re-resolve on `invalidateTheme()`.
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
  - Lessons (Help → Lessons): short tasks that check themselves as you go (a beat, a melody, a song, a mix, your own
    sound), with an outline around where to look.
  - Every window's title bar has a "?" with its main moves (`workspace/window-help.ts`).
  - Menus work from the keyboard (`controls/menu-nav.ts`); the hint bar follows keyboard focus.
  - New features ship with plain labels, hints with units, empty states that say what to do, and menu or right-click
    entry points, not shortcut-only.

- Themes: `ui/theme/tokens.css` is the default (Dark, orange); `themes.css` overrides tokens under
  `:root[data-theme=…]` (midnight, graphite, light) and `:root[data-accent=…]`. Tints, glows and the darker
  shades of the accent, select and danger colors are `color-mix()` tokens, so a new accent recolors everything
  (canvas accepts color-mix in Chrome). `ui/theme/apply.ts` puts the attributes on <html> from prefs (`theme`,
  `accent`; commands `options.theme` / `options.accent`) and calls `invalidateTheme()`: canvas controllers
  (`onThemeChange`) mark every layer dirty, the mixer meters rebuild their gradients, React canvases redraw
  through `useThemeVersion()`. No component hard-codes a surface or text color; what is left in CSS is
  shadows, the piano's keys and the metal fader caps.

## Persistence (`src/app/persistence`, `src/platform`)

- `.agproj` = zip (fflate, `core/io/project-file.ts`): `meta.json` (`{ format: 1, appVersion, savedAt }`),
  `project.json` and `view.json` (deflate 6), `samples/<sha256>.<ext>` (original bytes, stored uncompressed). Plugin code
  is never embedded; plugins are referenced by id + version. Reading migrates and repairs (`core/schema/migrate.ts`) and
  throws `ProjectFileError` with a user-facing message; a damaged `meta.json`/`view.json` is tolerated and reported in
  `repairs`. Opening verifies each embedded sample against its hash before it enters the store. Save writes the zip
  a piece at a time and Open reads it an entry at a time (see [Long audio](#long-audio-dj-mode-foundations)).
- Runtime sample store: OPFS `blobs/<sha256>.<ext>` (`platform/opfs.ts`), layered over memory when OPFS is missing or
  full (`app/persistence/blob-store.ts`); decoded per `(hash, sampleRate)` into the shared sample cache (memory budget,
  see [Long audio](#long-audio-dj-mode-foundations)); undo removes references, not blobs; unused blobs are removed by the
  safe clean-up described under [Clean-up of unused audio](#clean-up-of-unused-audio). `decodeAudioData` resamples and detaches its input; Chrome
  rejects AIFF, so the engine's decoder has the PCM parser in `core/io/wav.ts` (which also reads `smpl` and AIFF
  `INST`/`MARK` loop/root data) turn it into float WAV in a Worker (`engine/pcm.worker.ts`).
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
  alternating A/B slots. Autosaves are thin: no sample bytes (samples stay in the blob store). The project is serialized
  on the main thread (`projectFileParts`: JSON and UTF-8, ~5 ms for 1 MB) and compressed in a Worker
  (`persistence/zip-async.ts`, `zip.worker.ts`: 25-40 ms that used to run in a frame); the save for a hiding tab or a
  closing page zips on the spot, since a Worker may never get to answer, and without Workers (tests) or when one
  fails the zip is made on the calling thread. The bytes are those of `writeProjectFile`. Each tab holds a Web Lock
  `agstudio:session:<id>`; on startup, autosaves whose lock is free and not marked clean are recovery candidates. Only a
  clean project ends clean (on pagehide, save, open or new), so closing a tab with unsaved changes keeps them
  recoverable; only unsaved work is autosaved. The recovery dialog offers the newest candidate first (Recover /
  Discard / Not now); recovering autosaves into this tab before deleting the old copy. `navigator.storage.persist()`.
- Sample folders (`persistence/sample-folders.ts`, browser section "Sample folders"): `showDirectoryPicker({ id: 'samples',
  mode: 'read' })`, handles in IndexedDB, "Reconnect…" when permission is `prompt` (usual after a reload), recursive
  listing capped at 5000 files. Click previews (`engine.previewAudio(bytes)`, decoded once per content into the sample
  cache, nothing stored), double-click adds a
  sampler channel. Drags carry a token for the file handle (`ui/audio-drag.ts`, type `application/x-agstudio-file`);
  files dragged from the desktop arrive as DataTransfer files. Drops: on a sampler/audio-clip channel the sound replaces
  its sample (FL), elsewhere on the rack each file becomes a sampler channel, on the playlist each file becomes an audio
  clip on consecutive tracks. Imported files are hashed into the sample store and embedded in saved projects.
- Decoding (`engine/decode.ts`): `decodeAudioData`, falling back to the PCM parser (AIFF and unusual WAVs) in a Worker,
  whose float WAV `decodeAudioData` then resamples (the parser's audio at the file's own rate where there is no Worker).
  Importing reads duration and layout from the file's headers (`core/io/audio-info.ts`) and decodes only files they
  don't describe.
- User presets (`app/presets.ts`, `services.presets`): a list in IndexedDB (`user-presets:v1`), loaded at startup;
  writes wait for that load so an early save can't replace what's stored. Each stores every param, the state and the
  plugin's `version` (older ones go through the plugin's `migrate` when loaded). `presetChoices(def, library)` is the
  factory presets then yours; `applyPreset` is one undo step and notes the name per owner (session only), so the preset
  bar shows "Name (edited)" after a tweak. Randomize keeps params that look like output levels. `.agpreset` files are
  JSON (`format: "agstudio-preset"`). Samples aren't part of a preset. The AI catalog lists your presets and
  `preset: "<name>"` finds yours before the factory ones.
- Chain presets live in the same library (`user-chains:v1`, see "Vocal chains" below): `PresetLibrary.chains()`,
  `saveChain` (replaces by name), `renameChain`, `removeChain`, `restoreChain`; the storage's `readChains`/`writeChains`
  are optional (a storage without them keeps chains for the session).

### Clean-up of unused audio

Without it, storage only grows (removing a song, deleting a sample or closing a project leaves its bytes). Losing a
user's audio is far worse than keeping extra bytes, so every rule below errs toward keeping. Code: `core/gc`
(pure rules, unit-tested), `app/storage` (collector, tab records, guard, service), `platform` (locks, IndexedDB, OPFS
stats), UI in Settings → Storage.

- **In use** = any stored value mentions the blob's SHA-256. The finder (`core/gc/refs.ts`) doesn't know shapes: it
  takes every 64-hex run in every string and key of plain data, so a new field that holds a hash is covered without
  changes. Sources: every live tab's record (its project, its undo *and* redo history through
  `History.referencedHashes()`, and audio pinned by a running export/render, `app/storage/busy.ts`); every autosave
  slot file (`projectFileHashes`: the text of `project.json`/`view.json`, valid or not); the DJ library
  (`dj-library`); and **every other value in the IndexedDB `kv` store** except `gc:*` and the cached track analyses
  (`dj-analysis:*`, which are keyed by hash but are not a use). Recent files hold handles, never bytes, so they pin
  nothing. The DJ-mix and sound-filter records live inside the project, so they are covered through it.
- **Tabs publish** a `gc:tab:<session id>` record (hashes, heartbeat, `playing`, `busy`), 1 s after a change and every
  30 s (`tab-refs.ts`). A record counts only while the tab's life lock `agstudio:session:<id>` is held (the same lock
  autosave recovery uses). A held lock with no record means a tab that is still starting (or an older build): the run
  stops. Records of tabs whose lock is gone are discarded, after marking their hashes "seen" at their last heartbeat
  (a reload briefly releases the lock; the grace period covers that gap).
- **Grace period**: a blob goes only if nothing refers to it *and* both its file time and its `gc:seen:<hash>` mark are
  7 days old (`core/gc/plan.ts`). The mark is set when a blob is written, found by `hasBlob` or read by `getBlob`
  (`app/storage/guard.ts`, installed into the sample store), when the collector sees it in use (refreshed at most every
  12 h), and from dead tabs as above. A blob nothing says anything about starts its grace on first sight. Clock moved
  back counts as "not old".
- **Atomicity**: the sample store's reads and writes of the persistent store run under a shared `ag-blobs` Web Lock
  (one refcounted request per tab, so a waiting exclusive request cannot deadlock a nested one). The collector takes
  `ag-gc` exclusively (`ifAvailable`: one run at a time, others skip) and deletes in batches of 10-25, each inside an
  exclusive `ag-blobs` hold that first re-reads the live tab records and the marks of its candidates and drops any that
  came into use. A delete therefore never lands between a tab's look at a blob and its use of it.
- **Fail safe**: any unreadable source (IndexedDB, an autosave listing), no Web Locks, no OPFS or IndexedDB, an unknown
  tab, a busy tab (export/import running), or playing (automatic run only) means nothing is deleted. Corrupt autosave
  files count as holding nothing (recovery cannot use them either). Collection never touches the derived cache
  (`derived/`, stretched copies), which has its own 4 GB cap; analyses of removed songs go with their blob.
- **When**: automatic run (Options → "Clean up unused audio by itself", `prefs.autoCleanup`, on by default): first
  2 minutes after a tab opens, then at most once per 6 h across tabs, in an idle callback, batches of 10 with a pause,
  stopping when playback starts. **Development builds only log what it would remove** (`dryRunOnly`;
  `localStorage['agstudio:gc-dry-run'] = '0'` turns that off). Manual: Settings → Storage → "Clean up unused audio…"
  (or the Options menu / action search / the Studio via `storage.cleanUp`) shows how many files and how much space,
  asks, then removes (always real, also in dev). The table shows project audio, DJ library, stretched copies and other
  (autosaves + unused audio); the rows add up to the total.
- **Not covered, on purpose**: a project saved to a `.agproj` embeds its samples, so closing it and letting its audio
  age out loses nothing (opening re-imports it). Only unsaved work needs the blob store: that is what the tab records,
  undo history and autosaves protect.
- Tests: `core/gc/gc.test.ts` (hash finder, history, autosave files, grace, tab rules), `app/storage/*.test.ts`
  (collector on fakes: sources, grace, dead tabs, batch re-check, failures, usage numbers, the guard),
  `test/browser/storage-gc.test.ts` (real OPFS/IndexedDB/Web Locks with iframe "tabs" and a fake clock: other tab's
  audio, undo, grace, dead tabs, writer vs. collector, recovery after a collection, 1,000 blobs),
  `test/browser/storage-settings.test.ts` (Settings → Storage numbers, dialog, switch). New code that stores a hash
  outside a project must keep it in IndexedDB `kv` (or tell the collector); that is all it takes to stay safe.

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
- **The AI** (`app/assistant/claude.ts`, server side in `tools/ai/`): the browser posts each turn to `/api/ai/beat` on
  the dev/preview server, which keeps the conversation (session id) and answers with the beat as JSON under a
  structured-output schema (`BEAT_JSON_SCHEMA`: `additionalProperties: false` everywhere, ranges in descriptions,
  enforced by `validateBeatSpec`; a beat that fails validation is sent back once for a fix). Three backends:
  - **subscription** (`tools/ai/subscription-backend.ts`): the musician's own Claude Code CLI, signed in with their
    Claude plan, run in print mode per turn with no tools, resuming its session for follow-ups;
  - **api** (`tools/ai/api-backend.ts`): the Anthropic SDK with `ANTHROPIC_API_KEY` from `.env.local` (re-read per
    request): streaming, `output_config` effort `medium` + JSON schema, server-side refusal fallback
    (`fallbacks: "default"`) on models that have it, an append-only history (thinking blocks kept);
  - **codex** (`tools/ai/codex-backend.ts`): the musician's ChatGPT plan through their own Codex CLI (found through
    `AGSTUDIO_CODEX_BIN`, the PATH, the ChatGPT app's `Contents/Resources/codex` and the usual install folders).
    Status is `codex login status` (cached 15 s; only a ChatGPT login counts, an API-key login is refused with a
    reason; `~/.codex/auth.json` is never read). A turn is one `codex exec` (a follow-up `codex exec resume
    <thread>`; the thread id comes from the `thread.started` event, one thread per backend) run in an empty temp
    folder with the request on stdin, `--ignore-user-config --ignore-rules`, `sandbox_mode="read-only"`,
    `approval_policy="never"`, no AGENTS.md, no web search, and every tool-like feature of `codex features list`
    that is on (`TOOL_FEATURES`) disabled. The system prompt is a temp file given as `model_instructions_file`, the
    answer schema a temp file for `--output-schema`, the answer is read from `-o` (fallback: the last agent message
    event); the temp folder `agstudio-codex/<turn>` is deleted after every turn. `OPENAI_API_KEY`,
    `OPENAI_BASE_URL` and `CODEX_API_KEY` are removed from the child's environment so the ChatGPT login is used.
    The flags are in one function (`cliArgs`) with a comment each; they are the only part tied to the CLI version.
    OpenAI's strict structured outputs want every property in `required`, so `tools/ai/strict-schema.ts` turns each
    answer schema into the strict form (optional properties become nullable, `const` becomes a one-value `enum`) and
    deletes every `null` property from the reply: the original schemas have no null types, so null always means "left
    out", and the page validators and the op appliers see exactly the answer they always did.
    `test/unit/strict-schema.test.ts` holds the schemas to OpenAI's documented limits (properties, nesting, enum
    values and string sizes), so a new op that would push the Studio schema over fails there.
  "Auto" picks the Claude subscription when it's set up, else ChatGPT (Codex), else the key, else the offline
  generator; a chosen backend that isn't set up shows its reason in the window. The page keeps the model per backend
  (`model` for Claude, `codexModel` for Codex, empty = Codex's own default, "Other model…" takes a typed id) and one
  server-side conversation per backend (`ClaudeChat.sessions`, saved with the tab): switching backend starts a fresh
  thread there (the plugin catalog and command list are sent again) and switching back continues the old one. Claude
  Opus 5.5 and Sonnet 5.5 reject forced tool choice, which is why the answer is a structured output rather than a
  tool call. The endpoint refuses requests without the `x-agstudio` header or from another origin; the model id is
  checked per backend (`claude-…`, or Codex's `[a-z0-9][a-z0-9._:-]{0,63}` or empty).
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
channels ──► chIn ───────────────► routeIn ─► slot 1 … slot N ─► scTap ─► gate ─► preTap ─► pan ─► fader ─► postTap
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
- **Compensation is done in time, as far upstream as the routing allows, not with a delay line on every join.** For an
  insert X: `before(X, k)` is the latency ahead of slot k and `fx(X)` that of all its slots. A forward pass gives the
  mixer's latency (`graphLatency()` = the longest path to the master's output); a backward pass ("as late as possible"
  scheduling, `engine/pdc.ts`) gives each insert its `arrival(X)`: how long after the time the song schedules it the
  audio entering X is: `arrival(S) = min(arrival(Y) − fx(S) over its routes S → Y, arrival(X) + before(X, k) − fx(S)
  over the sidechains it keys)`, the master staying where the forward pass put it, and `out(X) = arrival(X) + fx(X)`
  (the latency at X's taps). A track that feeds nothing heard (no route out, no key taken from it) constrains nobody.
- **Channels are not padded. They are scheduled later.** The song's events for a channel (notes, audio clip starts, its
  volume/pan/pitch and plugin automation, its plugin's transport anchors) go to it `arrival(its insert)` later
  (`ChannelStrip.shift`; `Engine`'s transport sink adds it to each event, `MixerGraph.shiftSeconds`). Live input and
  previews (`previewNoteOn`, MIDI, the typing piano) go to the strips directly, so they hear none of the compensation:
  on the heavy-song fixture a key sounds as soon as on an idle song (see Latency measurements). Recorded notes still
  land where the player heard the song (`tickAt` takes `graphLatency()` off the heard time, which is unchanged: a song
  note is still heard `graphLatency()` after its time), and playback is sample-identical to the delay-line version
  (`test/browser/routing.test.ts`, `pdc-shift.test.ts`: renders shifted by the latency match bit for bit; automation to
  1e-5).
- What is left of the old delay lines: a route S → X still gets a DelayNode of exactly `arrival(X) − out(S)` frames and a
  sidechain S → X (slot k) `arrival(X) + before(X, k) − out(S)`: zero along the route that limits X and along any chain
  of tracks with one route each, non-zero where one track feeds two paths that differ (a send to a latent bus and a dry
  send). Each padded link (`PadLink`) has its own gain: when its delay or target changes while a realtime context
  plays, the old path fades out over 10 ms as the new one fades in; offline and before the context starts it switches
  exactly. Channel inputs (`chIn`) are plain connections, so a live audio input monitored through a track
  (`openAudioInput`) is not delayed either.
- **A change of the compensation while playing** (an effect finishes loading, is bypassed, a route changes): every
  channel's shift is recomputed (`Engine.alignChannels`), automation lanes and plugin anchors are moved
  (`AutomatableParam.shift`: the automation driver reaches a lane through `ShiftedParam`, which adds the shift to every
  time it writes and takes it off what it reads; `AutomationDriver.retime()` plans moved lanes again) and the transport
  re-plans from 10 ms ahead, so notes not yet started get their new place and each lands once (a note's release
  carries the shift its start was dispatched with: `Engine.noteShifts`). Notes already sounding keep going. Changes
  made inside `reconcile()` apply at its end, once the strips are up to date. A note in the last 10 ms before the
  re-plan keeps the old shift (a flam of that size for one note).
- Insert-side automation (fader and pan: `out(X)`; a slot's params: what reaches it; its mix: what leaves it; a send's
  level: `out` of the sending insert) is moved the same way, which also closes the old gap where such controls landed
  early by the latency.
- `graphLatency()` is `out(master)`. The playhead, the step lights, `readAutomation` and `tempoNow` read the transport at
  `audibleTime() − graphLatency()`, so they follow what is heard. The engine notifies subscribers when it changes (the
  mixer shows "Delay comp. N ms").
- `tailSeconds()` follows the routing depth (effect tails add up along the deepest route path to the master) plus the
  latency. `renderOffline` keeps its defaults and reports `latency` in its result; WAV export doesn't trim it yet.
- Limits: a plugin's `host.transport.tempoAt(t)` looks the time up in the transport's planned segments, so within the
  shift of a tempo change it can answer for the neighbouring segment; a note of a channel whose shift is more than the
  lookahead (very latent chains) is dispatched with the lookahead plus its shift of lead, which is fine. The master
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
  tail doesn't hold the duck down and every hit pumps the same. Since M14 its tempo mode pumps on the song's grid with
  no sidechain at all.
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

The assistant window is an AI studio: every turn, the AI (Claude, or ChatGPT through Codex) answers with `{ message, actions[] }`
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
  The subscription backend's CLI prompt is task-neutral. Without an AI, beat requests still go to the
  offline generator. The Codex backend answers the same schemas in OpenAI's strict form (see "The AI" in the beat
  assistant section above).
- **Rule for new features**: each feature adds its ops here (and what the context needs), so the AI can
  drive it.
- **Layout (v3)**: `apply.ts` is a short orchestrator over `app/ai/ops/`.
  - One module per group of actions (`song`, `channels`, `mixer`, `patterns`, `notes`, `automation`, `playlist`,
    `clips`, `beat`, `ui`), each an `OpModule` with its handlers, its schemas (built from `app/ai/schema/parts.ts`),
    its section of the studio prompt and an optional `beforeCommit` hook. `ops/index.ts` is the only list.
  - Handlers get an `OpContext` (`ops/context.ts`): the draft, the project before the answer (`base`), the lookups
    (`channel`, `insert`, `effect`, `pattern`, `plugin`, `lane`, `clip` by id or track + bar), `@refs`, `warn`,
    `note`, `touch` (the playlist span it edited: autoplay starts a bar before it) and the answer's state.
  - **The draft rule**: inside a recipe, read with plain loops; identity-memoized queries (`notesSorted`,
    `patternLength`, `clipsSorted`…) keep the draft proxy and go stale after a later action of the same answer.
  - The prompt (`app/ai/prompt.ts`) is assembled from sections by `order`: intro 0, how to act 10, playlist editing
    15, song craft 20, working on a part 30, beat writing 80, notes 85, the example 90.
  - `apply.characterization.test.ts` pins every action's output; refactors must keep it.
  - The focus guard (`ops/focus-guard.ts`) is the seam for edits limited to a part of the song (see "Asking about a
    part"); without a focus every check passes.
- **The playlist as the AI reads it** (`context.ts` `playlistLines`, `core/query/arrangement.ts`):
  - Every track in full, its back-to-back repeats as runs ("“Drop” ×8 bars 37–52"), split at the marker sections
    (listed first). Bar ranges are 1-based and inclusive (`core/time/bars.ts`). Short runs list their clip ids.
  - Patterns say where they play; notes show velocities other than 0.8 (`@.45`).
  - The **song check** (`songCheck`): parts stacked on themselves (the same clips playing 2–3 times at once), a
    pattern overlapping itself, more than 4 unchanged repeats, unnamed tracks, repeated automation curves.
  - Background: the listing used to cut each track at 40 clips without saying so; on a 113-bar song the AI could not
    see bars 81–112 and placed them again, twice.
- **Never stacked**: `place_pattern` skips clips that would play a pattern where it already plays (any track);
  `replace: true` clears the track there first (trimming at the edges); a missing track fails. A `beforeCommit` safety
  net removes clips of the answer that exactly repeat clips already there. `clear_playlist` can `trim`.
- **One clip at a time** (`ops/clips.ts`): `clip` (edit: mute, move, length; split; make_unique, so one repeat of a
  loop can change alone; remove), `track` (name, color, mute, solo) and `tidy` (`core/ops/tidy.ts`: removes stacked
  copies, merges same-curve automation channels, names one-thing tracks). "Clean up the song…" in the Playlist menu
  (`ui/features/song-tidy`) does the same after a confirmation that lists what it will change.
- **Follow-up steps** (`app/assistant/after-steps.ts`): an after-edit request with a registered step (e.g. leveling
  the mix) runs after the answer is applied and before anything plays, with progress and Stop; its edit is folded into
  the answer's undo entry with `history.transact(label, recipe, { amend: entry })` (only while that entry is still the
  newest one).
- **More ops since M16a**:
  - `automate`: an automation clip for any target, with points in the control's own unit or an LFO;
  - `note_tool`: any piano-roll tool from the catalog;
  - `steps`;
  - `marker`;
  - `edit_audio_clip`, and audio-channel pitch, reverse and tempo-follow through `edit_channel`;
  - `build_plugin` (below).
- **Driving the whole app** (`ops/session.ts`, `ops/windows.ts`, `ops/query.ts`, `read.ts`):
  - `settings` (preferences, audio, export defaults, the editors' tool and grid), `select` (channel, mixer track,
    pattern, clips, notes, the loop region), `save_preset` and `open` with `action` (close, focus, maximize,
    restore any window or the browser panel). They change stores that are not the document: no undo step. They
    run right after the edit (an answer can write notes and select them) and report in `AppliedTurn.ui`, which
    is why a dry run leaves them out.
  - Extensions of existing ops: `song` title/author, `edit_channel` sample/root_key/position, `edit_insert`
    position, `add_pattern` from (copy) and split_by_channel, `edit_pattern` position.
  - **Read tools** (`app/ai/read.ts`, `readTools`: name, description, JSON schema, `run(s, args)`): get_project,
    get_transport, get_selection, get_pattern_notes, get_channel, get_mixer, get_clips, get_automation,
    get_settings, get_windows, get_plugins. Compact JSON in the units the actions take (dB, 1-based bars, 1/16
    steps, MIDI keys); a bad argument returns `{ error }`. The MCP server lists the same array.
  - **Look-ups in the chat**: the `query` action (`tool`, `args_json`) runs a read tool after the edits and
    returns the result in `AppliedTurn.queries`; the assistant asks again with a `<lookups>` block (at most 3
    rounds, 4 tools per answer).
- **Coverage rule** (`test/unit/ai-coverage.test.ts`): every registered command and window type must be
  reachable by the AI, or the test fails.
  - A command is reachable when it is in the command catalog (`ai` is not false) and, if it takes an argument
    (its `run` declares one, or a key binding or menu item passes one), has an `argsHint`; or it is listed in
    `COVERED_BY_OP` with the action that replaces it (commands that open a dialog or work on a UI selection); or
    it is in `NOT_FOR_AI` with a written reason.
  - `NOT_FOR_AI` today: `ai.askSelection`, `ai.askSection`, `ai.clearFocus` (entry points that send a request to
    Studio), `view.assistant` (Studio's own window), `help.palette` (the action search). Windows: `assistant`
    (`WINDOWS_NOT_FOR_AI`); the others are in `OPEN_WINDOWS`. Do not add to these lists to make the test pass.
  - Selection commands (`pianoRoll.*`, `playlist.*`, `audioClip.*`, `channels.delete`…) work on what `select` picked.
- **App commands**:
  - The `command` action runs any registered command by id (`app/ai/commands.ts`). The first turn, and any
    turn after the list changes, sends `<commands>` with every command's id, title, hint and `argsHint`.
    So every menu entry, button and shortcut is something the AI can do: save, export, undo, windows,
    layouts, settings… New features' commands join automatically.
  - `CommandDef.gesture` marks commands that open a file dialog. The AI studio shows a one-click
    confirmation, and that click is the user activation the browser needs.
  - `ai: false` keeps a command away from the AI; the coverage test then wants an action that covers it or a reason.
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

### Asking the AI about a part

Select clips, loop some bars, pick a marker's section or some notes, and tell the AI what to change there: only that
part changes, as one undo step.
- **Focus** (`app/ai/focus.ts`): `AiFocus` is a range, a section (marker id), clips or notes, each with its
  `projectId`. It is captured when the musician asks (`app/ai/focus-capture.ts`: the playlist's selected clips, else
  its loop region, which becomes a section when it matches one exactly; a marker; notes) and resolved again on every
  turn (`resolveFocus`): a section follows its marker (a deleted marker leaves its bars as a range), deleted clips and
  notes drop out, another project's focus is ignored. `focusLabel` gives "Verse · bars 17–32", "3 clips · bars
  37–42", "6 notes of “Lead”". The time variants carry `copies` (original pattern → the part's copy) so follow-ups
  edit the copy.
- **The `<focus>` block** (`focusContext`, after `<project>`): the part and the sections around it; every track's
  clips over the part and 2 bars either side, marked before / in the part / after, with ids; the notes of every
  pattern playing in it and where else it plays; what plays per bar from 4 bars before to 4 after
  (`core/query/activity.ts` `barActivity`); the automation over it. A notes focus lists the selected notes, the
  channel's other notes and where the pattern plays.
- **Guard** (`app/ai/ops/focus-guard.ts`, called from every op through `OpContext.focus`):
  - Inside = clips overlapping the part (muted ones count), or a clips focus's clips, plus the answer's own clips in
    the part ±1 bar.
  - Copy-on-write in `writable()`: a pattern that plays inside and outside is copied once per answer as
    "Drop (bars 37–52)" (`core/ops/fork.ts` `forkPattern`: straddling clips are split at the edges, the inside clips
    re-pointed); `resolve()` sends later actions, and follow-ups through `copies`, to the copy; the copy becomes the
    current pattern if the original was. A pattern that plays only outside is refused; one not in the song is
    editable. Patterns made in the answer are its own.
  - `span()`/`clip()`: playlist edits stay within the part ±1 bar (transitions); further is refused with the bars
    that may change. `clear_playlist` defaults to the part and always trims; a clips focus clears only its clips
    (`clearable`). `remove_pattern` only for a pattern that plays nowhere outside.
  - `closeAutomation()`: automation holds its last value, so a curve that ends elsewhere steps back at its end to
    what played there before the answer (the committed project's automation model, else the setting), unless
    another clip of the control plays on there.
  - Notes focus: `notes()` gives the selection as it is now (new notes count as selected), other channels of the
    pattern only gain notes, steps tools and whole-pattern clears are refused, the playlist and other existing
    patterns stay; `finish()` puts back any unselected note that changed. The assistant passes no previous beat, so
    a beat makes a new pattern.
  - `finish()` returns the focus after the edit (copies, the clips that are left plus the answer's clips in the
    part, the notes written) and the clips to select.
- **Assistant**: `state.focus`, `setFocus()`, `send(prompt, { focus })`, `playFocus()` (a span loops in song mode
  from its start; notes play their pattern). The focus is snapshotted when sending and resolved again when
  applying; the musician's message says "About …". Autoplay loops the part. It persists with the tab
  (sessionStorage, checked on restore), New chat and opening another project clear it, and offline a request about
  a part says it needs Claude. `listenAndAsk` renders just the part (`AnalyzeOptions.range`).
- **UI** (`ui/features/ask-ai/`): the Ask AI card (`AskCard.tsx`, an overlay placed with `controls/place.ts`
  `placeBeside` next to an anchor from `anchors.ts`, on the frame loop only while open; scope chip, box, quick
  requests from `chips.ts`, replies with Undo via `assistant/Message.tsx`, Play this part, Open in AI studio). It
  takes the keyboard without `holdModal` (a focused text box already silences shortcuts and the typing piano) and
  closes on an outside click only when idle and empty. Entry points: the playlist's ✦ pill (`playlist/ask-pill.ts`,
  moved by the controller on dirty frames, hidden while dragging), a ✦ on wide-enough marker flags (sections are
  faint bands on the marker lane; the name still jumps), right-click menus (clip, marker, ruler loop, piano-roll
  notes), Alt+A in the playlist and Alt+Shift+A in the piano roll (its Alt+A arpeggiates), the Playlist and Edit
  menus, "Ask AI about: Verse" in the action search. The AI studio shows the part as a chip (`FocusChip.tsx`) with
  part-specific ideas and takes text from the card (`draft-state.ts`). A clip's ▾ keeps a selection it is part of.
- Tests: `focus.test.ts`, `ops/focus-guard.test.ts` (incl. "add a fill at the end of the Verse" on the stacked
  song), the assistant's fake-fetch tests, `test/browser/ask-ai.test.ts` (the pill, the marker ✦, typing in the
  card plays no notes, no React commits while playing with the card closed).

## Track analysis (DJ mode)

What DJ mode knows about a song (`TrackAnalysis` in `core/dj/types.ts`): BPM and beat grid with downbeats, key
(Camelot), integrated loudness and true peak, energy per bar, sections and where to mix in and out. Computed once
per content hash in a Worker and cached in IndexedDB; the auto-mix and the decks read it.

### Pipeline (`src/core/dj`, pure, no DOM; `analyzeTrack` in `analyze.ts`)

- **Onsets** (`onset.ts`): log-compressed spectral flux (46 ms frames, 5.8 ms hops at 22.05 kHz) in four bands
  (kick < 150 Hz, snare body 150–800, crack/vocals 0.8–4 k, hats > 4 k), each whitened (local mean removed, scaled to
  unit spread with a per-bin floor so an empty band isn't amplified noise). Also per-frame power for the energy curve.
- **Tempo and beats** (`tempo.ts`): a 4-harmonic comb over the onset autocorrelation finds the pulse family
  (60–200 BPM); Ellis-style dynamic programming tracks beats at the fastest member, then halves while the slower
  tempo explains the drums as well (`preferFaster`): four-on-the-floor kick on its offbeats (only for halves below
  ~75 BPM: above that, low hits between beats are a bass line), snare on the offbeats of a slow half (DnB 174 read as
  87), hats on the 8ths of a tempo ≤ 160 (trap reads 140, not 70). Then the phase (`onTheBeat`): the biggest
  section start (> 8 dB over a beat, not out of silence) lands on a beat; else where kick/snare/bass weigh more
  (house's offbeat bass and hats can pull the tracker half a beat off). Beat times are refined between frames
  (+8 ms onset lag), BPM is a least-squares line through the strongest evenly spaced stretch and every beat on it, to
  0.01, snapped to a whole BPM when that slips about as little; a fixed grid that slips > 15 ms (9-beat median)
  anywhere means drift and `grid.beats` holds the tracked beats. No grid when beats don't stand out of the onset
  envelope or only one beat position of four has hits (a pad struck once a bar).
- **Downbeats** (`downbeat.ts`): per beat, kick minus snare, chord change (chroma 2 beats before vs after) and level
  change, z-scored and folded by position mod 4 (and 3: a waltz only when clearly better). `firstDownbeat` is the
  first downbeat at or after the first beat.
- **Key** (`chroma.ts`, `key.ts`): spectral peaks 200 Hz–2 kHz at 11 kHz (370 ms frames) and 27–200 Hz at 2.8 kHz
  (740 ms frames, for 808s on F1), tuning by the circular mean of peak offsets, peaks at 3/5/6/7× a stronger lower
  peak counted less (overtones), bass and treble profiles mixed (the treble counts less when flat: hats, noise), the
  first bar of every 4-bar phrase counting double; Pearson against blended Krumhansl–Kessler/Temperley profiles for 24
  keys; no third (root, fifth, ♭7 only) reads as minor. Null without pitch content.
- **Energy, sections, mix points** (`structure.ts`): per bar 0.55·loudness (24 dB range under the 95th percentile)
  + 0.25·onset density + 0.2·low-end share, squared and scaled to max 1 (per 2 s without a grid). Sections at novelty
  peaks (energy, density, low end, chroma; 4 bars each side) on an 8-bar phrase grid (4-bar boundaries need stronger
  novelty). Kinds: leading/trailing sections below 0.75 are intro/outro, ≥ 0.8 after a lower one is a drop, < 0.45
  break, the section before a drop that rises inside is a build, else verse/body. `mixIn`: the first downbeat when
  the intro is ≥ 8 bars (mix the whole intro over the previous outro), else the first full-energy phrase. `mixOut`:
  the outro start when it is ≥ 8 bars, else a section start 8–32 bars before the outro/end, else 16 bars before it on
  the phrase grid.

### App (`src/app/dj`)

- `analysis-cache.ts`: `createTrackAnalyzer()` (wired as `services.trackAnalyzer`): `analysisHash(ref)` (the embedded
  file's hash, `builtin:<generator>@<version>` for built-in sounds), one job at a time, callers of the same hash share
  it, a job is cancelled (Worker terminated) when every caller has aborted. Embedded files are decoded from the sample
  store at 44.1 kHz on the main thread (`engine/decode`, not kept in the engine's cache); built-ins come from
  `engine.sampleData`. Results go to the IndexedDB kv store as `dj-analysis:v<ANALYSIS_VERSION>:<hash>`; entries of
  other versions are deleted on load, so bumping `ANALYSIS_VERSION` re-analyzes. WAV and MP3 files longer than 12
  minutes (`LONG_SONG_SEC`, the decks' limit too) are never decoded whole: see "Long songs" below.
- `analysis-run.ts` (Worker-safe): LUFS (`LoudnessMeter`) and true peak (`TruePeak`, oversampled only in blocks
  within 6 dB of the sample peak) on the full-rate channels, downmix and decimation to ~22 kHz, then `analyzeTrack`.
  `analysis.worker.ts` runs it and posts progress at most once per percent. `analysis-workers.ts` is the main-thread
  side (one Worker, made again after a cancel; inline where there are no Workers).

### Long songs: analysis in pieces (`core/dj/stream-features.ts`, `app/dj/analysis-stream*.ts`)

A 2-hour file decoded whole is 2.7 GB of floats at 44.1 kHz stereo, so a file the decks read by parts is analyzed by
parts too, in about 100 MB however long it is, and gives the same `TrackAnalysis` under the same hash.

- **Reading** (`analysis-stream-run.ts` `driveAnalysis`, main thread): `openLongSource` opens the file from the sample
  store with the decks' own `openSegmentSource` (WAV from its bytes; MP3 by decoding 6.7 s pieces through
  `decodeAudioData`, which Workers don't have) and reads it at its own rate in chunks of 2^18 frames (5.9 s: 2 MB).
  Chunks go to the analysis Worker as transferred arrays (stereo, native rate: LUFS needs them), at most three
  unacknowledged at a time, so reading never gets ahead of the work. Without a Worker the same code runs inline with a
  yield between chunks. One song at a time and the same job sharing and cancel as before (cancel stops reading at the
  next chunk, terminates the Worker and frees the file).
- **Stages that take pieces** (all pure, and **bit for bit** what the whole-signal functions give for the same signal,
  pinned by tests with odd piece sizes): `Decimator` (the Butterworth decimation with its state carried over, `decimate`
  is now one call of it), `AnalysisFront` (stereo → mono → ~22 kHz), `OnsetStream` (frames are computed once the samples
  under them are in; 46 ms of signal kept; `onsetFeatures` is a push of everything), `ChromaStream` (the bass and treble
  decimators and frames the same way; peaks kept at 9 bytes each, 2 M for two hours, because the tuning is a circular mean over
  all of them and is only known at the end), `LoudnessStream` (the same meter and true-peak detector; a block is
  oversampled when within 6 dB of the loudest sample *so far* or after such a block, so no block that could hold the
  song's peak is skipped). Features at 22 kHz are 7 arrays of 172 frames/s (35 MB for two hours) plus the chromagram
  (10 MB).
- **Level scan.** The onset and chroma stages compress magnitudes after scaling them by the song's overall RMS, which a
  stream can't know before it has heard everything. `LevelScan` measures it first on regions of the file (`planScanRegions`:
  the whole song when it is at most 10 minutes, so the result is exactly the whole-file one; else thirty 20 s regions
  centred in equal shares of the song: 2 % of a 2-hour file, a few seconds), through the same front end. A level estimated
  that way moves the numbers slightly (a test with 24 % of a 50 s song agrees on tempo, key and downbeat).
- **Then the rest runs on the full features** (`analyzeFeatures`, split out of `analyzeTrack`): tempo and beats (the
  autocorrelation, the DP and the drift check are linear in the 1.2 M frames), downbeats, key, energy per bar (the
  per-frame power is already in the features: no second RMS pass), sections and mix points. Progress: scan 0–3 %, the pass
  3–93 %, this 93–100 %.
- **Wiring.** `createTrackAnalyzer` asks `openStream` first (default `openLongSource`; null for short songs and formats it
  can't read by parts: those decode whole as before), so the library, the auto-mix and the decks all get it. The library
  shows "Analyzing n %" as for any song. A deck that loads a long song no longer waits for a cache hit: it is playable at
  once, `DeckState.analyzing` (0–1) shows "Finding the beat… n %", and when the analysis arrives (`applyAnalysis`) the deck
  gets its grid, tempo, key and, if the cue point is still at the start, the first downbeat as cue (and parks there); sync,
  snapping and bar loops work from then on. Ejecting or loading another song cancels it if nothing else (the library) wants it.

### Measured

- Synthetic songs (`core/dj/test-songs.ts`; Node): house, boom bap (swung), trap half-time, DnB, dembow, pop, lo-fi
  (swung) at 3 tempos each incl. fractional BPMs, random offsets and keys (`accuracy.test.ts`): BPM ±0.05 21/21,
  octave 21/21, first downbeat ±20 ms 21/21 (median 1.2 ms), key exact 21/21; all 24 keys on cadences; detuned
  +35 cents; drift 120→124 BPM tracked within 20 ms; a pickup, 3/4, mix points on the right phrase.
- AGstudio templates rendered offline in Chrome (`test/browser/dj-analysis.test.ts`): trap 140, boom bap 90, house
  124, lo-fi 80, drill 142 all exact, downbeats within 2.3 ms, keys F minor / A major / A minor / F minor exact; boom
  bap reads D minor (its audio is a bass on A and D only), a Camelot neighbour of A minor.
- Speed: a 5-minute song in 0.9–2 s of analysis in Node (M-series, varies with load); about 0.2–0.5 s for a 20 s
  template in Chrome, plus decoding.
- Long songs (`test/browser/dj-long-analysis.test.ts`, headless Chrome; `src/app/dj/analysis-stream.test.ts`, Node). A
  looped synthetic house song at 128 BPM in A minor, 16-bit stereo 44.1 kHz WAV that has no bytes (made on demand) and an
  MP3 from the app's encoder. **30-minute WAV (303 MB):** BPM 128, key 8A, first downbeat on a bar line within 2 ms,
  −18.67 LUFS against −18.66 for the song alone, 959 bars, in **7.8 s** (230× real time) with the tab and its Workers
  **+27 MB** over idle (78 → 105 MB). **2-hour WAV (1.2 GB): 32.5 s, +62 MB (78 → 140 MB)** with the same results (3839
  bars); in Node the whole run, driven inline, peaks at +150 MB of process memory including garbage the collector had not
  taken yet (the live set, after a forced collection, is 53 MB at the end of the pass and 75 MB while the tempo and
  structure run on the whole-song arrays). **13-minute MP3** (decoded in pieces through `decodeAudioData`): 3.9 s, and against the same file
  decoded whole and analyzed the old way: BPM 128 / 128, downbeat identical, key 8A / 8A, loudness within 0.1 dB, energy per bar
  within 0.001. Before (the 30-minute WAV decoded whole, as the analyzer did): 1.6 GB held when the analysis starts (the
  file's bytes, the decoded buffer and the copies kept), about 2.1 GB at its peak, 8.5 s on the main thread; for two hours
  that is 6–8 GB and not possible in a tab. The time is the same because the work is the same; what changed is that the
  audio is never held. Streaming against whole-file on synthetic songs (house, trap 141.5, swung boom bap, 56 bars with an intro, break
  and outro): features **bit for bit identical**, so BPM, grid, key, energy, sections, mix points and downbeat are equal, loudness
  equal to 6 digits and true peak within 0.1 dB; with the level scan reduced to 24 % of the song the tempo (±0.05), key,
  downbeat (10 ms) and section kinds still agree; mono files and a 48 kHz file (analyzed at 24 kHz) agree on tempo, key and downbeat.

### Limits

Tuned on synthetic and AGstudio-rendered music, not on commercial recordings (none may be downloaded here): live
recordings with rubato, songs with long beatless stretches, tempo changes mid-song and swung/triplet genres need
checking on real files. Octave choices follow DJ conventions (trap 140, DnB 174, hip-hop 85–95, reggaeton 90–100); a
75 BPM track with 16th hats reads 150. Relative and fifth-related keys are confused when the audio has only roots
(bass-only loops). Sections use fixed energy thresholds; one 4/4 or 3/4 meter per song. A 2-hour mix with many tempos
is analyzed as one song: the drift check turns on and `grid.beats` holds every tracked beat (15 000 numbers), but the
tempo, key and sections are those of one song, not per track. Files that can't be read by parts (AAC/M4A, Ogg, FLAC, AIFF)
are still decoded whole, so up to 45 minutes; longer ones are refused with a message. The level scan estimates the level
of a song over 10 minutes from 20 s regions, so its results differ a little from a whole-file analysis of the same file
(they are identical up to 10 minutes). The analyzer runs one song at a time; a deck's request (priority 'now') goes ahead of every song the library has queued
(it never interrupts the one running).

### Listening to the mix (M16b)

- `app/analysis/measure.ts` (pure, Node-tested): `Measurer` takes stereo audio in pieces and gives integrated and
  max short-term loudness (the SDK's BS.1770 `LoudnessMeter`), sample and (optionally) true peak, RMS, crest, the
  share of energy in six bands (cascaded Linkwitz-Riley splits of the mid signal at 60/250/1k/4k/10k Hz), side/mid
  width and correlation.
- `app/analysis/mix.ts` `analyzeMix(s)`: at most 30 s (the loop region in song mode, else the song from bar 1, else
  the current pattern looped to ≥ 8 s); renders the mix (master chain, limiter on) and one raw stem per mixer
  track (`planStems` on `withoutMasterChain`), measures each, and derives plain-words findings (`mixNotes`: loudness
  vs −14 LUFS, true peak over −1 dBTP, low correlation, bass-heavy or dull tone, tracks clipping or silent, two loud
  tracks sharing the low end, wide bass, a track far louder than the rest). It yields with `scheduler.yield()` (or a
  MessageChannel): `setTimeout` is throttled to 1 s in hidden tabs.
- AI: the `analyze_mix` action (UI-only) makes the assistant run the analysis, post "I listened to…" with the
  findings, and ask Claude again with a `<mix-analysis>` block (`formatMixReport`); that follow-up can't ask again.
  "✦ Check my mix" starts the same flow from the UI; without Claude it still shows the findings.

## DJ auto-mix

The musician wants to mix songs like a DJ (party mixes). It is their own files: streaming services (Spotify…) are
DRM-locked, and the UI and the Studio say so. Auto-mix first: songs in → ordered, beat-matched, every transition
built on the playlist → tweak → export. Live decks come next; MIDI controllers are in "DJ controllers" below.

### Contracts (`core/dj/types.ts`, `app/dj/analysis-cache.ts`)

`TrackAnalysis` per content hash (beat grid, Camelot key, energy per bar, sections, `mixIn`/`mixOut`, LUFS) from
a `TrackAnalyzer` (`peek`, `analyze`, `subscribe`). DJ code asks through `app/dj/analyzer.ts` `trackAnalyzer(s)`:
`services.trackAnalyzer` once the analysis is wired, else one set with `setTrackAnalyzer` (tests use
`fakeAnalyzer` with hand-made analyses from `core/dj/fake-analysis.ts`).

### Planner (`core/dj/plan.ts`, `order.ts`, `wheel.ts`; pure)

- **Order** (`order.ts`): cost = harmonic move (`wheel.ts`: same 0, ±1 or relative 1, unknown 2, +2 boost 3,
  diagonal 3.5, clash 7) + tempo (0 → 3 at the 6 % limit, 8+ past it; +1 for a half/double-time match) + the
  distance of each song's energy rank from the shape's target at its position (build, party, peak-time, chill;
  chill also penalizes jumps). Song energy (`trackEnergy`) mixes loudness, tempo and the share of hot bars, so it
  compares across songs. Greedy from every opener (6 for big sets), then swaps and moves; pinned songs keep their
  index. Deterministic.
- **Time model**: a song plays beat-locked to ticks (`resample` or `stretch` at its BPM), so its local beat u
  (from its first downbeat) is at song beat G + u whatever the tempo does. Placing a song = choosing G; the
  first song starts at its file start with its first downbeat on a bar line; then G(i+1) = G(i) + mixOut(i) −
  mixIn(i+1). Mix points are rounded to the song's bars; a mix-out that comes too early moves later by 8-bar
  phrases, a length target takes 16-bar phrases off the longest songs (the last one fades). The overlap of a
  transition never reaches the next one, so at most two songs play.
- **Transitions**: 16 bars (32 for chill or `smooth`, 8 for `quick`, 0 for `cut`), shortened when a song runs
  out. Recipes: `bass-swap` (incoming on an equal-power curve with EQ Pro band 1 at 300 Hz until the phrase
  midpoint, where the bass swaps; outgoing on the cos curve, its lows cut from the midpoint), `filter` (plus a
  low-pass sweep out of the outgoing song: energy drops), `echo` (the outgoing song stops at the end of the
  overlap with an echo throw: clashing keys, 8 bars), `cut` (no overlap, a one-beat echo throw; tempos too far
  apart or no beat grid). A riser ends on the swap when the energy rises (not for chill). Every curve ends at
  'neutral'. Tweaks per transition (bars, recipe, riser) are keyed by the incoming song.
- **Tempo** (`mixTempo: 'follow'`): each song at its own tempo, the tempo gliding linearly from one to the next
  over the overlap (a tempo automation clip; the map evaluates it per 1/16). Ramps are allowed when neither song
  moves more than 6 % (`tempoMatch`, symmetric, with half/double time); otherwise a cut. Songs follow it
  **turntable-style** by default (`resample`: beats sample-exact, pitch bends ≤ the tempo gap during the
  transition, untouched while alone). **Key lock** (`keyLock`) time-stretches instead: the tempo then moves in
  ≤ 1 % steps on bar lines and clips are split at each step, so every piece is stretched at one tempo (no pitch
  bend inside a clip). A fixed mix tempo always stretches. Why turntable by default: the WSOLA stretch moved
  transients by up to ±12 ms, so two stretched songs' kicks were up to 24 ms apart (measured), an audible flam.
- Output: songs (deck A/B alternating, clips with `offsetSec`, gain to the median LUFS ±9 dB, tempo at start/end),
  transitions (start, length, swap, recipe, why), automation items, risers, markers, the tempo curve and steps,
  total ticks/seconds, warnings. fast-check: ≤ 2 songs at once, transitions on downbeats of both songs, tempo
  within the limit, clips tiling each song, curves ending neutral, deterministic.

### Writing it (`app/dj/mix.ts`)

One History transaction (`makeMix`, `mixInDraft`): removes what the previous mix made (`Project.dj.made`:
channels with their clips, markers), then finds or makes (renaming an empty "Insert N" first) **Deck A**,
**Deck B** (EQ Pro b1 low cut 20 Hz / b8 high cut 20 kHz, then a Filter low-pass at 20 kHz, fader 0 dB, a 0-level
send to **Echo**) and **Echo** (Delay ¼ ping-pong, fully wet), a Limiter last on the master; the tempo curve
("Mix tempo" track, holds and glides), one audio clip channel per song on its deck (samples reused by hash),
clips on "Deck A"/"Deck B", curves on "Deck A FX n"/"Deck B FX n" (one automation channel per control and
shape), risers on "DJ FX", a marker per song. `Project.dj` (optional, repaired in `migrate.ts`) keeps the songs
(title, BPM, Camelot, deck, span), options, tweaks and what it made. `replanInDraft`/`tweakTransition` plan the
same songs again in order with a changed tweak; `planOfCurrentMix` gives the plan for the UI.

### Library and UI (`app/dj/library.ts`, `ui/features/dj`)

- The music library: songs stored once by hash in the sample store, title/artist from tags (`core/dj/tags.ts`:
  ID3v2, FLAC/Ogg Vorbis comments, MP4 `ilst`; else "Artist - Title" file names), the list order, pins and the
  selection, kept in IndexedDB. Analysis runs in the background, one song at a time. Add files, add a folder
  (≤ 500 files, the directory picker).
- DJ window (View → DJ mix, ⌥J; the browser's Music section): the songs table (BPM, Camelot badge colored by
  wheel position, energy sparkline, analysis status, drag to reorder, pin, right-click), options (Order, Energy,
  Transitions, Mix tempo, Key lock, Length), the gold Make the mix (asks for a new project when the playlist
  already has other music), then the Transitions list (length, recipe, riser, play from 2 bars before, reset)
  and Export mix (`dj.exportMix`: song mode, then the export dialog). Pure helpers in `dj-view.ts`.
- Studio (`app/ai/ops/dj.ts`, prompt order 22): `dj_mix` (library titles, the selection or everything; songs
  that need analysis are done by the `dj_mix` after-step `app/dj/step.ts`, folded into the answer's undo step)
  and `dj_transition` (from/to by number or title). The context lists the mix (`djLines`) and the library.

### Measured (`test/browser/dj-mix.test.ts`, headless Chrome, 48 kHz)

Three synthetic songs (124, 127.2 and 125 BPM, different keys, first downbeats at 0, 0.21 and 0.05 s) mixed with
known grids: across the 16-bar transition the clicks of both songs (rendered with the other deck muted) land
within 1.5 ms of the mix's beat and of each other; the lows (< 150 Hz) of the sum stay under +3 dB of the songs
alone and never drop more than 7 dB; the incoming song's lows are > 15 dB down until the swap.

### Limits and follow-ups

- Needs the real analyzer (`services.trackAnalyzer`) from the analysis work; until then songs show "Not analyzed"
  and a mix can't be made in the app (tests use the fake one).
- Key lock's beat accuracy is the WSOLA's (±12 ms); and each key-lock tempo step stretches the whole file until
  the engine stretches clip ranges.
- Beat grids with drifting `beats[]` play on the fixed grid (they will slip); 3/4 songs align on their own bars.
- The playlist zooms to the mix after it is made. The live deck view is described in "DJ live decks" below.

## DJ live decks

Two decks (four on request) and a mixer, played live from the music library, in the Decks window (View → DJ decks,
⌥D), from MIDI controllers (`DecksApi`, see `app/dj/decks-api.ts`) and from the Studio. Deck state is **live
performance state**: it is never in the project or History. The decks play through the engine's own output (its
AudioContext, the output device choice, the master safety limiter), so the song transport and the decks are two
independent sources into one master: pressing the main play while decks play is fine (they simply add up; Panic
ducks both for a moment), and `Space` in the Decks window still plays the song. Nothing is created at startup:
`services.decks()` (`decks-factory.ts`) loads the deck code on first use and the audio graph on the first song
loaded; `services.decks.peek()` looks without starting them.

### Layers

- `core/dj/decks-math.ts` (pure, unit-tested): crossfader curves (smooth = equal power, sharp = cut; at −1 side B is
  exactly 0), the squared channel fader taper (1 = 0 dB, 1.25 = +3.9 dB), EQ and filter mapping, tempo sync with
  half/double time (`octaveMultiple`: 70 BPM locks to 140 as half time, 174 to 87), beat phase and the jump that
  aligns it, loops and beat jumps on the grid (auto loops start on the beat under the playhead), the CDJ cue rules
  (`cuePressPlan`), jog speeds. `core/dj/deck-peaks.ts`: the waveform overview (min/max per 256 frames and how much
  of it is bass, for the colors), filled a slice at a time.
- `engine/deck/deck.kernel.ts` (pure DSP, Node-testable) and `deck.worklet.ts`: the player, one AudioWorklet per
  deck. The song's planar float32 audio is a window of blocks in SharedArrayBuffers that the worklet reads directly
  (see "Long songs" below). The deck publishes where it is (position, speed, the
  context frame, whether it waits for audio) under a sequence lock in a shared state block (`deck-id.ts` `DS`), which
  the main thread (waveforms, platter) and a follower deck read. Commands are messages (`DeckMessage`); `ping`/`pong`
  is the barrier offline renders and tests wait on (`DecksApi.settled`, which also waits for every deck's window to
  hold what is about to be heard).
- `core/dj/beat-map.ts` (`BeatMap`): tracked beats as a clock (phase exact at each beat, linear between; tempo from
  the beats around, averaged over ±2 and interpolated, so it doesn't step at every beat). `DeckGrid` carries one
  (`deckGridOf`) when the analysis has `grid.beats` (≥ 8): loop/jump/cue snapping in `decks-math.ts` and sync in the
  kernel read it, the waveform draws the tracked beats. Songs without tracked beats use the fixed grid, unchanged.
- `engine/deck/deck-graph.ts`: per deck player → trim → low shelf 120 Hz → mid bell 1 kHz → high shelf 7 kHz →
  low-pass → high-pass (the one-knob filter, Butterworth Q) → meter, then the cue send and the channel fader →
  crossfader side; master volume → the same limiter kernel as the engine's → the engine output (and the master
  meter, and the recorder). `engine/deck/tap-capture.ts` records any node in stereo through the streaming input
  recorder's worklet (a 30 s ring drained every 50 ms), so a take is limited only by memory. The cue (headphone) bus
  plays through a second output device (`setCueOutput`: a MediaStream destination into an `<audio>` element with
  `setSinkId`).
- `app/dj/decks.ts`: the `DecksApi` (a zustand store plus the control logic: load, cues, loops, jog, sync, mixer,
  recording). `EngineApi.deckHost()` (optional; `engine/api.ts`) hands out the running context, a node feeding the
  master limiter, `loadModule` and the audible clock. When the engine reboots (a new AudioContext) the decks notice
  through `engine.subscribe`, rebuild the graph, hand the songs over (decoding again if the rate changed) and carry
  on from where each deck was.
- `ui/features/dj-decks`: the window. Waveforms, overview, platter rotation and the clocks are drawn on the frame loop
  by `DeckScope` (redraws only when the position, the deck's state, the theme or the size changed; no React commits
  while a song plays). The panel selects only what it draws as React (`useShallow`), the 5 Hz store updates of
  position and level don't re-render it. Keys (focus-scoped to the window, so they never clash; the typing piano is
  off there): deck A `Q W E T` play/cue/sync/key lock, `A S D F` hot cues 1–4, `Z` loop 4, `X C` jump; deck B `U I O P`,
  `H J K ;`, `M`, `, .`; `← →` `Home End` the crossfader. Cue is a hold: its key-up is caught by a window listener.
- `app/ai/ops/decks.ts`: Studio actions `deck_load`, `deck_play`, `deck_sync`, `deck_set`, `deck_crossfade`,
  `deck_loop`, `deck_record`, a prompt section (order 23) and a `<decks>` block in the context. They are UI-type
  actions: validated into one `decks` request that runs after the answer (`runDeckActions`), never an edit of the
  project. Tested with scripted answers and a recording fake `DecksApi`.

### How it plays

- **Turntable** (key lock off): the position advances by the speed each output frame, read with 4-point cubic
  interpolation; at exactly 1× it is a sample-exact copy. +8 % is 8 % higher, like a record.
- **Key lock**: a streaming WSOLA in the worklet (2048-sample Hann frames, 50 % overlap, each frame taken near where
  the tempo says and moved up to ±448 samples to where it best continues the one before; a 4× decimated search then
  ±4 samples at full rate, with a small cost for leaving the middle). The nominal position keeps counting at the tempo,
  which is what loops and sync read. Scratching falls back to the turntable path (a stretch of a reversed signal is
  meaningless); switching paths fades over 2 ms.
- **Hits stay whole** (`planTransient`; the idea of the arrangement stretch's `detectOnsets`, run lazily around the play
  position): mean-square energy per 2.7 ms hop, cached by hop index, an attack being a hop where the next ~10 ms are
  more than 8× the ~20 ms before. A plain frame is spliced (it moves ±448 to continue the one before), and a hit in or
  near a splice is heard twice (two frames carry it at different times) or lands up to 10 ms early or late, and drums
  at ±16 % soften. So when an attack is 1344–2368 output frames ahead, the next frame starts a run: it is placed so the
  attack lands where the tempo puts it (`c − (c − pos)/rate`, a search of only ±64 frames = 1.3 ms to join the frame
  before), and the following frames continue each other exactly (input at its own speed, which overlap-adds back to the
  original samples) until the next splice would begin 930 frames after the attack. The stretch the run skipped is
  made up by the frames after it (the lead decays by half a frame), the published position stays nominal. A run goes
  on past a second attack only if that one also lands within 2 ms; of two attacks closer than a run can hold the
  stronger one wins; no runs while a loop shorter than 4 frames is on. Cost: the same as plain key lock (a run skips
  the similarity search).
- **Jumps never click**: a seek, start, stop, mode change or loop move renders the next 2 ms of the old sound
  forward, fades it out and fades the new one in. Loops are the exception on purpose: the position wraps by the loop
  length (a fractional part kept) and reads past the end continue from the loop start, so a loop is the source's own
  samples with nothing added at the seam.
- **Sync**: the follower reads its master's published position and tempo every render quantum, matches its tempo as
  `ratio × masterTempo` (ratio = master BPM / (own BPM × multiple)) and closes the beat-phase error with a tempo trim of at most 2 % (time constant 1.5 s); a
  start, a sync press or a master jump aligns it exactly at the next quantum (`align`: it waits 150 ms for a master
  that starts with it). It runs in the audio thread, so it needs no messages and cannot drift; while the master
  scratches the follower keeps its tempo and doesn't chase the phase. A song with tracked beats (`grid.beats`, a
  drummer speeding up, an old record) hands its beats over in frames (`SyncSpec.selfBeats/masterBeats`): the phase is
  the beat number of the `BeatMap` at each deck's position (× the half/double multiple) and the tempo ratio is the local
  beat length of the follower over the master's at its position, so a drift on either side (or both) is followed
  beat by beat; the 2 % phase trim, the align at a start or a jump and the follower's state are the same. Fixed grids on
  both sides keep the one ratio. A master that waits for audio (below) counts as not playing, and the follower aligns
  to it again when it is back.
- **Cue and hot cues** follow the CDJ (paused: sets the cue point on the beat and previews while held; playing: back to
  it and pause; play while holding latches). Cue points and the eight hot cues are kept per song (IndexedDB, by content
  hash). Hot cue pads: set when empty, jump and play when set.
- **Recording** (`startRecording`/`stopRecording`): stereo after the limiter, encoded to 16-bit dithered WAV as the
  chunks arrive (`WavStreamEncoder`), so an hour is ~700 MB, not a float copy; on stop it is added to the music library
  as "Live mix 2026-10-16 14:05" and analyzed like any song.

### Long songs: a window of blocks (`engine/deck/deck-stream.ts`, `deck-source.ts`, `core/dj/deck-window.ts`)

A deck never holds its whole song. The song is cut into blocks of 2^16 frames (1.4 s at 48 kHz); a **pool** of slots
(planar float32, `slots × 65536` frames per channel, SharedArrayBuffers) holds a window of them and a **block table**
(Int32, the slot of each block or −1, same memory) tells the player where each is. The window is half a minute behind
the play position and a minute and a half ahead, plus **pinned places**: the cue point and the hot cues (their first
2.8 s, from 0.1 s before) and an active loop (up to 45 s), so a jump to any of them needs no wait. That is ~150 slots,
about 80 MB at 48 kHz stereo (mono shares one array; a song that fits is held whole, no bigger than it is), the same for
a 5-minute song and a 2-hour one. `planWindow` (pure, unit-tested) orders what is wanted: the 4 s about to be heard,
the pins (nearest first), the rest ahead, then behind; over capacity the far window goes before a pin.

`DeckStream` (main thread) loads in that order, one block at a time, from a `DeckSource`, and follows the playhead:
`moveTo(frame)` at every seek/cue/jump (the blocks around it first; a source in memory fills them synchronously, before
the player is told, so such a jump never waits), `update(pos, rate)` from the deck ticker (5 Hz). A block's table entry is
set after its audio is written and cleared before its slot is reused, and nothing within three blocks of where the
player is or was told to go is ever taken, so the player never reads a block that is being overwritten.

The player checks, every render quantum, that the blocks under what it is about to read are in the window: its position,
a little behind for the stretch's search, 0.3 s ahead. If not (a jump outside the window, a decode that fell behind) it
**stalls**: the sound fades out over 2 ms, then silence, position and tempo held, `DS.stalled` published; when twice that
much is there it fades in from where it was. A follower treats a stalled master as not playing and aligns to its beat
again when it is back. Measured in real time on a 12½-minute WAV in the sample store: a jump to a hot cue leaves 0.0 ms of
silence (a crossfade as before), a jump to a part nothing had asked for leaves 6 ms.

**Where the audio comes from.** Up to 12 minutes (`LONG_SONG_SEC`) the song is decoded whole through the shared sample
cache as before (`bufferSource`: the `AudioBuffer`, pinned in the cache while the deck has it; a block is a copy). Longer
songs whose file can be read by parts are never decoded whole (`openSegmentSource`, the file as an OPFS `File` through
`SampleBytesProvider.getBlob`, `BlobStore.getFile`):

- WAV/RF64: the `fmt `/`data` chunks give every frame's byte position; a piece is a few frames' bytes behind the file's own
  header and `decodePcm` reads it (8/16/24/32-bit, float, extensible).
- MP3: browsers can't decode part of a compressed file, but they can decode a file that is only part of one. Every frame
  is self-contained but for the bit reservoir (up to 511 bytes of the frames before it), so a run of frames starting four
  early decodes exactly from its second frame on. `indexMp3` reads every frame header once at load (a hop per frame:
  2.2 MB of offsets and 45 ms of CPU for a 2-hour 320 kbps file, plus reading its 288 MB in 4 MB steps) and LAME's gapless numbers (a whole-file decode skips the encoder
  delay + the decoder's 529 samples; a piece is placed with the same skip). `decodeAudioData` on 256-frame pieces
  (6.7 s) in an OfflineAudioContext at the file's own rate, four pieces kept. Measured against decoding the whole file:
  **bit identical** (difference 0), across the seams between pieces.
- Resampling to the context's rate is done here, not by `decodeAudioData` (which would resample each piece on its own and
  leave a step at every seam): `core/audio/resample.ts`, a windowed sinc evaluated per output frame at its exact position
  from the source samples around it (64 taps, Blackman–Harris, 4096 phases), so converting in blocks gives the samples of
  converting whole (checked bit for bit), −70 dB error up to 18 kHz, a higher source rate is filtered first. A block
  takes ~13 ms (1 % of a core while a deck plays through the song; sliced with yields so no 10 ms stalls).
- Anything else (AAC in M4A, Ogg, FLAC, AIFF) is decoded whole once through the cache: up to 45 minutes
  (`MAX_WHOLE_DECODE_SEC`, 1 GB of floats), longer ones are refused with a message to use MP3 or WAV.

*Why not decode in a Worker with WebCodecs.* `decodeAudioData`/`OfflineAudioContext` don't exist in Workers, but the
browser already decodes off the main thread, and the main thread only slices bytes and resamples (13 ms per 1.4 s). WebCodecs'
`AudioDecoder` (Worker-capable) would need a demuxer per container (frame boundaries of MP3/AAC/FLAC, M4A's sample tables,
Ogg pages), a lot of code for no gain on the formats a long mix is actually in; the segment index above is ~120 lines per
format and its result is checked bit for bit against the browser's own whole-file decode. Not done: segmenting FLAC (frame
boundaries need a CRC-8 scan) and AAC.

The **overview** of a streamed song is made by reading it through once in the background at its own rate (no resampling;
22 s per read, the drawing told every few reads, so it grows as it goes: tens of seconds for two hours) and the deck is
playable before it is done. **Analysis** of a streamed song runs in the background from the same kind of ranged reading (see
"Long songs: analysis in pieces" above) and the deck gets its grid when it finishes (until then no sync; the cue point is
the start); a cached analysis is used at once.

### Measured (headless Chrome and Node, M-series Mac under other agents' load, 48 kHz)

- Kernel CPU (Node, 60 s of audio, stereo): turntable 72 ms (0.12 % of a core), key lock 512 ms (0.85 % of a core,
  117× realtime) per deck; re-measured against the version before the window of blocks and the attack runs, both in one
  process, best of five 10 s runs (quiet machine): turntable 0.07 → 0.10 %, key lock 0.52 → 0.55 % of a core (a
  drum loop with attacks: 0.51 % against 0.54 % without the runs, which skip the similarity search; the test holds the
  ratio under 1.5×). The block table lookup must not go through an imported binding (`BLOCK_BITS` read through the module
  object made the turntable 5× slower in Node), so the kernel copies the constants.
- Sync (`test/browser/dj-decks.test.ts`, 124 BPM against 128 BPM songs with different downbeats, clicks of different
  pitch, B joining A half a second in; 90 s rendered offline in the regular run, 5 minutes with `VITE_LONG_DECKS=1`, the
  numbers below): the beat offset between the decks' clicks, measured
  on the rendered master, is within 0.055 ms at worst and drifts −0.00006 ms over the 5 minutes with key lock off; with
  key lock on 0.85 ms worst and 0.0016 ms drift (the stretch moves a click by what its search moves it). The kernel
  test holds the position-math phase within 2 ms (settled: 0.5 ms) in both modes and both node orders.
- Key lock at +8 %: the pitch of a 440 Hz sine stays within 0.5 % (browser: 1 %); the tempo is 8 % faster; without key
  lock it follows the speed (+8 %). Key lock off at exactly 1×: bit-exact.
- Loops: the render of a 4-beat loop repeats with exactly the loop's length in frames and one frame more or less is
  clearly different; against the source it is within the EQ/filter's own few hundredths (0.05 of a 0.8 click).
- EQ: a −26 dB kill takes 50 Hz, 1 kHz and 14 kHz down by more than 20 dB (60 Hz −22, 12 kHz −23, 1 kHz −26) and
  leaves the other bands within 1.5 dB. Crossfader at −1: B more than 60 dB down; at the middle each side −3 dB.
- Key lock and hits (`deck.transients.test.ts`, 5 ms clicks of 0.9 every 0.5 s, 40 s through key lock; before = plain
  frames, after = attack runs): at 0.85× the worst click is 3.72 ms off its tempo time and within 0.49 dB, at 1.2× 3.46 ms
  and 0.76 dB; after, 0.01 ms and 0 dB at both, one burst per click. Over a quiet noise bed (the search has something
  to grab): before 13 of 40 clicks doubled at 0.85× (up to 10.8 ms off, 1.3 dB), 3 of 40 lost at 1.2× (down 18 dB);
  after none doubled or lost, within 1.34 ms and 0.38 dB. A 124 BPM drum loop (kick, snare, hats, bass) at 0.9×/1.1×/1.3×:
  each kick and snare correlates with the input's hit at −0.02/0.13/−0.22 before (not even within ±4 ms) and at 1.000
  after, within 1.4 ms; a held tone under noise bursts has no step beyond the tone's own around the runs.
- Drifting grids (`deck.drift.test.ts`, kernel positions; `dj-decks.test.ts`, the rendered master): a song whose drummer
  goes 120 → 124 BPM over 3 minutes, synced to a steady 124 BPM song (the fixed grid is its average, 122): worst beat
  offset 241 ms (half a beat: out of lock, over 5 ms from 3 s in) with the fixed grid and **0.04 ms** with tracked beats
  over 190 s, key lock off and on; a drifting master with a steady follower 249 ms → 0.02 ms; two drifting songs, one
  speeding up and one slowing down, with key lock 0.04 ms.
- Streaming (`test/browser/dj-long-song.test.ts`): a 2-hour stereo song (a WAV that never exists, made as it is read)
  loads in a window of ~80 MB and the page grows by **114 MB** (pool, 16 MB overview, tables) with a hot cue 5000 s in
  and the playhead at 1:30:00 (the clicks heard there are on time to the master limiter's 1.3 ms delay, 0.5 s apart
  exactly); before, a deck copied the whole decoded song into shared memory (20 minutes: 461 MB, 922 MB with the cache's
  copy) and refused anything longer. A 12½-minute WAV in the real sample store, real engine, real time: nothing decoded
  into the cache (0 decodes, < 1 MB used), a jump to a hot cue 0.0 ms of silence, a jump to an unloaded part 6.5 ms,
  the largest step in the tone away from the clicks 0.0060 (the tone's own), jumps included.
- Real engine (Engine.realtime, two key-locked decks, sync, a recording, the meters): `keepUp` 1.0 (≥ 0.98 required,
  measured as `app/playback-health.ts` does, over one-second windows); a 3.5 s recording is 3.5 s long in the
  library; a reboot of the engine carries the playing deck over. Offline: 60 s of two key-locked decks with EQ and
  filter renders in 1.1 s (54× realtime) with the decks' worklets and graph.

### Limits and follow-ups

- Streaming reads WAV and MP3 by parts. AAC (M4A), Ogg, FLAC and AIFF are decoded whole (up to 45 minutes, 1 GB of floats);
  FLAC (a CRC-8 scan for frame boundaries) and AAC (ADTS frames; M4A sample tables) are the next to segment. MP3 with
  free-format frames or Layer I/II isn't segmented. A streamed song is read from the stored file for as long as it is on
  a deck: if clean-up of unused audio removes it meanwhile (it is no longer in the library or a project), the blocks that
  haven't been loaded yet are silent.
- A streamed song has no grid (so no sync, snapping or bar loops) until its analysis, made in the background, has
  finished (minutes for two hours: see the measurements under "Long songs"). The overview of a 2-hour file takes tens of
  seconds to complete (read through once, in the background).
- Opening a long MP3 reads through the whole file for the frame index (the disk's speed: a second or so per hour); a seek beyond the
  window waits for the first blocks (WAV 6 ms, MP3 a decode of 6.7 s of frames ~ 30–60 ms plus the resample).
- The attack runs keep drums whole; pads and sustained notes still go through the plain WSOLA (a phase vocoder would be
  better for them), the runs only help where an attack is detected (energy up 8× in ~10 ms: soft or slow attacks aren't), and
  hits closer together than a run can hold (about 150 ms) give way to the stronger one, so fast hat rolls soften as before.
  Tempo changes between −50 % and +50 %, stretch limited to ½–2×.
- Tracked beats are used as the analysis gives them: a wrong beat in `grid.beats` is followed. 3/4 songs sync by beat, not
  bar. A loop that starts on a beat has the length of the beats there (the loop itself is a fixed number of frames).
- The cue (headphone) bus needs a second output device (Chrome `setSinkId`); without one the CUE buttons are silent.
- Scratching follows the platter's speed (any direction); there is no vinyl brake or spin-up on stop.
- Controllers: `jog`, `jogTouch`, `cueDown/cueUp` and the rest of `DecksApi` are all they need; `readLevels`, `waveformOf`,
  `analysisOf`, `setBeatJump`, `setDeckCount`, `setCrossfaderCurve`, `crossfade`, `setCueDevice`, `keepUp` and `settled`
  were added to the interface as optional members.

## DJ controllers

MIDI DJ controllers drive the live decks (`DecksApi`, `app/dj/decks-api.ts`). Live control is performance, not an
edit of the project: nothing here goes through History (a controller is not the knob "Link to controller…" of
`app/controllers.ts`, which writes project parameters through History; the two do not share state).

- **Pure mapping layer** (`core/midi-map`, no DOM, unit tests in `midi-map.test.ts`):
  - `message.ts` parses channel messages (note on/off, CC, pitch bend; a velocity-0 note-on is a note-off) and builds
    the bytes sent back for LEDs. `relative.ts` decodes the three endless-dial encodings to signed steps
    (two's complement 1/127, sign-magnitude 1/65, centred on 64 = 65/63). `cc14.ts` pairs CC n (coarse) with CC n+32
    (fine) per channel and yields a value on the fine byte once a pair has sent one (so the value never steps).
    `soft-takeover.ts` is the pickup: hardware is ignored until it is within 0.03 of the software value or crosses it,
    and it lets go again when something else (the mouse) moved the software value.
  - `targets.ts` is the catalog of what a controller can drive: ids like `A.play`, `B.hotcue:3`, `A.eq.low`,
    `crossfader`, `browse`, `record`, `app.playPause`, each of kind `button`, `abs` or `rel`; `led: true` marks the
    ones with a light. `types.ts` is the mapping (inputs: note, cc, cc14, rel with its encoding, pitch bend; bindings
    with optional `layer`, `invert`, `scale`; shift keys; LEDs) and its JSON import/export, which drops what it does not
    understand and counts it. `interpreter.ts` turns messages into `ControlEvent`s: shift layers (a held shift key
    selects the bindings of its layer, otherwise the normal binding; a release goes to the binding the press used),
    CC buttons with press/release edges, 14-bit and relative handling. `learn.ts` detects a control's type from
    its messages (a note = button, bend = fader, CC + CC+32 = 14-bit, a sweep = fader, repeated small steps with both
    directions seen = endless dial and which encoding); the target's kind breaks ties.
  - `presets/` holds the maps by device name (see below). Each file names its source.
- **App layer** (`app/dj/controllers`): `manager.ts` (`DjControllers`, one per services object via `djControllers(services)`):
  asks for MIDI with `requestMIDIAccess({ sysex: false })` (denied or unsupported are states, not errors), listens
  with its own `midimessage` listeners (the keyboard `MidiInput` keeps working, and ignores devices that have a
  mapping: `midi.ignore`), keeps one `MappingInterpreter` per port, applies soft takeover to faders and knobs,
  runs learn, and saves the maps the musician made or changed per device name in IndexedDB (`storage.ts`; an untouched
  preset is not stored, "Reset" returns to it). `abs.ts` converts hardware positions to deck values and back (EQ: kill
  −26 dB … 0 dB at the centre … +6 dB; trim ±12 dB; filter with a dead zone at the centre; pitch ± the deck's range,
  higher = faster; channel fader 0…1). `dispatch.ts` turns control events into `DecksApi` calls (cue on both edges,
  jog nudge until the platter is touched then scratch, search seeks 0.25 s per step, one jog tick = 1/600 turn, a loop pad pressed
  again leaves its loop, load loads the browse encoder's highlighted song on that deck). `browse.ts` is the highlight in
  the music library. `leds.ts` derives on/off for every light from the deck state and `LedFeedback` sends only what
  changed, and everything on connect or when the decks come up; lights go dark on disconnect.
- **Decks source** (`decks-source.ts`): the controllers get the decks from `setDecksProvider(() => decksOrPromise)`
  (the decks implementation calls it once), else `services.decks` (a `DecksApi` or a `DecksFactory`), else in
  development a `FakeDecks` stand-in (`fake-decks.ts`; `test/helpers/fake-decks.ts` re-exports it) and the window says so.
- **UI** (`ui/features/dj-controllers`): View → DJ controllers (`dj.controllers.open`), "Link a DJ controller (MIDI
  learn)…" (`dj.controllers.learn`, optional `{ target, shifted }`: opens the window and waits, the Studio can run it but the
  musician touches the control), `dj.controllers.connect`. The window lists the controls per deck with their links,
  Learn / + Shift / Clear per row, a Shift-key row, soft takeover and LED options, ready-made map picker, Export / Import,
  a Test tab (every incoming message and what it did, while the tab is open). In learn mode a click on any element with
  `data-dj-target="A.play"` (the Decks window's controls) picks it; right-click on one offers "Link to controller…" when
  it has no menu of its own.
- **Presets** (`core/midi-map/presets`), matched on the device name with letters and digits only: Pioneer DDJ-400,
  DDJ-FLX4 and DDJ-200, Hercules DJControl Inpulse 200 and 300, Numark Mixtrack Pro FX. Values come from the public Mixxx
  mappings (GPL; authors in each file's header; only addresses and encodings, no code). Not shipped: Inpulse 500 (its
  jog wheel encoding lives in Mixxx's component library, not in its map) and Platinum FX (four decks, the published map
  could not be read in full). The pitch fader direction follows Mixxx's `rate` convention (Pioneer and Numark: a higher
  raw value is faster; Hercules is the other way round, so its bindings have `invert`).
- **Tests**: `midi-map.test.ts` (parsing, encodings, 14-bit, shift layers, takeover, learn detection, JSON),
  `app/dj/controllers/controllers.test.ts` (presets, deck calls, LED messages against `FakeDecks`, learn, mappings),
  `test/browser/dj-controllers.test.ts` (fake `MIDIAccess` in the real app, the window).
- **Gaps**: four-deck layer switching (a two-channel controller drives A and B only), sysex start-up messages (SysEx is not
  requested), colour LEDs and blinking, pad modes other than hot cues and beat loops, jog touch-less scratch tuning (one ticks-per-turn constant).

## Arrangement: songs that flow (v3)

The musician asked for songs that sound finished "off the bat", with smooth transitions as the minimum. Their
AI-made song (rebuilt as `buildStackedSong` in `core/fixtures/stacked-song.ts`) shows what was missing: 2-bar
loops repeated 8 times unchanged, a tom fill on its own track on top of the full beat, no gap before the drops, a
crash on every loop, risers and automation hand-placed on random tracks. The split of work: **the AI decides the
structure** (sections, which beats play, the energy); **deterministic code does the craft**.

### Variants, not copies (`Pattern.derived`)

- A section's beat stays the editable source. Variation becomes *variant* patterns with
  `derived: { from, steps, seed, hash }` (`core/model/types.ts`, optional in schema v3): the source, the
  `VariantStep`s applied to its notes (pattern ticks, energy, level, parts), the seed of their jitter, and the
  hash of the notes as written (`notesHash`, ids ignored).
- One variant per (source, steps) (`variantKey`), named for what changed, "Drop · fill + slide"
  (`variantName`; a repeated name gets " 2"); variants sit after their source with its color. Plain repeats play
  the source itself.
- Rebuilt when the source changes: the arrange module's `beforeCommit` compares each source with `c.base` and
  rebuilds its *unmodified* variants (notes still match the hash); a variant edited by hand is left as it is.
  "Refresh variations" (Playlist menu) does the same after hand edits to a source.
- Repair (`migrate.ts`): a variant whose source is missing, itself, part of a loop or whose steps are malformed
  becomes an ordinary pattern; deleting a source does the same (`removePattern`).

### Core (`src/core/arrange`, pure, plain loops so drafts are fine)

- `roles.ts`: what each channel plays (`channelRole`), General MIDI drums on kit channels (`noteRole`), and part
  names people use ("hats", "808s", "melody": `partName`, `inPart`).
- `fills.ts`, the generators. Every fill **replaces** the drum notes in its span (never layers):
  - snare fill (1, 2 or 4 beats; 2 beats = 8ths .55/.62, 16ths .70/.76, 32nds .82→1.0); tom fill (high, mid and
    low pairs .90/.72 ending on the loudest snare; tom channels by height, one tom ±5 st, or kit keys 48/45/41);
    hat fill (1/32s, triplets for drill and afro, rising .45→.95, snare on its last two 16ths); kick-snare fill;
  - snare build over a build's last 4 bars (quarters, 8ths, 16ths, 32nds, .40→1.0; spread over several clips
    with `offset`/`total`; house and EDM keep the kick on the beat until its last quarter);
  - hat roll (eight rising 1/32s replacing the hats of that beat), open hat on the last 8th;
  - 808 slide: a new note half a beat before the end, an octave away within MIDI 24–48 (else a fifth or fourth
    in the song's scale), the note before stretched to overlap it by 120 ticks so the 808 glides;
  - gap (drums and bass out; a bass note held into it ends a 1/32 early so its release has died away), dropout
    (everything out, held notes cut at its start), stutter, thin 1 (no ghosts, percussion or off-8th hats) and
    2 (hits on the beat), double hats, without (parts or channels), clear-drums (room for a fill on another
    track).
  - Velocities scale with energy (×0.80 at 1 … ×1.0 at 5) plus a seeded ±0.03 jitter; crescendos keep rising to
    their last, loudest hit. Each step draws from its own seeded generator, so a step that changes nothing is
    dropped without changing the rest. Missing instruments fall back (a tom fill without toms is a snare fill).
- `variants.ts`: `applySteps` (with the steps that were effective), keys, seeds, names, `mergeSteps` (a new
  fill replaces an overlapping one of its family).
- `sections.ts`: roles (intro, verse, pre, build, drop, hook, chorus, break, bridge, outro), default energies,
  usual lengths, `roleFromName`.
- `phrases.ts`: every 8 bars (house and EDM 16) a fill, 2 beats at energy ≥ 3, rotating by style
  (`FILL_ROTATION`), with a crash on the next bar at energy ≥ 4; every 4 bars (house and EDM 8) a small change
  (hat roll or 808 slide for trap, drill, EDM and pop; open hat or slide for the rest); double hats in bars 9–16 of
  16+-bar sections at energy ≥ 4. **The guarantee**: identical clips never run for more than 4 bars (a 2-bar loop
  is never followed by more than one identical copy); where they would, a small change goes at the 4-bar mark.
  The section's last bars belong to the transition out of it.
- `transitions.ts`: `classifyBoundary` (rise at Δ ≥ 2 or a build into a drop, chorus or hook; lift, same, dip,
  fall; into a build is at most a dip; outro; the start is the intro) and `boundaryRecipe`, the table in the
  file's header: fills, the gap (1 beat; 2 beats plus a full stop at Δ ≥ 3), risers (1, 2 or 4 bars, closest to
  6 s, never starting before A) and reverse crashes that end exactly on X, impacts, sub drops (trap, drill, EDM,
  house at Δ ≥ 3), downlifters, crash velocities, the high-pass sweep up across the riser, the low-pass that opens
  after a fall, the intro's opening low-pass and reverb throws. `endingRecipe`: a master fade over the last 4
  bars, or a stop for trap, drill, boom bap and reggaeton (the last bar plays one beat, with a crash, an impact
  and a throw).
- `plan.ts`: `planArrangement(p, req, env)` lays each section's beats out back to back (one lane per source),
  thins a beat in a section 2+ energy below its loudest one, turns the phrase and transition events into each
  clip's steps (`stepsForClips`: fills go to the clip with the most drums, the others make room; slides to clips
  with an 808; gaps and section changes to every clip), places FX, crashes (at most one per 4 bars, transitions
  first) and automation (one clip at a time per control) with `LaneAllocator` so nothing overlaps on a lane, and
  notes the loop-start crashes to move. `planDevelop` plans the same craft for an existing song's sections,
  keeping FX already within a beat, crashes within 4 bars and fills that play from their own clips (nothing adds
  drums under them), and staying within the range ±1 bar (`SongEvent.within`).
- `apply.ts`: `applyArrangement` (clears its range, or the whole song for a whole-song arrangement; the
  arranger's own sounds and curves go whole), `deriveVariant`, `applyEditsInPlace` (splits a looping clip at its
  repeats so only the one with the change becomes a variant), `refreshVariants`, `collectGarbage` (variants,
  FX and crash channels, arranger automation nothing plays any more), `placeFx`, `placeCrashes`,
  `placeAutomation`.
- `infer.ts`: sections from markers (or where the set of patterns playing changes), energy from what plays
  (kick, backbeat, hats, bass, music parts, density), fills on their own clips and the drums under them, the
  loops, and the FX and crashes already there (`existingFx`, from FX sounds, FX channels' notes and names).

### Sounds, crashes and automation

- Transition sounds are built-in samples named after their length at a tempo, `fx/riser/16b@150`
  (`core/model/fx.ts`), generated by `engine/kit/fx.ts` (seeded from the name; riser = noise band-passed from
  300 Hz to 9 kHz plus detuned saws gliding up two octaves, swelling 30 dB; reverse crash peaking in its last
  3%; impact peaking within 50 ms; sub drop 65 → 28 Hz; risers, swells and whooshes high-passed at 150 Hz so the
  gap stays clean). `SampleCache.getSync` and `kitDuration` know them; older versions load the names as silence.
  They play on audio clip channels (one per sound) with `stretch: 'resample'` at the song's `sourceBpm`, so they
  stay on the beat if the tempo changes, on the tracks "FX risers", "FX swells", "FX hits", "FX sub", through the
  FX bus when there is one.
- Crashes: a crash on a loop's first 1/32 crashes every loop, so it moves out of the source (develop: only from
  patterns that loop) and crash hits play where the transitions call for them, as audio clips of the song's own
  crash sample on "Crashes" (clip gain = velocity).
- Curves (`app/arrange/env.ts`): filter sweeps move EQ Pro b1 (low cut: the build's high-pass) and b8 (high cut:
  the intro's and breakdown's low-pass) on the Chords and Lead buses. A song without them gets them with the mix
  layout's names (an empty "Insert N" reused first), the chords or lead parts that play straight to the master,
  and tracks that carry only them, routed through, and one EQ Pro with both bands on at neutral (20 Hz, 20 kHz);
  the mix setup finds them by name. Throws move the Chords → Reverb send (only when that send exists), fades the
  master. 'neutral' is where the control sits, so every curve ends there (automation holds its last value),
  except the fade at the very end. One automation channel per purpose, control and length, reused, on
  "Automation N" tracks.

### App, AI and UI

- `app/arrange/run.ts`: the draft-level operations shared by the AI and the menus (`arrangeInDraft`,
  `developInDraft`, `transitionInDraft`, `varyInDraft`, `refreshInDraft`), each returning change lines, the span
  it edited and the checker's findings. `check.ts`: `checkArrangement` on what song mode plays (stacked,
  static-loop, no-fill, layered-fill, no-gap, crash-spam and the arranger's curve-not-neutral are bugs; no-riser,
  no-impact, abrupt-end and the musician's own curves are notes). `summary.ts`: `derivedLabel` and
  `arrangementLines` in the AI's view of the project ("variant of “Drop”: fill + slide"; sections with energy),
  `arrangeSummary` ("Arranged 76 bars: Intro 1–8 · … · 6 fills, 3 builds (riser, gap, impact), 1 breakdown,
  outro stop").
- AI actions (`app/ai/ops/arrange.ts`): `arrange` (sections with name, bars 1–64, role, energy, play, without,
  vary, transition_in, fill; fx, mix, outro; up to 24 sections and 512 bars; every reference resolved before
  anything changes; `mix: 'auto'` runs `setupMix` in rebuild mode and asks for `level_mix`; asks for song mode;
  checker bugs become warnings), `develop`, `transition` and `vary`. In a part of the song they default to it and
  check every span with the focus guard. The prompt's "Song craft" section (order 20, `arrange-prompt.ts`) explains
  sections, energy, phrasing and the arc, one beat per section (`beat` with `pattern: "new"` and a `ref`) then ONE
  `arrange`, never hand-placed transitions, and ends with a worked trap example that a test applies.
- UI (`ui/features/arrange`, no AI): Playlist menu "Develop this part (fills, transitions)" (the loop region, the
  selected clips, else the song), "Add a fill here", "Add a transition here", "Refresh variations"; marker, ruler
  and clip right-click entries. One undo step each, a toast saying what happened.

### Measured (`test/browser/arrangement.test.ts`, headless Chrome, 48 kHz, ≤ 8-bar windows)

A 36-bar song at 140 BPM (Intro 4, Verse 8, Build 4, Drop 8, Break 4, Outro 8) arranged by `arrange`: the lows
of the beat before the drop are 14 dB under the same beat a bar earlier (what remains is the snare build's last
hits ringing out), the riser stem rises 43 dB into its last beat, the reverse crash peaks 14 ms before the
downbeat, the impact's onset lands within 0.1 ms of it, the drop measures 3 dB louder (LUFS) than the verse, and
the FX stem renders bit-identically twice. Node: fast-check checks the planner's promises on random section
lists (no overlaps on a lane, a fill at every phrase end, gap + riser + impact at every rise, crashes 4+ bars
apart, curves ending neutral, the right total length); `develop` on the stacked song leaves no stacked copies, no
layered fill, gaps before both drops and no duplicate FX.

### Limits and follow-ups

- The prompt's example uses the beat action's `pattern: "new"` and `ref`; until that lands (the Sound wave), its
  test applies each beat as its own answer.
- Reverb throws need a Chords → Reverb send (the mix setup makes one); `mix: 'keep'` skips sweeps where no Chords
  or Lead bus exists rather than building one.
- Crash hits play the crash sample directly (not through its sampler's envelope).
- Energy is inferred from what plays when a song has no plan (develop, the checker): a dense verse can read as 5.
- Drum tails ring into gaps (only the bass is ended early).

## Long audio (DJ mode foundations)

DJ mixes are 10–30 songs of 3–6 minutes on the playlist as audio clips, beat-matched by time-stretching, exported
up to 90 minutes. A 5-minute stereo song is ~115 MB decoded (float32 at 48 kHz) and as much again stretched, so
the engine can't keep everything decoded, can't stretch whole files on demand and can't render an hour in one
OfflineAudioContext (2 GB). What it does instead:

### One sample cache with a memory budget (`engine/samples.ts`, `engine/budget-cache.ts`)

- The app owns one `SampleCache` (`services.sampleCache`, with the OPFS bytes provider and the disk store below). The
  realtime engine, every offline render (exports, freeze/consolidate, mix analysis, auto-level) and `measureTail` get it
  as `EngineOptions.sampleCache`: nothing is decoded twice. An engine made without one makes its own (tests).
- Budget: `prefs.sampleMemoryMb` (default 1536 MB) of decoded audio (frames × channels × 4). Least recently used
  entries go when it is over; pinned ones never. Keys: `e:<hash>:<rate>` (decoded file), `b:<generator>@<v>:<rate>`
  (built-in, regenerated when evicted), and derived copies under the sample's key: `…|rev`,
  `…|st2:<scale>:<from>-<to>` (stretched part, seconds of the played sample), `p:<sha256>:<rate>` (browser previews).
- Pins: what the residency plans (below); every voice pins the buffer it reads until its release has ended (the clip
  player's holds, swept on the scheduler clock, before every offline chunk and after stop): **nothing evicts audio that
  is playing**; plugin sample slots (`HostImpl`, samplers keep their buffers); a preview while it sounds.
- Decodes: two at a time, `decodeAudioData` (the browser decodes off the main thread). Files it rejects (AIFF, odd
  WAVs) are parsed in `engine/pcm.worker.ts` and come back as float WAV for `decodeAudioData`, so they are resampled
  like the rest. Peak overviews (`engine.waveform`) are computed a slice at a time and outlive their buffer, so the
  playlist doesn't re-decode to draw. Samples removed from the project are freed (`forgetSample`; undo decodes again).

### What is in memory (`engine/sample-residency.ts`, `engine/residency-plan.ts`)

- Every playlist audio clip needs its sample decoded, reversed when the channel plays backwards, and in `stretch` mode a
  stretched copy of the part it plays. While song mode plays, the buffers of clips overlapping [playhead − 2 s,
  playhead + 30 s] are pinned (the window wraps at the loop end); the clips after it are prefetched in playback
  order, within 5 minutes and only while they fit beside what is already in memory (a prefetch never pushes out
  another engine's buffers); the rest may be evicted, the farthest first (they are touched in reverse order).
  Stopped, nothing is pinned. The plan is made again when the playhead has moved a second, the song changed or a load
  finished (pure planning: `residency-plan.ts`, unit-tested).
- A clip whose sample isn't decoded yet (a jump far into a long mix) waits and starts once it is, at the spot the song
  has reached: never late, never shifted. A clip whose stretched copy isn't ready plays the plain sample in time
  (pitch off) and switches over with a crossfade, as before.
- Offline renders call `Engine.prepareOffline(horizon)` before scheduling each chunk (and `prepareTicks` before the
  transport starts): the chunk's buffers are decoded and stretched, then it is scheduled, so a render never depends on
  timing. `Engine.ready()` waits for the loads the plan started; `measureTail` only waits for plugins (`pluginsReady`).
- Nothing long runs in one go on the main thread while music plays: decoding is the browser's or a Worker's, stretching
  runs in Workers, and reversing, peaks, buffer copies in and out of Workers go a slice (~1.4 s of audio) at a time
  with a MessageChannel yield in between (`engine/audio-buffers.ts`).

### Time-stretching (`core/audio/wsola.ts`, `engine/audio-buffers.ts`, `engine/stretch.worker.ts`)

- Only the clip's source range (`clipSourceRange`) plus a second on each side, on whole seconds (small trims reuse the
  copy), not the whole file. A pool of up to three Workers (cores − 2) takes jobs in playback order. The channels are
  transferred in; the copy comes back as 16-bit PCM (`core/io/pcm16.ts`: planar, with a gain so overs aren't clipped),
  half the bytes of floats, and that is also what is kept on disk: OPFS `derived/` (`platform/derived-store.ts`, 4 GB,
  least recently used first), so a copy is computed once per file, range and tempo and reads back identical (renders
  don't change between sessions). A copy that is on disk doesn't need its sample decoded at all.
- WSOLA is ~4× faster (coarse search on a 6 kHz mono mix, sliding energies, zero-padded arrays without bounds checks)
  and keeps attacks whole: plain WSOLA reads a hit into two overlapping frames at slightly different times when slowing
  down (a doubled click) and moves it by up to the ±12 ms search. Attacks are found where the energy of the next ~10 ms
  jumps 9 dB over the ~20 ms before (`detectOnsets`); around each one the input plays at its own speed (frames that
  continue each other exactly, which overlap-add back to the original samples), centred on the hit's stretched time,
  and the stretch is made up in the gaps (strongest hits first, while each gap stays within 2× of the overall scale).
  Measured on 5 ms clicks every 0.5 s: plain WSOLA doubles them at 1.5× (30 peaks for 20 clicks) and moves them by
  up to 12 ms; now one per click at full level, within 0.1 ms at 1.06–1.5× (2.4 ms at 0.8×); the old pitch and level
  tests still pass. 60 s of stereo: 0.94 s before, 0.19–0.28 s now (Node, one thread); a 5-minute song ~1 s per Worker.
- **Streamed into 16-bit** (`core/audio/stretch-pcm16.ts`, `wsola.ts` `stretchStream`): WSOLA hands its output over
  as it is finished (the overlap-add keeps one frame, 40 ms, per channel; each half frame is final once the next frame
  has been added) and `stretchToPcm16` quantizes it straight into the file's own container, which is allocated once
  at the final size. The mono mix for the similarity search is not kept either: `readMono` makes the window it needs
  from the channels (same float accumulation, so the same values), the onset detector (`detectOnsetsLazy`) and the
  decimated 6 kHz copy read it a block at a time. Before, a Worker held the input, the whole mono mix, the whole
  float output and then the 16-bit copy. The sound is unchanged: the float output is bit for bit what `timeStretch`
  made before (pinned by hashes of four signals in `stretch-pcm16.test.ts`, and checked byte for byte against the
  old code on a 5-minute song at 0.85×, 1.07× and 1.5×). The one thing that differs is the container's gain, which has to
  be in the header before the audio: it comes from the input's peak (WSOLA output is a weighted average of input
  samples, so it never goes higher) instead of the output's own. Identical for anything within full scale; for a
  master that goes over, the gain is the input's peak (a little higher), and decoded samples differ from the old
  file by at most one step of it. Measured in Node 22 (same V8 and typed arrays as the Worker; one process each,
  peak resident set; the 5-minute stereo 48 kHz test song at 124 BPM, 115 MB of input): peak 438 MB before,
  **266 MB after** at 1.07×; 402 → 253 MB at 0.85×; 509 → 289 MB at 1.5×. Above the input (what the Worker adds
  while stretching): 241 MB → 69 MB (the 62 MB result plus kilobytes of window buffers). Time per song unchanged:
  1.31 s before, 1.32–1.37 s after at 1.07× (1.05 s at 0.85×, 1.8–1.9 s at 1.5×).
- A clip at speed 1 (a stretched copy at a constant tempo, or a plain clip) starts on a whole frame at a whole frame
  (≤ 10 µs off): a fractional start made the browser interpolate the whole clip, dulling the highs by up to 6 dB at
  16 kHz, drifting with the phase over a long song.

### Durations from file headers (`core/io/audio-info.ts`)

`readAudioInfo` reads duration, rate and channels from WAV/RF64 (`fmt `, `data` size, clamped to the file), AIFF
(`COMM`), FLAC (STREAMINFO), MP3 (Xing/Info frame count with LAME's encoder delay and padding, VBRI, else every frame
header counted: cheap even for an hour), ADTS AAC (frames counted), M4A/MP4 (the sound track's `mdhd`, else `mvhd`, and
the `mp4a`/`alac` sample entry) and OGG Vorbis/Opus (identification header, last page's granule position). Pure,
unit-tested on tiny synthetic files and in the browser against Chrome's decoder (WAV/FLAC exact, MP3 within two frames).
`probeAudio` uses it and decodes only files it can't describe. Browser click previews are decoded once per content
(keyed by SHA-256) into the shared cache.

### Hour-long exports (`engine/render-offline.ts` `renderStream`, `app/export/*`)

- `renderStream` renders up to ~512 s per window (a fresh engine and OfflineAudioContext each, ~250 MB) and hands the
  audio over a second at a time. Each window starts early by the effects' tail plus 8 s, rounded up to the window
  grid (a warm-up that is thrown away), so reverbs, delays and releases that cross a boundary sound as in one render;
  windows overlap by 0.1 s and crossfade as `a + w·(b − a)`, which leaves identical samples untouched. The transport of a
  later window starts at the tick heard at its first frame, so events land on the same frames as in one render.
- The grid (`windowGrid`): window starts are whole multiples of a power-of-two number of seconds, so they are on the
  128-frame render quantum and their start times are exact binary fractions; at 48/96 kHz also on the 16384-frame
  partitions of the ConvolverNode's longest FFT stage (128/64 s). Measured on a drum loop through Reverb and Delay at
  128 BPM (exact seconds per tick): two windows give the single render **bit for bit**, boundary included (48 kHz
  with 128 s windows; the test uses 32 kHz, where the aligned grid is 64 s, to stay short). At 44.1 kHz (32 s grid,
  convolver partitions not aligned) within −132 dBFS over 75 s and three windows (the shorter test song comes out
  exact).
- Not bit for bit: Chrome sums three or more connections into one node input in an order that depends on memory
  addresses, so such graphs differ by a rounding step even between two plain renders (the test uses two channels).
  Free-running modulation (an LFO's phase) restarts in each window: the seam is the crossfade. Notes held across a
  boundary for longer than the warm-up are not heard after it. Song-mode tempo automation is followed but its event
  times are no longer exact binary fractions.
- The export (`runExport`) trims as the audio comes (`app/export/stream-trim.ts`: the tail after the music is held until
  its end is known, the same cut as `trimRender`), encodes in the Worker a piece at a time (`openEncodeStream`:
  `WavStreamEncoder`, `FlacStreamEncoder` — byte-identical to `encodeWav`/`encodeFlac` however the audio is split, the
  WAV header and STREAMINFO written over the start at the end — and LAME incrementally) and writes to the file handle as
  it goes (`platform/sinks.ts`); without File System Access the parts become one Blob for the download. Normalizing
  renders the mix twice (once for the peak). Stems: each into its file in the folder, or into an OPFS temp file that is
  then copied into a streamed, stored .zip. Progress and cancel work as before.

### Big projects (`core/io/project-file.ts`, `core/io/zip-index.ts`, `app/persistence/project-io.ts`)

Decision: `.agproj` keeps embedding every sample, so a project stays one portable file (references to OPFS blobs would
break when the browser's storage is cleared or the file moves to another computer). Save streams the zip into the file
handle (`writeProjectTo` → `writeProjectFileStream`: fflate's streaming `Zip`, JSON deflated, samples stored), reading
each sample from the store only when it is written and passing it on in 1 MB pieces. Open reads the zip's central
directory from the end of the File and then each sample on its own (`openProjectBlob` → `readProjectFileIndex`), verified
against its hash and stored. A project with hundreds of MB of songs holds one song at a time either way; files written
either way open either way. No zip64: project files stay under 4 GB.

### Measured (Chrome, M-series Mac, headless)

- Songs at 118–128.5 BPM stretched to 126 BPM with 8-bar overlaps, clicks on every beat (`test/browser/dj-long-mix.test.ts`):
  six 60 s songs under a 100 MB budget (~280 MB decoded and stretched) play from two transitions with no late events
  (decoded audio peaks at 128 MB while playing), and the 4.5-minute mix exports (16-bit WAV into an OPFS file) in 8.8 s
  (31× realtime), decoded audio peaking at 108 MB, each song decoded once, every third beat of every song within
  2.5 ms of the grid at full level. Eight 90 s songs under 160 MB: a 10-minute mix in 19 s, peak 193 MB.
- Sixteen 4.5-minute songs, a 66-minute mix (`VITE_LONG_EXPORT=1`), 24-bit WAV: 154 s (26× realtime) including
  stretching all sixteen; decoded audio peaks at 500 MB with a 400 MB budget (1.6 GB with the default 1.5 GB budget,
  which an export is free to fill); page memory (`measureUserAgentSpecificMemory`, Workers included) peaks at 1.8 GB,
  most of it the three stretch Workers' transient buffers (~300 MB each while a 4.5-minute song was stretched; ~160 MB since the
  output is streamed into 16-bit, see above) and
  the cache; the render window is ~250 MB; the 1.1 GB file is never in memory.

### Gaps

- A stretch Worker still holds the whole input (float32, transferred in) while it works: ~115 MB for a 5-minute
  stereo song. Streaming the input in as well would need the onset pass over all of it first.
- While stopped, the residency plans around where song playback last started, not the playlist's song-position marker
  (the engine isn't told it): pressing play far from there decodes on demand (clips start in sync once ready).
- Audio clip channels' channel-rack previews load their sample on demand (the first click waits for the decode).
- The disk copies of stretched clips have their own cap (4 GB) and no UI; `DerivedStore.clear()` exists for one.
- OPFS in a fresh headless profile refuses single files near 1 GB, so the 64-minute test writes into a counting sink;
  stems of a 90-minute mix into a .zip go through OPFS temp files of that size.

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

## Effects (M14)

Fourteen new built-in effects, all SDK worklet kernels (`src/plugins/builtin/<name>/`: `params.ts`, a pure `kernel.ts`
with Node tests, `<name>.worklet.ts`, `index.ts` with presets), plus a tempo pump for the Ducker. Every param has a
label, a unit where one applies, a hint and a group; every enum option has a label; every effect has a one-sentence
description and five or more descriptive presets, so the AI catalog (`app/ai/catalog.ts`) describes them well.

| Effect (id) | What it does | Latency |
|---|---|---|
| EQ Pro (`agstudio.eq-pro`) | 8 bands (bell, shelves, 12/24/48 dB/oct cuts, notch) of SDK Svf sections designed by `design.kernel.ts`, which the editor also draws from; bands crossfade when switched; all off = bit-exact | 0 |
| Limiter (`agstudio.limiter`) | look-ahead brickwall: detector (true peak 4× or sample peak, same timing) → sliding minimum over look-ahead + detector span → release → box filter as long as the look-ahead; the delayed audio × that gain cannot exceed the ceiling | 5 ms + 14 frames |
| Multiband (`agstudio.multiband`) | Linkwitz-Riley 3-way (low band through the upper allpass: sums flat), a compressor per band (evaluated every 4 frames on the peak, gain ramped), solo/bypass | 0 |
| Transient Shaper (`agstudio.transient`) | fast/slow attack and fast/slow release envelope pairs → attack and sustain gains in dB | 0 |
| Saturator (`agstudio.saturator`) | tape/tube/clip at 2× or 4× (SDK Oversampler); dry/wet mixed in the oversampled domain; tilt EQ | 0 |
| Chorus, Flanger, Phaser | modulated delay lines / allpass chains; `PhaseClock` follows the song when synced and free-runs when stopped; control-rate targets ramped, delay changes slew-limited so a jumping synced LFO glides | 0 |
| Stereo (`agstudio.stereo`) | M/S width, mono bass (LR4 high-pass on the side + matching allpass on the mid), Haas widener, balance, phase flips; defaults bit-exact | 0 |
| Lo-Fi (`agstudio.lofi`) | wow/flutter delay line, sample-and-hold, mid-tread bits, tone, seeded hiss and crackle | 8 ms |
| Stutter (`agstudio.stutter`) | gate patterns, beat repeat (slice from the grid line, the played part from an 8 s history), tape stop; acts only while the song plays | 0 |
| Vocoder (`agstudio.vocoder`, sidechain) | 16/24/32 two-stage SVF bands on modulator (the sidechain) and carrier (the input), state in flat arrays | 0 |
| Tune (`agstudio.tune`) | YIN → nearest scale note (hysteresis) → glide → pitch-synchronous splicer (a second head a whole number of periods away, 4 ms crossfade); rests at its centre delay when nothing needs correcting | 12 ms |
| Analyzer (`agstudio.analyzer`) | pass-through; measures BS.1770 loudness, true peak and correlation exactly in the kernel and publishes them; listen modes | 0 |
| De-esser (`agstudio.de-esser`), Doubler (`agstudio.doubler`) | see "Vocal chains" below: a split-band de-esser with listen and a gain-reduction meter; a pitch-drifting vocal doubler with a clean mono sum | 0 |
| Ducker (`agstudio.ducker`) | new `mode` (`sidechain` / `tempo`) and `rate`: in tempo mode every grid line of the song is a hit, the release fits in one step | 0 |

Latencies are whole frames at every sample rate (`latency: (sr) => frames(sr) / sr`, the kernel using the same
function), and each latent effect reads its dry signal for the mix at the same delay, so delay compensation and the
slot's dry path line up exactly (`test/browser/effects.test.ts` checks the Limiter against a dry parallel path).

### Visualization taps

- SDK: `PluginHost.tap?(node, options) → PluginTap` (`publish(readings)`), `PluginUIProps.tap?: AudioTap`
  (`active`, `sampleRate`, `fftSize`, `spectrum(out)`, `waveform(out, channel)`, `reading(name)`), `tap: true | options`
  in `defineWorkletEffect`/`defineWorkletInstrument` (taps the processor's output and turns kernel posts
  `{ readings }` into readings; `Readings` in `@agstudio/sdk/worklet` posts them at ~30 Hz), and `useFrame(draw)` /
  `FrameContext` in `@agstudio/sdk/ui`.
- Engine: `HostImpl.tap()` makes an `engine/tap.ts` `TapImpl` (an AnalyserNode on the node for the spectrum; a splitter
  and two analysers for waveforms, created on the first `waveform()` call) and reports it through `HostDeps.reportTap`
  → `EngineCore.reportTap` → `EngineOptions.onPluginTap(owner, tap, live)` (additive, optional; `EngineApi` is
  unchanged). Offline hosts return a no-op tap. The tap is disposed with the host.
- App: `services.taps` (`app/taps.ts`) keeps the live tap per owner and hands out a stable `view(owner)`, so an editor
  keeps drawing across instance swaps (hot reload, engine reboot) without re-rendering; a replaced instance's removal
  only clears its own tap. `PluginWindow` passes `tap` in the UI props and provides the app's frame loop as
  `FrameContext`.
- `getFloatFrequencyData` reads a full-scale sine at 20·log10(0.42 / 2) ≈ −13.6 dB (Blackman window, 1/N scaling);
  `TapImpl.spectrum` adds that back, so a full-scale sine reads 0 dBFS in its bin (`test/browser/taps.test.ts`).
- Editors: a 2-D drag (EQ Pro handles move frequency and gain) is one undo step: `usePluginEditing.setParam` joins the
  gesture in progress for a param without its own (`ui/plugin-hooks.ts`).

### Shared DSP and test helpers (`src/sdk/dsp`, `src/sdk/testing.ts`)

`Halfband`/`Oversampler` (HIIR-style polyphase allpass halfbands: 9 coefficients at 100 dB / 0.04 transition for the
first 2× stage, 4 for the second), `LinkwitzRiley`, `Yin` (real-time, decimated to ≥ 8 kHz, parabolic interpolation
on the raw difference), `TruePeak` (65-tap Kaiser-windowed sinc, phase 0 is the sample itself), `KWeighting`/
`LoudnessMeter` (analog-prototype K-weighting matching BS.1770's 48 kHz coefficients to 1e-8; integrated loudness from
a 0.05 LU histogram of 400 ms blocks; `resetIntegrated()` waits for a block of new audio), `PhaseClock` and the
`SYNC_*`/`NOTE_*` tables, and `Readings`. `@agstudio/sdk/testing` (`runEffect`, `runInstrument`, `testHost`,
`testTransport`, `paramBlock`) runs kernels in Node; every M14 kernel test uses it. Unit tests: halfbands reject images
and aliases by > 90 dB, crossovers sum flat (to 1e-12 for the impulse response), YIN within 0.3 %, a −20 dBFS 1 kHz sine
reads −23 LUFS on one channel (−20 on two), true peak of a quarter-rate sine at ±45° within 0.1 dB.

### Measured (headless Chrome, M-series Mac)

- Cost per instance at 48 kHz (share of one core, best of three 2 s runs, busiest preset): Stutter 0.07 %, Ducker
  0.09 %, Transient 0.15 %, Stereo 0.15 %, Phaser 0.18 %, Flanger 0.19 %, Chorus 0.23 %, Lo-Fi 0.31 %, EQ Pro 0.34 %,
  Tune 0.37 %, Multiband 0.38 %, Limiter 0.42 %, Saturator 0.47 % (4×), Analyzer 0.59 %, Vocoder 0.72 % (32 bands). A busy
  machine reads up to about twice that; the test allows 1.5 % (5 % for Tune, Vocoder, Analyzer).
- The Limiter delays quiet audio bit-exactly by its latency, never lets a sample past the ceiling (noise, sines up to
  19 kHz, squares, impulse trains at +24 dB) and, with True peak on, keeps the true peak under it too (the target sits
  0.05 dB under the ceiling: where a deeper gain ramp begins next to a peak, the reconstruction can move by a hair).
- Tune: 446 Hz corrected to 440 Hz within 3 cents; a 90-cent correction within 3 cents at a level steady to 1 dB.

### Not done / fragile

- The mixer's "Sidechain to this track" offers a Ducker or Compressor; the Vocoder (and Gate) could join that list
  (`ui/features/mixer/routing.ts`, left alone here).
- Editors: only EQ Pro and the Analyzer have custom UIs; the Limiter, Multiband and Tune publish readings (gain
  reduction, detected pitch) that no editor shows yet.
- Tune is monophonic; polyphonic or very breathy input makes YIN unvoiced and the correction lets go. Its formant
  moves with the pitch (no formant preservation).
- Beat repeat holds slices up to 2 s (a 1/2 note down to 60 BPM); Stutter's history is 8 s.
- Tap readings arrive at ~30 Hz through the worklet port; the spectrum/waveform come from AnalyserNodes, so they are
  snapshots, not every sample (the Analyzer's loudness and peak are measured in the kernel for that reason).

## Vocal chains: De-esser, Doubler, chain presets, the Vocals bus

**De-esser** (`agstudio.de-esser`, `plugins/builtin/de-esser`, zero latency). A band-pass at the sibilance frequency
(3–12 kHz, Q 0.5–6; two cascaded SDK `Svf` stages for the detector, so a 1 kHz vowel is 40 dB down in it) feeds a
stereo-linked peak envelope, the static curve (threshold, ratio, range cap, a 4 dB soft knee, `deEssReduction`) and an
attack/release smoother on the reduction in dB. **Split band** subtracts the first stage's band from the voice,
`out = x − (1 − g)·band(x)`, which is an analog-style bell cut: with no reduction the output is the input bit for bit,
and only the band moves. **Wideband** multiplies the whole voice by `g`. **Listen** outputs the detector's band. The gain
reduction is a meter (`Readings`, `kind: 'reduction'`, max 20 dB). Presets: Gentle, Bright vocal, Harsh S's, Podcast voice
(wideband), Deep voice, Tame bright cymbals. Measured (kernel tests): a 7 kHz burst at −12 dBFS is 10.0 dB down at the defaults (≥ 6 dB asserted), a 1 kHz
tone at any level and in every preset stays within 0.2 dB (and bit-exact below the threshold), the vowel under a hiss is
within 0.5 dB in split mode and 6 dB down in wideband, the meter reads 10 dB on the burst and 0 after it.

**Doubler** (`agstudio.doubler`, `plugins/builtin/doubler`). The input is summed to mono, rolled off (Brightness) and
written to one delay line; two to four voices read it at their own delay (Delay × a timing pattern, blended with Timing
spread) that wanders with two sines per voice (0.43–1.03 Hz and 1.71× that), each scaled so the pitch error, which is
the speed of the delay change, peaks at the Pitch drift in cents (0–15). Voices are panned with an equal-power law
scaled by Width (the original stays in the middle) and scaled by 1/√voices at the Double level. Adding or dropping a
voice fades it over one control step (32 frames). Presets: Tight double, Wide pop, Rap ad-lib, Subtle thickener, Backing
vocal stack. Measured: drift 8 ct
stays between 3.2 and 8.8 ct at the output (zero-crossing estimates, asserted), mono sum of noise within −0.5…+2 dB of the voice and no
sixth-octave band of the mono sum more than 5 dB down or up, in every preset (in practice 0.1 dB and well inside).

**Both** have kernel tests in Node (`kernel.test.ts`: behaviour, determinism, finite at the extremes) and are in
`test/helpers/builtin-kernels.ts` (the plugin sweep: presets valid, bounded at every extreme, silent after the input
stops, tails covered, and `npm run bench:plugins`). `test/unit/process-allocation.test.ts` reads each kernel's source and
refuses anything that allocates in `process()` (`new`, array and object literals, closures, template strings, spreads,
array methods): measuring the heap can't tell that from the number boxes V8 makes for a double a call returns.
`npm run bench:plugins -- --only de-esser,doubler`: de-esser 0.27–0.48 %, doubler 0.16–0.32 % of one core (the low end on a
quiet machine, the preset extremes and a busy machine at the high end). The benchmark builds again (rolldown needed `codeSplitting: false` for plugins with a lazy editor).

**Chain presets** (`app/chains.ts`, `app/mix/vocal-chains.ts`, `app/actions/chains.ts`).
- `ChainStep extends FxRecipe` (plugin id, preset name, params on top, label) with `mix` (the slot's dry/wet), `enabled`,
  `state`, `version` (a step saved from an insert holds every param at that plugin version; `presetValues` upgrades it with
  the plugin's `migrate`) and `send: { to: 'reverb' | 'delay', db }`. A `ChainPreset` is a name, a sentence and steps (≤ 20).
- `applyChainToDraft(d, s, insertId, chain, 'replace' | 'append')`: replace removes the insert's effects first; each step
  becomes an effect slot (the plugin's preset, then params, mix, bypass) or, for a send step where the project has a
  Reverb or Delay return bus (found by name, as the mix setup does) other than the insert itself, a post-fader route at
  `db` and no effect. Without the return a send step is an insert effect with the same preset and its own `mix` (light:
  ≤ 0.25). What doesn't fit the ten slots, isn't installed, or would loop is skipped and reported, never half-applied.
  `applyChain` is one `history.transact('Chain: <name>')`, names the plugins' presets in their preset bars where a step is
  the preset itself, and toasts what it did. The UI asks once, with a plain choice ("Replace them" / "Add after them"), only
  when the insert already has effects (`putChainOn`).
- Factory chains (`FACTORY_CHAINS`): Clean pop vocal, Rap vocal, Airy ballad, Lo-fi vocal, Trap auto-tune vocal (Tune
  instant, in the song's key when it has one (set, or found from the notes), else A minor), Podcast voice (gate, EQ, compressor, wideband de-esser, limiter), built from
  EQ Pro, Tune, Compressor, De-esser, Saturator, Doubler, Lo-Fi, Gate, Limiter and Reverb/Delay sends.
- Your chains: `chainFromInsert` (every effect with all settings, state, mix and bypass; sidechains are not kept),
  "Save this track's chain…" in the mixer strip's right-click menu (Effect chains ▸) and as `mixer.saveInsertChain`.
  `.agchain` files are JSON (`format: "agstudio-chain"`); `readChainFile` validates every field and says what is wrong in
  plain words, and needs every plugin installed. Import: Chains section and `mixer.importChain`.
- UI: a **Chains** section in the browser right under Presets (click = put it on the mixer track selected there, the master
  when none is; right-click: replace/add after/export/rename/delete; "Save … chain…", "Import a chain file…"), the
  mixer strip menu, and Add ▸ "Effect chain on the selected track" (so Mod+K finds every chain). Command
  `mixer.applyChain { chain, mode?, insert? }`.
- AI/MCP: `add_chain { insert, chain, mode: replace | append }` and `save_chain { insert, name }` actions (a chain made
  of sends to returns the same answer created works: the draft is searched by name), a "chains" prompt section, the chains
  (name, sentence, effects in order, which are sends) in the plugin catalog (`catalog.ts`), and the read tool
  `get_chains` (also an MCP tool).
- Loudness (`test/browser/vocal-chains.test.ts`, headless Chrome, a synthetic sung phrase from
  `test/helpers/voice.ts`: a formant vowel with vibrato and an "s", peak −10.5 dBFS, −18.2 LUFS): every chain keeps its
  loudness within 0.3 dB on a natural voice (inserts and sends to returns) and within 1.3 dB on one with a harsh "s" as
  loud as the vowel (the de-esser rightly takes that down); the makeup of each chain's Compressor is what calibrates it.
  `npm run bench:plugins -- --chains` measures a chain's CPU, the worklet effects in series (3.5–5.4 % of one core).

## Audio recording, editing and export (M15)

### Playing audio clips (`core/audio/playback.ts`, `envelope.ts`, `engine/clip-player.ts`)

- One mapping from song ticks to seconds into the (reversed, when reverse is on) sample, shared by the engine, the
  waveform, trims, splits, normalize and slicing. With P = 2^(pitch/1200) and B = the channel's `sourceBpm`:
  `off` plays at P × its own speed (a resample: pitch changes speed), `resample` at P · bpm(t)/B (locked to beats,
  pitch follows the tempo, like a turntable), `stretch` at bpm(t)/B with the pitch kept at P (time-stretched). Resample
  and stretch need a source BPM (without one a channel plays `off`). `offsetSec` (the trim) is a position in the played
  copy, so reversing mirrors every clip's trim (`mirroredOffset`) and it keeps playing the same audio.
- The envelope is clip gain × equal-power fades (sin, −3 dB at the middle; overlapping fades multiply), played as
  linear ramps between 16 breakpoints per fade (within 0.2 %). A voice that starts inside the sound ramps in from
  silence over 2 ms; one that starts at the sound's first sample doesn't (frozen and consolidated renders keep their
  attack). Releases fade over 4 ms; `cancelAndHoldAtTime` alone inserts no hold point when the last ramp has finished,
  so the release would ramp from that old point and fade the whole clip: the held value is set explicitly (this was a
  bug before M15).
- Tempo following: playback-rate changes are scheduled at every tempo change of the clip's run (k-rate: within one
  render quantum). Stretch plays a WSOLA copy of the part of the sample the clip plays (`core/audio/wsola.ts`, in a
  pool of Workers, `engine/audio-buffers.ts`; per clip, sample and scale, scale = P / (bpm at the clip start / B),
  kept in the sample cache and on disk: see [Long audio](#long-audio-dj-mode-foundations)), at speed scale · bpm(t)/B, so tempo
  automation inside a stretched clip bends its pitch slightly; until the copy is ready the plain sample plays in time
  (pitch off), then voices switch over 30 ms later with a short crossfade. The engine plans what every clip needs on
  each edit (`engine/sample-residency.ts`); offline renders make each chunk's samples and stretches ready before
  scheduling it, so exports are deterministic. Playing clips restart when their channel's playback key (sample, pitch, reverse, follow, source
  BPM) changes, and tempo-following clips when the tempo map does. `EngineApi.isStretching(channelId)` drives
  "Stretching…".
- WSOLA: 40 ms Hann frames, 50 % overlap, ±12 ms search for the best continuation of the previous frame, coarse on a
  ~6 kHz mono mix then refined at the full rate, the same positions for every channel; attacks are kept whole and on
  their stretched time (see [Long audio](#long-audio-dj-mode-foundations)). ~0.2 s for 60 s of stereo in Node.

### Editing audio clips (`ui/features/playlist/audio-clip.ts`, `ui/features/audio-clips`, `app/actions/audio-clips.ts`)

- The waveform is drawn through the playback mapping and scaled by the envelope; the fade curves are drawn on it.
  Handles along the top of the body: fade-in and fade-out squares (drag; hint in ms), the gain bar (drag up/down,
  0.2 dB per px, Shift fine; hint in dB); double-click resets. Each drag previews and commits one undo step. The
  title lists how it plays ("Stretch 90→128 BPM", "Stretching…", "Reversed", "+3 st", "−6.0 dB", "Frozen").
- Channel-level edits (reverse, pitch, follow tempo, source BPM) resize clips that played the whole rest of the sound
  (`naturalLength`) and mirror trims on reverse. Normalize reads the played range of the decoded sample
  (`EngineApi.sampleData`) and sets the clip gain for a −0.3 dBFS peak. Slice at transients: spectral flux on
  log magnitudes, an adaptive threshold, a loudness gate set by the sensitivity, each hit moved to just before its
  attack (`core/audio/transients.ts`), then `splitClip` (which maps through the playback mode). Source tempo detection:
  onset autocorrelation preferring 80–160 BPM, snapped to the loop length when it is whole bars, nothing for one-shots.
- Consolidate / Freeze (`app/actions/render-to-audio.ts`): offline renders without the master chain and the safety
  limiter (the new clip plays through them), stored as 24-bit FLAC. A render louder than full scale is stored turned
  down with the clip gain turning it back up: Chrome's decodeAudioData clamps even float WAV to ±1. Freeze renders the
  channel alone into the master (its sound before its mixer track), adds an audio clip channel on the same track with
  `frozenFrom`, and mutes the original; Unfreeze deletes it and unmutes. Measured: a frozen kick through an EQ'd track
  matches the original to −50 dB; the difference is where the sample ends, because Chrome stops a BiquadFilterNode's
  processing when its input goes silent while the frozen clip keeps feeding it zeros.

### Recording audio (`engine/input-recorder.worklet.ts`, `engine/audio-input.ts`, `app/audio-input.ts`, `app/audio-recorder.ts`)

- Capture: a worklet writes the input (mono or stereo through an explicit channel count) into a 30 s
  SharedArrayBuffer ring on the context clock (an input stall becomes silence, so timing holds) and each block's peak
  for the meter; the main thread drains it every 50 ms into chunks (a stall longer than the ring is filled with silence
  and reported). Takes have no length limit but memory. Monitoring connects the stream to a mixer track's input.
- Latency: music scheduled at τ is heard at τ + delay compensation + output latency and recorded back after the input
  latency. The recorder maps a captured frame at context time F to `engine.tickAt(F − roundTrip)` (tickAt takes the
  delay compensation off). The round trip is the calibrated value (8 clicks on the monitor bus recorded back,
  `core/audio/latency.ts`, median; trusted when ≥ 60 % come back within 8 ms) or the estimate (base + output latency +
  the master limiter's 1.3 ms + `MediaTrackSettings.latency`), plus a manual correction (prefs).
- Takes (`core/audio/takes.ts`): every 50 ms the recorder notes an anchor (frame, tick heard, loop pass). On stop the
  whole capture becomes one sample and an audio clip channel on the input's mixer track (volume 1, as monitored), and
  each loop pass becomes a clip trimmed into it at the pass's first frame (the count-in before the record start is
  kept in the sample: drag the clip's left edge to reveal it). One pass is one plain clip. Several passes become a
  **take group** (below). Arming with audio on switches to song mode, opens the input and makes song mode without a
  loop region play past the end (`EngineApi.setSongOpenEnded`) so a take never wraps. One undo step per recording.
- Punch range (`view.punch`, separate from the loop region; set from the ruler's right-click menu, Alt-drag on the
  ruler, `record.punchIn/punchOut/punchRange`; saved in `view.json`): `planTakes` cuts every pass to it. With no loop
  region the recorder finishes the take when the heard tick passes the punch-out (the song plays on) and the saved
  sample keeps only the takes' part plus a second of handle either side (`trimToTakes`: the bars before the punch-in
  are not stored). `transport.recordPunch` arms audio, goes to song mode and plays from `preRollBars` bars before the
  punch-in (a pref, 0–4), after the count-in. Measured with a loopback stream in the engine's own context
  (`test/browser/audio-punch.test.ts`): the clip starts exactly on the punch-in tick, is the length of the range, holds
  none of the earlier bars' hits, and a hit played on a beat inside the range lands 0.01–4.7 ms off it (limit 12 ms;
  the loopback's own delay moves between captures).

### Takes and comping (`core/audio/comp.ts`, `core/ops/comp.ts`, `core/query/takes.ts`, `app/actions/comp.ts`, `ui/features/takes`)

- **Take group**: the takes of one recording are tied by `AudioClip.take = { group, index }` (index = pass order, 0
  first; a clip of the comp lane also has `comp: true` and the index of the take it plays) and by `Lane.takes =
  { group, role: 'comp' | 'take', crossfadeMs? }`. Nothing else is stored: `takeGroups(project)` derives the groups
  (memoized by the lanes and clips records). Recording N > 1 passes makes N + 1 tracks: the comp track, then the take
  tracks (newest take first), the takes muted, the comp starting as the newest full pass (`addTakeGroup`). Tracks of a
  group are never free for other recordings (`laneFree`), and `addClips` drops a `take` tag (a copy or a new clip is
  not part of a group). `migrate.ts` (`repairTakes`) drops damaged tags and releases a group with no comp track or no
  takes into ordinary tracks and clips.
- **The comp is ordinary audio clips** on the comp track, split at the comp's borders; playback, export, freeze and
  consolidate need nothing new. `planComp(segments, spans)` turns "take k plays from a to b" into clips: at a border
  the earlier clip runs `h` ticks past it and the later one starts `h` ticks before it (10 ms in all by default, 0–500
  per comp), each with a fade the length of the overlap, so the clips' own equal-power envelope (`envelope.ts`: sin
  against cos) is the crossfade. Borders are symmetric, so `readComp` finds the same segments again from the clips
  (a comp edited many times does not drift). The crossfade cannot reach past a take's audio or half a neighbouring
  segment; where it cannot, a short dip fades instead of a click; a comp that starts inside a take or leaves a gap
  fades in and out over at most one crossfade length; a clip that was split and continues in its sample is joined
  without fades. Every edit rebuilds the comp lane (`setComp`: old comp clips out, new ones in), so one
  `history.transact` undoes it exactly.
- **Edits** (`app/actions/comp.ts`, all one undo step, also commands with hints and `argsHint`): swipe a part of a take
  (the playlist's Comp tool `T`, or Alt-drag on a take with any tool: `chooseTake` with a range), Use this take
  (`comp.useTake`, the whole take, or `from_bar`–`to_bar` of it), Next / Previous take (`[` `]`, the clip under the
  pointer or the selection: `stepTake` goes round among the takes that have audio in the range), crossfade
  (`comp.crossfade`), Flatten (the comp stays as clips, the take lanes and takes go; with merge the comp is also
  rendered into one clip through `consolidate`, amended into the same undo step), open / fold the stack
  (`comp.toggleTakes`, `editor.openTakes`: view state, not undoable).
- **The playlist** shows the stack folded or open: the controller draws `visibleLaneOrder(project, openTakes)` (take
  lanes of folded groups take no row), the comp track's header has a ▸ / ▾ toggle (also in the track's and the clips'
  menus), take lanes are indented with an accent rule, and each take's used parts are lit by `drawTakeUse` over the
  clips layer (the same imperative, panned canvas layers as the rest: no React per frame). A swipe previews as a band on
  the take and on the comp track.
- **The AI and MCP**: `record` (arm, disarm, start, stop, set_punch, clear_punch, count-in, pre-roll; it acts on the app
  after the edit, `recordingAfter`) and `comp` (use_take, promote, next, previous, crossfade, flatten; a doc action in
  `app/ai/ops/recording.ts`), and the `get_takes` read (groups, take clip ids, what the comp plays where in bars,
  punch range, record settings).
- **Hum to notes and the Studio's performance recorder** open the microphone with the device and channel count chosen in
  Options › Audio input, and compensate with the calibrated round trip (`AudioInputService.performanceLatency`: a
  measured value replaces the output + input estimate through `RecordOptions.roundTrip`).
- Measured (`test/browser/comp-crossfade.test.ts`, offline render, two takes of a 440 Hz tone a rad or two apart in
  phase cut at a border): the output is the clips' own audio times their fades to within 0.01, the largest
  sample-to-sample step within 0.1 s of the border is 0.029 (the tone's own steepest step is 0.029) and the level
  across the border stays above 0.2 RMS (the tone is 0.35). The engine's own 2 ms / 4 ms start and release ramps
  already stop a hard cut from clicking (a 0 ms crossfade measures 0.033), so the crossfade's job is to keep the level
  and the sound continuous rather than to remove a click.
- Not done / fragile: comp clips lose a hand-made clip gain or fade when the comp is rebuilt (they follow the take
  clip's own); moving or resizing a take clip does not rebuild the comp; Freeze and consolidate keep off these tracks
  (`laneFree`) but the arranger, automation and dropping a file onto one can still put a clip there; auditioning a single
  take means unmuting its clip (Use this take and play); the comp cannot span takes of different recordings.

- Record mode records what the chip next to the record button says: recorders have a kind (`notes`, the default, or
  `audio`) and the prefs `recordNotes` / `recordAudio` choose. Browsers ask for microphone permission on the first
  getUserMedia, which needs a click: the commands that open the input are `gesture` commands.
- Measured with a loopback stream in the engine's own context: after calibrating the loopback, a hit played on a beat
  lands within 12 ms of it (the loopback's own delay moves by 3–6 ms between captures).

### Export (`app/export/audio-export.ts`, `encode.ts`, `core/io/flac.ts`, `core/query/stems.ts`)

- WAV (16-bit dithered, 24, 32 float), FLAC (our encoder: fixed and LPC subframes, partitioned Rice residuals,
  stereo decorrelation, the MD5 in STREAMINFO; 16 and 24 bits; decodes bit-exactly in Chrome and with macOS
  afconvert) and MP3 (LAME via `@breezystack/lamejs`, 128–320 kbps, 44.1/48 kHz), all encoded in a Worker a piece at
  a time as the render streams in and written to the file as it goes (see [Long audio](#long-audio-dj-mode-foundations))
  (`encode.worker.ts`; LAME loads only there). Chrome maps 16-bit integers to floats asymmetrically (positive
  × 1/32767, negative / 32768): the FLAC browser test compares against exactly that.
- **MP3 is gapless** (`core/io/mp3-gapless.ts`, `app/export/mp3.ts`). lamejs writes no Xing/LAME header, so a decoder
  can't tell that the first 576 + 529 samples it makes are encoder and decoder delay: the file decoded about 25 ms late
  and 25–35 ms long next to the WAV. Every MP3 now starts with a silent Layer III frame at the stream's bit rate,
  sample rate and channel mode that carries `Info` (constant bit rate), the frame count (not counting itself), the
  file's bytes, a linear table of contents, and LAME's extension: version string (`LAME3.98 `), encoder delay 576,
  encoder padding = frames × 1152 − samples − 576 (so delay + samples + padding fills the frames), the music length,
  the CRC-16 of the audio frames and the tag's own CRC. The streaming encoder writes it **first with zero counts**
  (`PieceEncoder.header()`, a valid file as it stands: a cancelled or crashed export still plays) and `finalHeader()`
  after `finish()` is the same frame, same size, with the real counts, written over the start like the WAV and FLAC
  headers (`ByteSink.writeAt`: `FileSystemWritableFileStream` `write({position})` then `seek` back; the memory sink
  patches its parts). All our sinks can write over earlier bytes, so there is no "compute it up front" path; a
  sink that couldn't would have to know the frame count in advance, which depends on LAME's flush, not on the input.
  `Mp3StreamCounter` counts frames, bytes and the CRC from the encoder's own output, however the pieces cut it.
  Below ~64 kbps the frame is too small for the tag (the dialog offers 128–320) and no header is written.
  Measured in Chrome (`test/browser/audio-export.test.ts`, the drum song, 192 kbps, 44.1 and 48 kHz): **Chrome's
  `decodeAudioData` honours the LAME tag** (it is ffmpeg). The first transient is within 0.1 ms of the WAV's, the
  cross-correlation lag is 0 frames and the decoded lengths are equal; the same stream without its Info frame is
  23–25 ms late (onset +25–27 ms) and 26–35 ms long. `readAudioInfo` reads the header, so our own MP3s now report an
  exact length. Other players that read the tag (ffmpeg, foobar2000, iTunes, VLC) behave the same; players that don't
  play one silent frame (≈ 26 ms) first.
- Stems: one per mixer track with sound playing into it in the range, plus "Master" for channels that play straight
  into it. A stem renders the song with only that track's channels heard, through everything downstream of it:
  other tracks are muted with their insert mute (after the sidechain tap, so a muted kick still ducks the bass), and a
  bus downstream of the stem mutes only its own channels. The mix is rendered first for the common length; every stem
  gets the same tail, start (pre-roll and delay compensation trimmed) and length. With "through the master track" off
  the master's effects are bypassed, its fader and pan neutral and the safety limiter left out, so linear stems add
  up to the master's input exactly (measured within 1e-4). Into a folder (directory picker) or one .zip (stored).
- Normalize: one gain so the loudest moment peaks at −0.3 dBFS (stems all by the mix's gain, so they still add up).
  `file.exportAudioNow` exports straight away with settings from its args (for the AI; asks where to save first).

### Importing FL Studio projects

`core/io/flp.ts` (reader), `core/io/flp-import.ts` (mapper + report text), `core/io/flp-package.ts` (zipped loop
packages), `app/actions/flp-import.ts` (samples, opening), `ui/features/fl-import` (File menu, drops, report dialog).

- **Format.** FL's `.flp` is undocumented. The ids and record layouts come from two open-source readers checked
  against real files: PyFLP (github.com/demberto/PyFLP: `_events.py`, `project.py`, `channel.py`, `pattern.py`,
  `arrangement.py`, `mixer.py`, `timemarker.py`, `plugin.py`) and Monad's FLParser (github.com/monadgroup/FLParser:
  `ProjectParser.cs`, `Enums.cs`), plus flpkit's notes (playlist record sizes 32/60/80/88; automation x in beats).
  Chunk `FLhd` (u32 6: i16 format, u16 channels, u16 PPQ), chunk `FLdt` (u32 length) of events: id < 64 one byte,
  < 128 two, < 192 four (little endian), else a LEB128 length + data. Text is UTF-16LE from FL 11.5 (decided by the
  version event 199, always ASCII), single-byte before. Unknown events are skipped; a cut-off or damaged stream
  imports what was read (with a warning); only a missing/invalid header or no data at all is an `FlpError`. Caps on
  bytes, channels, patterns, notes, items, inserts and points; fast-check fuzzes random and mutated files.
- **Reading is a state machine**: "new channel" (64), "new pattern" (65, appears twice per pattern), "new
  arrangement" (99) and the mixer events select what later events describe. The plugin events (colour 128, internal
  name 201, name 203, data 213) belong to the current channel until one repeats for it or a mixer event appears; then
  they describe the current mixer slot, which `SlotIndex` (98) closes. An insert ends at its Output event (147, PyFLP)
  or, in files without those, at its next routing event (235, FLParser). Mixer volume/pan/sends come from the global
  params event (225: 12-byte items, insert = bits 6–12, slot = bits 0–5 of the channel word).
- **Units.** Ticks are rescaled from the header PPQ to 960. Note records (24 bytes): position, flags (slide = bit 3),
  rack channel, length, key (60 = C5 = our 60), fine 0–240 around 120 (read as ±1 semitone; assumed), release 0–128,
  pan 0–128 (64 centre), velocity 0–128. Channel volume 0–12800 → /12800 (default 10000 ≈ our 0.78), pan 0–12800
  around 6400, pitch in cents. Insert volume 0–16000 with 12800 = 0 dB: that is our fader taper's position (0 dB at
  80 %), so gain = `faderToGain(v / 16000)`. Playlist items: pattern items have index > 20480 (pattern = index −
  20480), others are channel items (audio or automation clips); tracks are stored reversed (499 − n from FL 12.9.1,
  198 − n before); muted = flag 0x2000; offsets are int ticks for patterns (or float32, read as ticks) and float32
  beats for channel items; −1 = none. Time markers: position & 0x07FFFFFF, kind = value >> 27 (1 = time signature).
- **Mapping.** A new project (`createEmptyProject`), built in one pass, then `repairProject`. Channels keep order,
  name, colour, levels, pitch, root key, mute and target insert. Samplers get their sample; a sampler that is only on
  the playlist and has no notes becomes an audio clip channel (FL's audio clips are samplers). Layers dissolve into
  their children (who get the layer's notes). Automation channels keep their points (x in beats → ticks) and clips;
  the target comes from the automation-link records (event 227) only for channel volume/pan (params 0/1, assumed),
  otherwise it is `null` and reported. Generators get a built-in by name first (`808` → 808 Bass, a single drum name
  → Sampler with that kit sound, drum words → Drum Pads), then by plugin (3x Osc → 3x Osc, FL Keys → 3x Osc keys,
  FPC → Drum Pads, DrumSynth/Drumaxx → Drum Synth, Sytrus/DX10/Toxic → FM, Plucked!/Sakura → Pluck, Slicex → Slicer),
  VSTs by their own name (from the wrapper data: records u32 id, u64 size; 54 = name), everything else Wavetable.
  Stand-ins say so in the channel name ("Lead (stand-in for Serum)"). FL plugin settings are not read. Effects map
  only where obvious (Fruity Limiter, Parametric EQ 2, Reeverb 2, Delay 3, Compressor, Chorus…; VST effects by
  keywords such as "verb" or "comp"); the rest are skipped and reported. Only the open arrangement is imported.
  FL pattern clips don't loop their content, so a pattern gets an explicit length when a clip reaches past it.
  Mixer routing comes from the routing flags (+ send levels) unless no insert uses them, then everything goes to the
  master; edges that would make a cycle are dropped. The insert "enabled" flag only mutes when the file uses it.
- **Samples.** An `.flp` only names sample paths on the computer that made it. A zipped loop package (FL: File >
  Export > Zipped loop package) carries them: matched by file name (case-insensitive, then by stem), decoded
  (`probeAudio`) and stored like any imported audio (`importSampleBytes`). Missing ones still get a `SampleRef`
  named after the file, with a hash of a label instead of audio, so the channel and its clips stay and play silence
  (the same "missing sample" state as an opened project whose audio is gone); File > Find missing samples… (or
  dropping a zip without a project) fills them from files or zips by file name, swapping the sample id everywhere
  in one undo step. The ref persists, so this also works after save and reload.
- **Opening.** The import opens like a file: unsaved-changes question, `files.replace(…, { dirty: true })` (empty
  undo history, title "● <name>", no file handle, so Save asks where), song mode when the playlist has clips. A
  dialog lists what came across and what didn't (VST stand-ins, missing samples, skipped effects, other
  arrangements, untargeted automation, slide notes). The AI uses the same `file.importFlp` and
  `file.findMissingSamples` commands (gesture: the musician confirms the file chooser).
- **Still to validate against FL's own output** (the tests use a writer built from the same docs,
  `test/helpers/flp.ts`): the insert boundary event, slot order, the fine-pitch scale, the automation target params,
  pattern offsets as floats, and markers' high bits.

### Playlist markers (`ui/features/markers`, `app/actions/markers.ts`, `core/ops/markers.ts`)

The ruler has a marker lane (the ruler is 34 px: bar numbers above, markers below), with a faint line down the tracks
per marker. Click a marker to set the song position there, drag it to move it (playlist snap, Alt free), double-click
to rename in place, right-click for Jump here / Rename / Loop this section / colour / Delete (features add items through the `playlist.marker` and `playlist.ruler` menu scopes); right-click empty
ruler for Add marker here. A click (no drag) on an empty cell of the grid with the Draw tool opens the empty-spot menu
(`playlist/empty-menu.ts`): Place “current pattern” here, Place a pattern… (a submenu, with New pattern), Paste here,
Add a marker here, Name this track…, plus what features add through the `playlist.empty` scope ({ tick, laneId }):
Ask Studio about bar N… (ask-ai) and Add a fill / a transition here (arrange). Dragging on an empty cell still places
the current pattern (the controller's `press` drag turns into `create` after 4 px). Alt+T adds one at the song position and asks for its name on the ruler. Markers are found
by id, name or number (1-based in song order), so commands take any of them; the action search lists "Jump to marker:
…" and "Loop from marker: …". They live in `playlist.markers`, so they are saved with the project.

### Schema and API

- Schema v3 already had the edit fields; M15 adds one optional field: `AudioClipChannel.frozenFrom` (repair unlinks
  it when its channel is gone; `removeChannel` too).
- EngineApi additions: `isStretching`, `sampleData`, `openAudioInput` (→ `AudioInput`: levels, setMonitor,
  startCapture → `AudioCapture`), `playTestClicks`, `setSongOpenEnded`. `renderOffline` takes `limiter: false`;
  `measureTail` is exported.

### One-shot samples and the export's tail

`measureTail` renders nothing and decodes nothing: it creates the instruments on a 128-frame probe, waits for the plugins
(`pluginsReady`) and the lengths of their sample slots (`sampleLengthsReady`), and adds up `tailTime` along the routes
(capped at 30 s). A sample that plays to its end after key-up (Sampler with the envelope off, a Drum Pads pad, a one-shot
Slicer slice) used to report a tail from what happened to be decoded: the Sampler's from `host.samples.get` (null on a
cold cache, so 0.2 s), Drum Pads' a fixed 4 s and the Slicer's 2 s, so a long one-shot at the very end of the song was
cut. Now:

- `SampleSlots.durationSec(slot)` (SDK, additive) answers from `SampleCache.knownDuration`: the decoded buffer, a built-in's
  generated length, `SampleRef.durationSec` (recorded at import from the file's header, `core/io/audio-info.ts`), or what
  `SampleCache.learnDuration` read for projects that don't record it (the header, and a decode only for a file the
  headers don't describe). `Engine.sampleLengthsReady()` runs that for every sample in a plugin slot before the probe is
  read, so it costs a header read, not a decode.
- `ChannelInfo.lowestKey` (SDK, additive; `core/query/queries.ts` `lowestNoteKey`) is the lowest unmuted note of the channel
  in any pattern. The Sampler's tail is `duration × (1 − start) / 2^((lowest − root + tune + fine/100 + channel pitch/100 − 1) / 12)`
  (the −1 covers a note's own fine pitch), up to the 30 s cap; with the envelope on it is the release as before.
- Worklet instruments' `tailTime` function gets the host as a second argument (`tailTime: (values, host) => …`). Drum Pads:
  4 s, or longer for any pad with a sample, `min(1.34 × decay, duration / 2^(tune/12))` (at the maximum decay the whole
  sample). Slicer: gated playback the release; one-shot the sample (the demo break while the slot is empty) at its tune,
  never under 2 s.
- Tests (`test/browser/one-shot-tail.test.ts`): a 6 s sample on the last sixteenth of a one-bar song. Before: tail probe
  0.5 s (Sampler, cold cache), 4 s (Drum Pads), 2 s (Slicer): the export ended 0.2–4 s into the sample. After: tails of
  6.4 s (Sampler, at its root with the semitone margin), 12.7 s an octave down, 6 s (pad), 6 s (slice), and the export
  holds the whole sample, fading to silence at its end.
- A Sampler in an offline render (export, freeze, mix analysis) waits for its sample in `create()`, so the render
  starts only once it is decoded: on a cold cache its first note used to be dropped. Live playback still loads it at
  idle time (startup stays fast). Test: `one-shot-tail.test.ts`, "completely cold cache".

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

## Performance (M19)

- `?perf=mix30` (dev) builds a busy song: 26 instruments across the built-ins plus the kit, 20 effects on
  10 mixer tracks, 1100 notes in 4 bars played 8 times. On a loaded machine it plays at 60 fps (p95
  17.7 ms) with no late notes, and renders offline at 1.2× realtime.
- Idle cost is mostly the browser's per-node work: each AudioParam on an AudioWorkletNode costs
  ~0.02% of a core per instance, used or not (100 params ≈ 1.8%). So worklet params that automation
  can't drive travel as `EV_PARAM` events (`messageParamNames`, starting values in
  `processorOptions.params`); the runner merges them into the kernel's `params`. Drum Pads' per-pad
  settings are `automatable: false`: idle cost 2.9% → 0.2% per instance.
- **Lite processors.** Chrome spends ~0.5–0.75 µs per AudioParam on every render block, used or not (40 params
  on an empty `process()`: 32 µs vs 2.7 µs for none; an idle 41-param wavetable costs ~1% of a core).
  `registerKernel` therefore registers two processors: `id` (automatable params are AudioParams) and
  `id~lite` (no AudioParams but the pitch; every param is an EV_PARAM event, and automatable floats glide inside
  `KernelRunner` with setTargetAtTime's curve). `HostImpl.worklet()` picks lite unless an automation channel
  targets the instance (`core/automation/owners.ts`); when automation first targets one, `Engine.reconcile`
  asks the strips to `automationChanged()` and the instance is rebuilt as the full processor. Measured (idle mix30,
  audio thread CPU): 0.57 → 0.30 cores.
- A sleeping kernel is not woken by sync barriers or transport anchors (loop wraps used to keep every idle
  effect awake half the time; offline exports woke everything every chunk); `wakeOnTransport` opts an instrument in.
- `KernelRunner` sleeps a silent kernel (no notes held, output and, for effects, input under −120 dBFS for
  1 s) until an event or sound arrives; deterministic, since it depends only on the audio.
- An effect slot costs 0.5–1.2% of a core while silent (its gains, the slot mix's ConstantSource,
  editor taps); a 4-bar offline render of one muted instrument runs at ~34× realtime.

### Interface responsiveness and startup

Measured with `scripts/perf-ui.mjs` (real input through CDP in headless Chrome against the dev server's `?perf=`
fixtures; per input event the time to the next paint, or for one-shot actions the time until the result is
painted), `scripts/perf-follow.mjs` (per-frame JS and allocation while a song plays with smooth follow),
`scripts/perf-startup.mjs` (cold and warm loads of a production build; `--url a,b` alternates builds so a busy
machine hits both alike) and `scripts/bundle-report.mjs` (what is in each chunk, by folder, from source maps). The
machine is shared, so compare runs by their control row ("pointermove over an inert area") and repeat them.

- **Hot paths are cheap in JS**: a 50-note drag with 10k notes, a clip drag, a fader drag and an undo of 1,000 notes
  each cost a few milliseconds of script; what shows as latency is mostly the frame (vsync) floor. The wins were
  therefore in React work around the canvases and in what is rendered at all:
  - the rack follows the pattern's step count, not the pattern object (a step click made a new one and re-rendered
    150 rows), keeps its header apart from the rows (selecting a channel re-rendered every row), and renders only
    the rows near the viewport above 60 channels (`ui/controls/windowed.ts`, also the DJ library table);
  - `useGestureEdit` returns handlers made once and `Knob` is memoized, so a drag re-renders the control's text and
    not its knobs; the mixer's effect rack follows the slot list, not the insert's volume;
  - the project-pattern list items read their own name, the action search renders a window of its 80 rows, the
    Studio conversation is not re-rendered per keystroke;
  - the reload snapshot (`sessionStorage`) is written at an idle moment, not in a frame.
- **Lazy windows do not wait 300 ms**: `React.lazy` suspends on its first render even with the chunk in memory, and
  React holds the content back for up to 300 ms after showing the fallback. `lazyWindow` and the SDK's `lazyUi`
  keep the loaded component and give `use()` a promise marked fulfilled, so a prefetched window renders in its
  first frame (Studio, first open: 325 -> 36 ms).
- **Startup** (production build, `scripts/perf-startup.mjs`): the eager bundle no longer holds the MCP tools (they
  load on an AI app's first call), the piano roll and mixer windows, or the custom editors of seven built-in
  plugins (`lazyUi`). JS decoded before the first render 1777 -> ~1380 kB (-22 %), on the wire 627 -> 502 kB.
  What is left before the first paint is mostly React, the engine, the playlist and the rack. The biggest single
  item of main-thread CPU at startup is creating the `AudioContext` (`Engine.realtime`; 1-2 ms when Chrome's audio
  service is already running, ~170-250 ms for the first context of a browser process, which blocks the main thread).
  **The engine is therefore made after the first paint** (`EngineHost` with `deferred`, which `ui/main.tsx` asks for through
  `createServices({ deferEngine: true })`): the host starts with an inert `IdleEngine` (state 'suspended', nothing
  playing, meters 0, the last sample rate from localStorage for the toolbar) and makes the real engine after two animation
  frames and an idle callback (a timer covers hidden tabs), or on the spot when anything needs sound (play, a live note,
  record, previews, `ready()`, `tickAt`, decks, `sampleRate`). The project, view, session, output device, open-ended flag and
  the sample overviews asked for meanwhile are handed over. `resume()` before the engine exists waits for it and resumes it
  (a first click does not pay for creating the context inside its handler; a context made after the page was interacted with
  starts running by itself). A just-made engine is *warming* until its instruments have loaded (at most 1.5 s): live notes
  are held and played when they are in (a tap that ended meanwhile sounds for its length, a held key carries on; held notes
  older than 0.6 s are dropped) and play waits and shows as playing; stop and panic cancel both. Tests and tools that do
  not pass `deferEngine` get the engine at once. Measured (`scripts/perf-startup.mjs --fresh`, a new Chrome per run, 15 runs
  alternating builds, machine at load 10-19): cold ready (toolbar in the DOM) median 904 -> 545 ms, p95 2329 -> 881 ms, FCP
  1056 -> 695 ms; in one shared browser (audio service already up) ready 445 -> 406 ms. Time to interactive does not move:
  the same work runs right after the paint (marks `ag:engine-start`, `ag:engine`). Tried and dropped: `sinkId: { type: 'none' }`
  to skip the device (no effect in this Chrome: the creation still took 250+ ms). Not tried: a single initial chunk with Rolldown's `codeSplitting`
  groups (the page rendered nothing: a circular import between that chunk and the lazy ones).
- **Round 2** (same harness; the rows below are medians, run alternately on a shared machine):
  - *Playlist zoom* is not slower than the playlist's plain scroll: the 19-33 ms of the wheel rows is the browser
    holding a wheel event until the page has answered the previous one (the new "playlist scroll (wheel, no zoom)" row,
    where the picture only slides, reads the same; "from dispatch" subtracts it: zoom ~2-3 ms, scroll ~1 ms). A zoom
    frame already redraws once per frame (the wheel only changes the viewport; `frame()` redraws the three layers: 0.7 ms
    of JS), so what remained was raster: the lane-header and overlay canvases were redrawn on every zoom and scroll
    frame (headers now only when the lane scroll or height changed, the overlay not while it is blank): 12 % fewer
    raster calls and GPU time per zoom frame in a trace. Not done: stretching the old picture during the gesture
    (blurry, and the 2.7x of a wheel notch makes it worse than a redraw), nothing else is left to share between
    frames since grid, clips and ruler all change with the scale.
  - *Mixer*: a strip's volume, pan and dB readout are three small memoized components that each read their own
    value (`StripFader`, `StripPan`, `StripDb`), so a drag renders those and not the strip's name, buttons, menus and
    routing; and what depends on the selected track (the send arrow and knob, the IN/SC badges: `StripRoute`,
    `StripBadges`) reads the selection itself, so picking a strip (every drag starts with that) re-renders those pieces
    on each strip and the two strips that changed, not all 31 strips whole. React render time (`__ag.perf.react.ms`,
    Profiler `actualDuration`, dev build with StrictMode's double render, 31 strips): per drag move 1.0 -> 0.45 ms
    (fader) and 1.3 -> 0.55 ms (knob), at the pointer-down that selects the strip 22-25 -> 10 ms; the worst frame
    at the start of a drag 14-19 ms -> 0-1 ms (LoAF). The paint-to-paint figures barely move (6 ms from dispatch
    either way): most of a drag frame is the browser's style, layout and raster of the changed control.
  - *Autosave*: the compression moved to a Worker, see Persistence. A stall of 13-19 ms (mix30, 1.2 MB project; 37 ms
    in a quiet tab) three seconds after an edit is gone.
  - *First-time costs* were mostly the browser's: the first pointer events of a page cost 20-30 ms by themselves
    (the first drag measured 70 ms, the first context menu 75 ms, the first mixer drag 90 ms; with twelve pointer
    moves sent first: 15, 18 and 22 ms, with nothing left of a first-time penalty). A person has always moved the mouse
    before the first click, so `perf-ui.mjs` now does too (`--cold-pointer` keeps the old behaviour). Warming up code
    with canvas or DOM work (an offscreen canvas with blur, shadow, gradient and text; a hidden element with the
    context menu's backdrop-filter and shadow; opening and closing the real menu off-screen) changed nothing (48-51 ms
    in each), because the time is not JIT or GPU shader compilation: JS is 9 of the ~50 ms. So there is no idle
    warm-up in the app.
  - Known and left: the wheel latency above (browser side; ctrl+wheel must be a blocking listener to stop the page
    zoom); the per-move React commit of a fader (a controlled value through the document store: ~0.4 ms of JS).

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

## Groove, sounds and the mix setup (v3)

Every AI beat or song should sound finished in its style without hand mixing: genre groove, genre
sounds, a role mix and genre loudness.

### Groove

- **Swing is a curve** (`core/time/swing.ts`, used by `engine/sched/events.ts` and so by MIDI export):
  inside each 8th (480 ticks) with s = swing × 120 ticks, the first 1/16 plays at pos × (240 + s)/240 and
  the second at 240 + s + (pos − 240) × (240 − s)/240, on the note's position in its pattern. Notes
  exactly on odd 1/16s move by exactly s (as before); humanized notes and 1/32 rolls now keep the
  swing; notes keep their length. Measured (`test/browser/groove.test.ts`, swing 0.5 at 120 BPM): odd
  1/16s 31.25 ms late, ±2-tick humanized ones 30.99 ms, a 1/32 15.63 ms, all within 0.01 ms of the curve.
- **Style table** (`core/beat/style.ts`, `GROOVE`, `TEMPO`): swing trap 0, drill .1, boom bap .35, lo-fi
  .45, house .2, EDM 0, reggaeton .08, afro .25, pop .05; tempo ranges; hat accents per 1/16; kick 1.0 on
  the bar's downbeat, ~.92 on beats, ~.82 off; backbeat and ghost velocities; jitter. `guessStyle` is
  `inferStyle` from numbers alone; `styleOfBeat` guesses a beat's style from its own kick pattern.
- **Accents** (`core/beat/groove.ts`): `validateBeatSpec(raw, { style, project })` remembers which
  velocities the AI left out and fills those with the style's accents (snares/claps: hits on a beat are
  main hits, or every whole step when none is, as in a dembow; rolls of 3+ notes closer than a 1/16
  rise from half to full; 808 .9; seeded ±jitter). Velocities the AI gives stay exact. An explicit style
  without swing gives a song that has no swing yet the style's swing.
- **Open hats** on their own channel end at the next closed hat (at most 2 steps, or the length given,
  or their own next hit); the writer turns the Sampler envelope on (release 50 ms) so the end is heard.
- **Sampler `velTone`** (0–1, default 0 = the same node graph as before): a per-voice Butterworth
  low-pass at 20 kHz × 2^(−velTone·(1−vel)·6), none at velocity 1. The writer sets .5 on drum channels it
  sets up. Measured: a snare at velocity .3 goes from 65.9 % to 14.8 % of its energy above 4 kHz.

### Sounds

- **Genre kits** (`core/model/kit.ts` `GENRE_KITS`, `engine/kit/generators.ts`): `kit/<trap|house|lofi|
  boombap>/<kick|snare|clap|hat|open-hat>`, rendered from the SDK drum models with the Drum Synth preset
  values (trap: its preset with a shorter, punchier kick since the 808 carries the boom; house: the 909
  preset; lo-fi: the dusty preset; boom bap: its own thick kit), peaks matched to the stock kit, snares
  soft-clipped to a 13.5 dB crest factor, silent tails trimmed. `KitPiece.sound`/`.kit`; `kitPiece()`
  finds genre pieces, `kitPieceFor(sound, kit)` falls back to the stock piece. The SDK `Kick` with
  click 0 never goes inactive (its click envelope never decays): a small SDK bug, worked around here.
- **Palette** (`app/assistant/palette.ts`): `soundFor(style, sound)` → choices (plugin, preset, params,
  channel volume, root key; the palette's first, then 3xOsc backups); `KIT_FOR` (style → kit);
  `paletteText()` for the prompt. Levels are calibrated by offline renders
  (`test/browser/palette.test.ts`): alone, each sound sits under a kit kick at the default channel
  volume by 808 −3 dB, bass −4, lead/keys/pad −8, pluck/bell/strings −9 (lo-fi keys −3, pad −6), all
  measured within 1 dB. Drum channels: `drumVolume(sound, kit)` (stock-kit levels, kick −4 dB, plus a
  per-genre-kit correction because the kits' density differs at matched peaks).
- **Beat writer** (`app/assistant/apply.ts`): tracks reuse the conversation's or the named pattern's
  channels, then a channel of the same name (a Drop's "Lead" plays the Verse's), then the project's kit
  channel for that drum (the style's piece first) or its 808. A kit channel at its defaults that plays
  in no other pattern switches to the style's kit (the unused stock sample is dropped), gets velTone .5
  and its kit level. Sound settings (preset, params) only go to channels the assistant made (this
  answer or conversation) or such kit channels; levels (`volume`, `volume_db`, a negative `volume` = dB,
  `pan`) go to any channel and are recorded as `plan.levels` (the mix setup leaves them). A `preset` is
  found on whichever instrument has it. Overlapping 808 notes glide at least 60 ms. Measured: the trap
  808 slides 43.65 → 87.31 Hz (ratio 2.0000) with no new attack (level ratio 0.69 across the slide).
- **`beat` action** (`app/ai/ops/beat.ts`): `pattern: "new" | name | @ref`, `ref`, `style`; every beat
  after the first of an answer is a new pattern (it used to overwrite the first); without `pattern` the
  first beat rewrites the conversation's beat; a named pattern is rewritten (its notes replaced, on the
  part's copy in a focus). The Beat writing prompt section carries the style table and `paletteText()`.
- **Offline generator** (`core/beat/local.ts`): the shared styles (EDM and pop added), the style's
  tempo, swing and accents; trap/drill 808s slide after the pickup kick (half a step of overlap into an
  octave, drill also a 5th into each bar line); boom bap odd-1/16 hats, ghost snares and a sub under the
  kick; lo-fi four bars of 7th chords on keys with a bass on their roots; offbeat bass for house/EDM,
  four-chord pads/keys for EDM and pop.

### The mix setup (`app/mix/setup.ts`, `recipes.ts`, `layout.ts`)

- `setupMix(d, s, { style, roles, mode, pinned, pinnedChannels })` builds buses for the roles that play
  (Kick, Drums, 808, Chords, Lead, FX) plus Reverb and Delay returns: found by name (`BUS_NAMES`, so the
  arranger's Chords/Lead buses are reused and their EQ Pro gets the sweep bands), else on the next empty
  "Insert N", else new. Recipe as in the plan (exact plugin ids, preset names and params in
  `recipes.ts`): Kick EQ; Drums EQ, "Gentle glue for a bus", subtle or tape saturation; 808 EQ and "Tight
  duck for bass" keyed by the Kick bus (not lo-fi); Chords b1 150 Hz high-pass + b8 20 kHz low-pass (the
  sweep targets), a light duck (a pump in house/EDM), Reverb send −12 dB; Lead b1 200 Hz, +1.5 dB at
  4.5 kHz, b8, Reverb −14 and Delay −18 dB; FX; EQ'd Reverb (Plate/Room/Hall by style) and Delay
  (dotted ping-pong or eighth echo) returns; master EQ Pro, tape Saturator, Limiter last (−1 dB, true
  peak; an existing Limiter is kept and moved last). Faders 0/−2/−2/−6/−3/−6 dB.
- `rebuild` routes every channel by role and sets every bus fader; `fill-gaps` only routes channels on
  the master and only sets new buses' faders. Channels still at the default volume get their role's
  level. Pinned faders stay. Running it twice changes nothing.
- `pluginRole`/`mixRoles(p)`: role hints for the built-ins (808, kits on one channel, Pluck).
- Voices (`vox`: channels named vox, vocal, voice or chop, and recorded vocal clips) play through a **Vocals** bus
  (`BusRole` `vocals`, between Lead and FX in `BUS_ORDER`) instead of the Lead bus: its recipe is the pop vocal chain's EQ
  Pro, Compressor and De-esser (`VOCALS_BUS_FX` in `mix/vocal-chains.ts`), fader −2 dB, Reverb send −14 dB and Delay send
  −20 dB, so a song with a voice gets both returns. Old projects keep working: buses are found by name, a voice already on the
  Lead bus stays there (`fill-gaps` moves only channels on the master; `rebuild` moves every channel), and the arranger's
  filter sweeps (`arrange/env.ts` `sweepTargets`) count a voice as Lead material only while the project has no Vocals bus.
  Auto-level levels it like the others (`LeveledBus` `vocals`, default offset: 1 dB over the Lead; `LevelTarget.vocals`
  overrides it per style). `mix/recipe-parts.ts` holds what `recipes.ts` and the chains share (plugin ids, `FxRecipe`,
  `eqBands`) so the two files don't import each other.

### Auto-level (`app/mix/auto-level.ts`, `level-step.ts`)

- `levelMoves` (pure): every bus to its style offset from the kick (`LEVEL_TARGETS`; the first bus
  present stands in for a missing kick), moves clamped −12…+6 dB, then one trim so the buses sum to
  −16 LUFS (power sum); when a fader would pass +5.6 dB the trim stops for all of them and the Limiter
  makes up the loudness. `limiterInput(style, sum)` = target − sum, 0…10 dB.
- `autoLevel`: the busiest section's first 8 bars (most channels playing; or `fromTick`/`bars`; the
  pattern on a loop with no song; at most 20 s), one stem per role bus (`planStems`/`stemProject`, the
  master chain bypassed; other stems' tracks muted, so the reverb returns count with their sources),
  measured with `analysis/measure.ts`; one edit for the faders and the Limiter input, amended into the
  answer's undo entry (or its own); one render of the mix to check, and one Limiter correction when it is
  more than 1 dB off. Progress per bus, Stop (AbortSignal). Measured (`test/browser/mix-level.test.ts`):
  trap buses exactly on target, master −10.78 LUFS, −1.05 dBTP; lo-fi buses within 0.25 dB, master
  −13.23 LUFS, −1.05 dBTP.
- A mix without role buses (built by hand, imported, or whose buses carry under 2/3 of the playing
  channels): `levelLoudness` renders the mix before the master chain once, trims everything into the
  master together (routes to Master, channels straight into it) to −16 LUFS, sets the Limiter input,
  checks and corrects once; the balance between tracks is unchanged. It warns when the master still
  plays 2 dB over the target (a clipper or hot saturator before the Limiter).
- "Balance the mix" (`mixer.balance`, Playlist menu; `assistant.balanceMix()`): the same step without
  Claude, with progress and the result in the Studio; it waits while the song plays.
- The `level_mix` after-step (registered through `levelMixStep`); `pinnedFor` (a WeakMap on the
  after-edit object) carries the answer's pinned faders, filled by the mix module's `beforeCommit`,
  which also keeps one leveling per answer.

### AI actions (`app/ai/ops/mix.ts`)

`setup_mix {style, mode, level}` (default mode: rebuild after a beat in the answer, else fill-gaps) and
`level_mix {style, from_bar, bars}` (in a focus: that part). Prompt section "Mixing by role" (order 25):
set up and level new songs; "mix it / louder" → level_mix; "check my mix" or a specific problem →
analyze_mix and fix by hand; never both in one answer; space through shared Reverb/Delay returns rather
than a reverb on every track (each costs the audio thread).

### Audio buffer (`prefs.audioBuffer`) and Auto

Settings → Sound output → Audio buffer: **Auto** (the default), large (latencyHint 'playback', about 21 ms), medium
('balanced', 10 ms) or small ('interactive', 5 ms). A change reboots the engine (new AudioContext; playback carries on,
see `EngineHost.reboot` below). Busy songs on a loaded machine underrun the 5 ms buffer: measured as the audio clock
advancing slower than wall time during playback. The engine measures it each second while playing (`stats().keepUp`);
`app/playback-health.ts` shows plain advice once when two seconds in a row fall under 0.95 (not while Auto can still
move up). The playhead's heard time runs on the wall clock for at most 0.1 s past the output's last timestamp and never
goes back (a stalled audio clock used to make it jump back and forth); one clock read answers every reader for 2 ms
(`Engine.audibleTime`), so a frame's several readers agree and the timestamp object is allocated once.

Auto (`app/audio-buffer-auto.ts`, pure and unit-tested; `app/audio-buffer-watch.ts` runs it): starts at
`prefs.autoBufferSize` (small the first time) and, once a second while playing, reads `keepUp`: two seconds in a row
under 0.97, or one under 0.85, step one size up (`autoBufferSize` changes, the services reboot the engine and a toast
says so); never two steps within 8 s, and the 2 s after a step are not counted. After 180 s of playing with nothing
lost (60 s while the typing piano or a MIDI keyboard is on) one step down is decided, but it takes effect only when
playback stops (a reboot costs a short dropout, so a song that plays fine is never interrupted for it; struggling before
then cancels it); if it struggles within 30 s of playing at the smaller size it goes back up and no further try is made for 30 min. The size it is at is remembered in the prefs. A size picked by hand is
kept (`audioBufferPicked`; a stored 'large' without it was only the old default and becomes Auto).

`EngineHost.reboot` is seamless while playing: the old engine keeps playing while the new one (made first, fed the same
document, view, session and output device, and every change made meanwhile) loads its sounds; then the new engine
starts at the tick that will be heard when its first sound arrives (`playhead()` plus the start lead and its output
latency, in the old engine's tempo), and the old one fades out (`Engine.dispose` ramps the master down in 12 ms) as that
sound reaches the speakers. Before, the old engine was closed first and the gap was the whole plugin load.

### Latency measurements (`test/browser/latency.test.ts`, `test/helpers/latency.ts`)

`npm run test:perf` (or `VITE_PERF_STRICT=1 npx vitest run --project audio test/browser/latency.test.ts`) prints
`LAT |` lines. A probe worklet behind the limiter records the context frame of the first loud sample after arming; the
frame is turned into speaker time with `getOutputTimestamp` (its context time is the audible position: it trails
`currentTime` by `baseLatency + outputLatency`), so a measurement runs from a key's `event.timeStamp`, a MIDI message, the
call of `play()` or a knob edit to the speaker. It is split into handling (event → engine call), transit (engine call →
first sample at the master, in context time) and the rest (output buffer and device). The test instrument
(`latency-tone.worklet.ts`) sounds from the note-on frame. Paths: typing keyboard and MIDI through the real services,
play → note at tick 0, edit while playing (a note added `d` ms ahead of the schedule: the smallest `d` heard on time),
knob (a plugin param, a channel volume). Three buffers, an idle song and the `?perf=mix30` fixture playing with its tracks
muted. Findings: the engine's own part is 1.3 ms (p95 6.6) from `currentTime`; everything else is the output (24 / 32 / 40
ms in this Mac's Chrome), which only the buffer size moves. Before the compensation moved into time (see PDC) the
heavy song added the mixer's `graphLatency()` (10.6 ms there) to every live note and knob: all paths waited for the
slowest plugin. Now live input is not held back: small buffer, heavy song, key 39.7 -> 28.5 ms median (idle song 28.4),
MIDI 39.1 -> 28.3, plugin knob 39.7 -> 27.9, channel volume 37.8 -> 26.3; medium buffer key 51.8 -> 41.7 (idle 42.0), large
buffer key 69.6 -> 58.3 (idle 58.1). Playing from stop on that song is unchanged (51.3 -> 51.5 ms): the first note has to
come out `graphLatency()` after its time to line up with the slowest track, and the edit-while-playing lead is still 20 ms. An edit is heard on
time when it is at least ~20 ms ahead of the schedule (10 ms `SAFETY` + message), independent of the lookahead (the same
with 50 ms as with 120 ms), and the playhead the user sees trails the schedule by 30–60 ms, so edits ahead of what is
seen are always in time: the lookahead is a jank margin, not an edit latency, and stays at 120 ms.

### Not done / to wire at integration

- The arranger should pass `pinnedChannels` (the beat answer state's `levels`, `beatAnswerState(state)`
  in `ops/beat.ts`) to `setupMix`; without it, only channels at the default volume get role levels.
- The browser panel and `add_channel`'s kit-sound names list only the stock kit; genre kits are reached
  through the beat writer.
- The characterization answer doesn't run `setup_mix`/`level_mix` (they have their own tests).

## EDM style pack (big room, progressive house, future bass, dubstep, melodic dubstep, tech house, trance, drum & bass)

Eight more `Style`s (`core/beat/style.ts`), built only from genre conventions (tempo, where the kick and snare sit,
how a bass moves, how a build is shaped, how loud a master is). The offline generator writes chord tones on stock
progressions; nothing reproduces a song. Artist names appear only in the Studio prompt, as pointers to a subgenre
("a drop like Martin Garrix" is big room, "Flume-ish" future bass, "Skrillex-style" or "riddim" dubstep,
"Illenium-ish" melodic dubstep, "liquid" or "neurofunk" drum & bass), and in hints that say what a style is.

### The styles

| Style (`id`) | Tempo (default) | Groove | Drums and kit | Sounds (palette) | Mix: kick-relative drums/bass/chords/lead, master |
|---|---|---|---|---|---|
| Big room (`bigroom`) | 126–128 (128) | swing 0, offbeat hat accent, kick .98 on every beat | four on the floor, clap on 2 and 4, offbeat open hats; `edm` kit | “Big room lead” (mono) over “Supersaw stack” pads, sub bass, “Bright piano (club stabs)” | −4 / −5 / −6 / −2 dB, −8.5 LUFS; pads sidechained (depth .7) |
| Progressive house (`proghouse`) | 124–128 (126) | swing .08 | four on the floor, clap, offbeat hats; `house` kit | “Rolling bass” (16ths between the kicks), “Soft piano (felt, long decay)”, “Prog pluck”, “Warm supersaw pad” | −4 / −3 / −4 / −5, −10 LUFS; soft pump (.45), Hall |
| Future bass (`futurebass`) | 140–160 (150) | swing .05, triplet rolls | half-time: kick on 1, snare and clap on 3; `bass` kit | “Future bass chord” (a synced 1/8 LFO dips the volume, a mod envelope bends each chord up from a semitone below), “Vocal chop”, sub | −3 / −3 / −2 / −3, −9 LUFS; Chords bus on a 1/8 tempo pump (the wobble), Hall + triplet delay |
| Dubstep and riddim (`dubstep`) | 140–150 (140) | swing 0 | half-time and sparse: kick on 1, snare on 3, few hats; `bass` kit | sub (“Sub only”), “Growl bass” (a 1/8T triangle LFO sweeps the filter three octaves while a 1/4 LFO morphs the table), alternate “Riddim wobble” (a square LFO on every 1/8) | −3 / +1 / −9 / −5, −8.5 LUFS; Plate, Dub delay |
| Melodic dubstep (`melodicdub`) | 140–150 (145) | swing .05, triplet rolls | half-time, kick on 1, snare and clap on 3; `bass` kit | “Supersaw stack” chords, “Soft piano”, “Vocal chop”, sub | −3 / −2 / −3 / −3, −9.5 LUFS; Hall, reverb sends +4 dB |
| Tech house (`techhouse`) | 124–128 (126) | swing .3 (shuffled 16th hats), looser velocities | four on the floor, clap, shuffled hats, rim; `house` kit | “Tech house bass”, “Bright piano” stabs, “Vocal chop” shot | −3 / −2 / −8 / −6, −10 LUFS; Room |
| Trance (`trance`) | 136–140 (138) | swing 0, jitter .015 | four on the floor, clap, offbeat open hats; `edm` kit | “Gated supersaw” (a synced 1/16 square LFO chops held chords), “Trance pluck” arp, “Rolling bass” on the offbeat | −4 / −4 / −3 / −3, −9 LUFS; pads sidechained (.6), Hall |
| Drum & bass (`dnb`) | 172–176 (174) | swing .06, ghost snares | two-step: kick on 1 and the "and" of 3, snares on 2 and 4; `dnb` kit | “Reese bass” (detuned saws, a slow filter LFO), liquid adds pad and keys, neuro keeps the reese alone (alternate “Growl bass”) | −1 / 0 / −7 / −6, −9 LUFS; Plate |

### Where each part lives

- **Tables** (`core/beat/style.ts`): `STYLES`, labels, `GROOVE`, `TEMPO`, `PHRASE` (house-like styles fill every 16 bars and
  change every 8; the 140 BPM half-time styles every 8 and 4, since their bars are long), `FOUR_FLOOR` and `HALF_TIME`.
  `guessStyle` reads 168+ BPM as drum & bass.
- **Offline generator** (`core/beat/local.ts` and `local-edm.ts`, shared chords in `theory.ts`): the drum grid, bass,
  chords and hook of each style (a growl and a sub for dubstep, a rolling bass between the kicks for progressive,
  offbeat bass for trance and big room, a vocal shot every other bar for tech house, a reese under the two-step for drum
  & bass; "neuro" or "dark" keeps drum & bass to the bass). Style words: "big room", "progressive", "tech house",
  "trance", "future bass", "dubstep", "riddim", "melodic dubstep", "drum and bass", "dnb", "liquid", "neuro".
- **Palette** (`app/assistant/palette.ts`): `PALETTE`, `KIT_FOR`, three new genre kits (`kit/edm|bass|dnb/*`, Drum Synth
  settings in `engine/kit/generators.ts`, levels in `KIT_LOUDNESS` measured against the stock kit), `ALTERNATES` (presets the
  AI may name: dubstep's riddim, drum & bass's growl). Levels are calibrated like the old palette
  (`test/browser/palette.test.ts`, every choice within 2.5 dB of its slot under the kick).
- **Arranger** (`core/arrange`): `FILL_ROTATION` per style (snare rolls lead for big room and trance, kick and snare
  breaks for bass music and drum & bass); `TRAITS` in `transitions.ts` (big room and trance build with a snare roll over
  8 bars; the half-time bass styles and drum & bass leave the big silence before a drop from Δ ≥ 2; progressive house
  and trance sweep the filter over the whole build, up to 8 bars; the riser hits −2 dB in big room; sub drops for the
  bass styles; dubstep and future bass end on a stop); `shapes.ts` has each style's usual song (`SONG_SHAPES`: sections,
  lengths, energy, what is left out) and `defaultEnergy(style, role)` (a groove-first intro in progressive and tech house,
  a quiet breakdown in trance and melodic dubstep), which `arrange` uses for sections that give no energy.
- **Mix** (`app/mix`): `LEVEL_TARGETS`, per-style `CHORD_DUCK` (sidechained pads, the 1/8 wobble), reverbs, delays and
  extra reverb send, and a Limiter input up to 15 dB for the loudest styles (`limiterMax`: a dynamic mix gets only part of
  the input back as loudness).
- **Studio**: the `beat` prompt's style table (feel per style, plus the artist-phrasing map) and `paletteText()`; the
  "Song craft" section lists the usual song of every dance style; both `style` enums come from `STYLES`.
- **Templates and help**: eight dance templates (group `dance`, listed on the welcome page under "Dance and bass music" and
  in File → New from template); each one is its style's beat arranged as a 4-bar intro and an 8-bar drop with the mix set up.
- **Checker fix**: an FX tail that rings on after the music has stopped (an impact after a stop, which at 150 BPM
  covers two bars) is the ending, not a "silent" gap.

### Presets (CPU, % of one core at 48 kHz, 4 s, best of 5; `npm run bench:plugins -- --only wavetable --preset "<name>"`)

| Preset | Plugin | CPU |
|---|---|---|
| Big room lead | Wavetable | ≤ 1.1 % (mono, 3 unison) |
| Supersaw stack | Wavetable | 3.4 % (5 unison × 2 oscillators; "Warm supersaw pad" is 6.6 %) |
| Future bass chord | Wavetable | 3.1 % (4 unison × 2) |
| Growl bass | Wavetable | ≤ 1.2 % (mono, two synced LFOs) |
| Riddim wobble | Wavetable | ≤ 1.0 % |
| Reese bass | Wavetable | ≤ 1.0 % (legato, 3 unison) |
| Tech house bass | Wavetable | ≤ 1.0 % |
| Rolling bass | Wavetable | ≤ 1.0 % |
| Trance pluck | Wavetable | 1.6 % |
| Gated supersaw | Wavetable | 2.3 % (5 unison × 2) |
| Prog pluck | Wavetable | 1.7 % |
| Vocal chop | Wavetable | ≤ 1.1 % |
| Soft piano (felt, long decay) | FM | 1.5 % |
| Bright piano (club stabs) | FM | 1.4 % |

(A "≤" means the preset costs less than the plugin's default patch, which the benchmark reports as 1.0–1.2 %; the chord
presets are measured on the benchmark's 3–4 note chords. Unison stays at 5 or less: the 8-voice supersaw is the heavy one.)

### Measured

- **Palette** (`test/browser/palette.test.ts`, offline through the real engine): every new sound alone sits within 0.5 dB
  of its slot under the kick (lead −8, pad −8, keys −8, pluck −9, bass −4); each preset's own `level` carries the
  calibration, the channel volumes stay .55–.7.
- **Kits**: the three kits measured against the stock pieces (kick, snare, clap, hat, open hat, in LUFS at the writer's
  levels) set `KIT_LOUDNESS`: festival kick +2.2 dB, bass-music kick +1.5, drum & bass kick +0.7 and so on.
- **Eight bars per style** (`test/browser/edm-pack.test.ts`: the generator's beat, mix set up, auto-level, rendered):
  none silent, true peak −1.05 dBTP in all eight, and each within 1.5 dB of its target (measured / target LUFS): big room
  −9.43 / −8.5, progressive −10.77 / −10, future bass −9.73 / −9, dubstep −9.20 / −8.5, melodic dubstep −10.09 / −9.5,
  tech house −10.96 / −10, trance −10.11 / −9, drum & bass −9.83 / −9. The Limiter input settled at 7–11 dB. An
  earlier −7 to −8 target was out of reach for these dynamic mixes even at 14 dB of input (dubstep reached −8.6).
- **Node**: every style's usual song applied through `arrange` flows (`src/app/edm-shapes.test.ts`); the generator,
  transition traits, mix tables, prompt and templates have unit tests (`core/beat/edm.test.ts`, `core/arrange/edm.test.ts`,
  `app/mix/edm-mix.test.ts`, `app/ai/edm-prompt.test.ts`); the v3 acceptance test runs over all 17 `STYLES`.

## Sound filters (`core/filters`, `core/ops/filters.ts`, `app/filters`, `ui/features/filters`)

"Nightcore it", "make the chorus sound like a phone call": a named filter applied to a part of the song, as
one undo step, with the original kept.

- **Presets** (`core/filters/presets.ts`): a table of `{ id, name, group, description, speed?, reverse?, fx }`.
  Speed filters (Nightcore 1.25, Sped up 1.15, Slowed 0.85, Slowed + reverb, Daycore 0.75, Chipmunk 1.5) resample
  like a record: faster is higher (1.25 = +3.86 semitones). Tone filters (Lo-fi, Telephone, Radio, Underwater,
  Vinyl, 8-bit, Dreamy, Wide, Mono, Reverse) keep the timing and are chains of built-in effects (lofi, filter,
  eq-pro, saturator, reverb, chorus, stereo, distortion) with the params that differ from the defaults. Add a row
  and the menus, chooser, action search and the Studio's `filter` enum pick it up.
- **Targets** (`core/filters/target.ts`): selected clips, a range (the loop region, a marker's section, a clicked
  bar) or the whole song. The clip menu filters the selection it belongs to; the marker menu its section; the ruler
  the loop region, else the section or bar there; an empty spot the loop when clicked inside it, else its section or
  bar; Playlist › Apply a filter… and the action search the selection, else the loop, else the whole song. A tone
  filter on clips takes just those clips; anything else takes every playing clip over the span (automation clips
  stay and keep playing).
- **Apply** (`app/filters/apply.ts`): the part is rendered like Consolidate (`renderRange`: clips cut at the part's
  edges, automation kept, no master chain, tails that ring past the end), then in one transaction: the clips are
  cut at the edges (`cutPart`; pieces outside stay) and the inside removed; a new audio clip channel plays the
  render with `pitch` = the speed in cents (stretch off, so it runs at its own speed), `reverse` for Reverse (the
  trim skips the reversed tail), and outputs through a mixer track holding the filter's effects (an empty
  "Insert N" is borrowed and renamed, else one is added). The effects run live, so they stay editable and reverb
  tails ring on after the clip.
- **Speed changes the tempo, not the positions.** Instead of rippling everything after the part (which would leave
  the rest of the song off the bar grid by a fraction of a bar), a speed filter scales the part's tempo by the speed
  (`changePartTempo`): the whole song without tempo automation gets a new BPM; otherwise a tempo automation clip
  over the part plays the old tempo curve × speed (sampled per 1/16 step, the tempo map's resolution; tempo clips
  that started inside the part are cut out and kept) and ends on the tempo the song had there, which it holds. The
  bars stay where they are, the part plays 1/speed as long, and everything after arrives earlier (or later) by the
  difference: no overlap, no gap, markers and automation still on their bars. Speed filters round the part to whole
  1/16 steps and always take every track. Measured (`test/browser/filters.test.ts`, headless Chrome): Nightcore on
  bars 5–8 of a 120 BPM song turns 1000.0 Hz into 1250.0 Hz (+3.86 semitones), the part takes 6.4 s instead of 8 s
  and bar 9 arrives 1.600 s earlier; Telephone on noise cuts the band below 250 Hz by 28 dB and above 4 kHz by
  31 dB relative to the 0.8–2 kHz band.
- **Keeping the original**: the new channel's `filter` record (`SoundFilter` in `core/model/types.ts`) holds copies
  of the replaced clips (whole, as before the cut), the pieces the cut made, the mixer track (made or borrowed, its
  old name and the slots it added) and the tempo change (old BPM or the tempo channel). `removeSoundFilter` deletes
  the channel and its clips, the pieces, the tempo change and the effects, and puts the copies back; clips whose
  track, pattern or channel was deleted meanwhile are skipped. A filter made later over a filter's audio keeps that
  audio in its own record, so the earlier one refuses to go first (`filtersOver`). `repairProject` forgets a
  damaged record (the filtered audio stays).
- **UI** (`ui/features/filters`): "Filter ‹part› ▸" (speed and tone groups) in the clip, marker, ruler and
  empty-spot menus; Remove filter on a filtered clip and in the Playlist menu; Playlist › Apply a filter… (a
  chooser with each filter's description and the part); "Filter: Nightcore" etc. in the action search. After
  applying, the song plays from a bar before the part.
- **Studio** (`app/ai/ops/filters.ts`): `filter { filter, from_bar?, to_bar?, section?, clips?, whole_song? }`
  (default: the part asked about, else the whole song) runs after the answer as an after-step folded into its undo
  step (`app/filters/step.ts`); `remove_filter { clip? | bar? }` edits in the answer.

## MCP: AI apps control AGstudio (`tools/mcp`, `src/app/mcp`)

Any AI app that speaks the Model Context Protocol (Claude Code, Claude Desktop, Cursor…) can drive the open project
with the same machinery as the Studio chat: the action schema, the applier, the command catalog, the after-steps.
Setup for people is in the README ("Control AGstudio from AI apps (MCP)"); this is how it works.

- **Where things live.** The project lives in the browser tab, so the dev server cannot edit it. The server holds
  the MCP endpoint and relays each tool call to the tab; the tab runs the tool and answers.
  ```
  AI app ──POST /mcp (JSON-RPC, bearer token)──▶ dev server (tools/mcp) ──HMR websocket──▶ tab (src/app/mcp)
         ◀───────────── result ───────────────                       ◀──────── result ────────
  ```
  `tools/mcp/server.ts` is a Vite plugin next to `aiServer` (dev server only: a production `vite preview` has no
  websocket to the page, so no MCP). It adds `POST /mcp`, and the app's own endpoints under `/api/mcp/*` (`info`: the
  token, the folder, who is connected; `token`: regenerate; `upload/<ticket>`: exports), which want the `x-agstudio`
  header and the same origin, like `/api/ai`.
- **Protocol** (`tools/mcp/protocol.ts`, pure: `handle({method, headers, body}) → {status, headers, body}`, unit-tested
  with plain objects). Implemented subset of the spec (read 2026-10): one endpoint serving both eras of the
  Streamable HTTP transport.
  - **2026-07-28** (stateless): no `initialize`; every request carries `_meta` (`io.modelcontextprotocol/protocolVersion`,
    `clientInfo`, required `clientCapabilities`) and the `MCP-Protocol-Version`, `Mcp-Method` and `Mcp-Name` headers
    (a base64 `=?base64?…?=` name is decoded). A header that disagrees with the body is HTTP 400, `-32020`; missing
    `_meta` is 400 `-32602`; an unknown version is 400 `-32022` with `data.supported`; an unknown method is 404
    `-32601`. `server/discover` returns versions, capabilities, instructions; results carry `resultType: "complete"`.
  - **2025-11-25, 2025-06-18, 2025-03-26**: `initialize` negotiates the version (an unknown one gets the newest it
    speaks), returns `capabilities` (`tools`, `resources`), `serverInfo` and `instructions`, and hands out an
    `Mcp-Session-Id` that only remembers the client's name (a request without one is still served); `notifications/*`
    answer 202; JSON-RPC batches work. A client that sends no version header is treated as 2025-03-26, as the spec says.
  - **Both**: `ping`, `tools/list`, `tools/call`, `resources/list|read|templates/list`. Tool arguments are checked
    against the tool's schema first (required, types, enums, ranges, unknown options): a problem is an `isError`
    result the AI can read and fix, never a protocol error; an unknown tool is `-32602`; a tool that throws is an
    `isError` result. Results carry text (and `structuredContent` for data tools), `audio` for previews. Replies are
    always plain JSON: nothing is pushed to the client, so `GET` and `DELETE` answer 405, there are no SSE streams, no
    prompts, logging, sampling or subscriptions, and no 2024-11-05 HTTP+SSE transport.
- **Security** (`tools/mcp/guard.ts`, checked in this order, each with its own plain message): the connection must
  come from a loopback address (403); `Host` must be `localhost`, `127.0.0.1` or `[::1]` (403, DNS rebinding); a present
  `Origin` must be such a local page (403, so a web page on another site can't use it); then the bearer token, from
  `Authorization: Bearer …` or `?token=`, compared in constant time (401, `WWW-Authenticate: Bearer`, plain text). Also
  600 requests a minute (429), 8 MB bodies, no CORS headers at all. The token (`agmcp_` + 32 random bytes, base64url) is
  made once into `.agstudio/mcp-token` (git-ignored, mode 0600, `tools/mcp/token.ts`); Settings can replace it, which
  locks the old one out at once. `AGSTUDIO_MCP_TOKEN_FILE` and `AGSTUDIO_EXPORTS_DIR` move the files (the tests use them).
- **Tool definitions** (`src/app/mcp/defs.ts`, plain data) are loaded by the dev server through `ssrLoadModule`, so
  `tools/list` is current (new ops show up with the next request) and works before any tab is open. `apply_actions`
  takes `ACTIONS_SCHEMA.properties.actions` itself, so a new op is available over MCP the moment it is in the schema.
  The tools themselves (`tools.ts`, `read-tools.ts`, `audio-tools.ts`) run in the page, take `Services`, and are
  unit-tested with `createTestServices`.
- **The bridge** (`tools/mcp/bridge.ts` on the server, `src/app/mcp/bridge.ts` `McpLink` in the page), events
  `agstudio:mcp:*` over Vite's HMR websocket (`server.ws.on` / `import.meta.hot`):
  tab → server `hello {tab, focused, enabled, project}` (on load, reconnect, focus, a click, a setting), `ack {id}`,
  `result {id, ok, result|error}`, `bye`; server → tab `call {id, tab, name, args, client, ticket}` and `status`.
  - The call names the tab that must answer; the others ignore it. That is the tab the musician used last (tabs report
    focus; a background tab that merely reloads doesn't steal calls). No live tab: "Open AGstudio in the browser first:
    http://localhost:PORT". MCP switched off in Settings: the call fails with that reason (the switch is
    `prefs.mcpEnabled`, on by default).
  - The tab acknowledges at once, so a frozen tab (no ack in 4 s) is told apart from a slow tool (waits up to 60 s,
    15 min for `apply_actions`, renders and exports). A tab that closes mid-call fails the call within a second.
  - Liveness is the websocket itself (`server.ws.clients`), not a heartbeat: hidden tabs throttle timers.
- **`apply_actions`** goes through `BeatAssistant.applyExternal` (`app/assistant/assistant.ts`), which is `applyTurn`
  for an outside caller: `applyAnswer(s, answer, { source: "Claude Code", label: summary, focus })` is **one** history
  transaction labelled "Claude Code: <summary>" (`applyAnswer`'s optional `source`; Studio's stays "Studio: …"); the
  chat gets "Claude Code changed: <summary>" (`detail: "over MCP"`) with the usual Undo at that history point;
  `command` actions run (file-dialog ones become a button, below); windows open; the answer's `play`/`stop`/`mode`
  run, but nothing else starts playback (the Studio chat's autoplay is for a person waiting). Follow-up steps
  (`after-steps.ts`: leveling, filters) run before the call returns, folded into the same undo step; while the music
  plays they wait up to 30 s for it to stop, then render anyway. The result carries `changes`, `warnings`,
  `followups`, `before_point` (what `undo` with `to_point` goes back to), `undo_point`, `history_label`.
  - **Focus and approval.** `focus: {from_bar, to_bar}` is an `AiFocus` range, so the guard (`ops/focus-guard.ts`) keeps
    edits inside it. A dry run first (`dryRun: true`): when edits reach outside, nothing is applied and the result is the
    question (what reaches outside, "call again with `approve_outside: true`"); with it, the same answer applies with
    `focusOutside: 'allow'` (the part still gets copy-on-write pattern copies).
  - Edits are serialized (a promise chain) and wait up to 15 s for a running Studio request (`phase` idle).
- **Other tools.** Reads: `get_guide` (`STUDIO_PROMPT` with a preface about tools instead of JSON answers),
  `get_project` (`projectContext`, plus `focusContext` for bars), `list_plugins` (`pluginCatalog`), and every read
  tool the Studio chat has (`ai/read.ts` `readTools`, built into the MCP tool list from the same objects:
  `get_pattern_notes`, `get_channel`, `get_mixer`, `get_clips`, `get_automation`, `get_selection`, `get_transport`,
  `get_settings`, `get_windows`, `get_plugins`; its `get_project` JSON overview is `get_project_summary` here, the
  name `get_project` being the full text), returning their JSON as text and data, a bad argument as an `isError` result. `list_commands`/`run_command` use `aiCommands` and `commandCatalog` (a
  command with `ai: false` is refused; `gesture` ones don't run: `McpLink.askForClick` queues a button and
  `ui/features/mcp/register.ts` shows "Claude Code wants to export…" so the click is the user activation the picker
  needs; other commands run, their error toasts come back as the result, a project change is reported in the chat with
  Undo). Transport: `play`, `stop`, `seek`, `set_loop`, `transport_state` (it says when the browser still has sound
  locked). `undo`, `redo`, `history`. `analyze_mix` is `analyzeMix`; `render_preview` renders with `renderOffline` at
  32 kHz, trims like an export and returns a 16-bit WAV as `audio` content (default 15 s, at most 30 s).
  `export_audio` runs `runExport` into a **memory** target (no picker), then uploads each file to
  `POST /api/mcp/upload/<ticket>`: the ticket is issued by the server for that one authenticated call and revoked
  when it ends; the server writes into `~/Music/AGstudio/` (stems into a sub-folder), cleans names, accepts only
  .wav/.flac/.mp3/.zip, never overwrites ("Song (2).wav"). Capped at 20 minutes of audio (it is held in memory).
  No screenshot tool: there is no cheap way to capture the page without a rendering dependency.
- **UI.** Settings → "Connect AI apps (MCP)" (`ui/features/mcp/McpSettings.tsx`, on top of `settings/parts.tsx`): the
  switch, a live status line ("Connected: Claude Code · 3 calls in the last minute", pushed by the server on change and
  refreshed while the window is open), the token (masked, Show, Copy, New token…), the Claude Code command, the Claude
  Desktop config (`bin/agstudio-mcp`), a JSON setup for URL clients, the exports folder. Commands (so the action search
  and Studio's `command` action find them): `options.mcp` (switch; "Let other apps control AGstudio (MCP)": the audited command wording avoids "AI"), `options.connectAi` (opens Settings),
  `options.copyClaudeCodeSetup` (clipboard and a toast only: the token never goes back to a chat or an app). A toast tells the musician the first time
  an app calls.
- **`bin/agstudio-mcp`** (a `sh` wrapper that finds Node) runs `bin/agstudio-mcp.mjs`: stdio ↔ HTTP for apps that start
  MCP servers as programs. Claude Desktop's config file takes only such servers (remote ones go through Settings →
  Connectors and must be reachable from the internet), so this is its path. One line in, one POST out, concurrent;
  keeps the session id and negotiated version; mirrors `Mcp-Method`/`Mcp-Name` for 2026 requests; reads the token from
  `.agstudio/mcp-token` for every request; says "AGstudio isn't running…" as a JSON-RPC error when nothing answers.
- **Tests.** `test/unit/mcp-protocol.test.ts` (both eras, errors, validation, 405, batches),
  `mcp-server-parts.test.ts` (guard: loopback, Host, Origin, token; token file; uploads; the bridge with fake tabs:
  election, ack, timeouts, closed tab, switched off; status), `mcp-stdio-proxy.test.ts` (the helper against a stand-in
  server), `src/app/mcp/*.test.ts` (tools against `createTestServices`: one undo step, chat message, focus approval,
  commands, gestures, transport, history, follow-up steps, the page bridge, setup lines), and `mcp-e2e.test.ts`: the
  project's own `vite.config.ts` on a free port (own cache dir), the app in headless Chrome (`playwright`, skipped
  when Chrome is missing), JSON-RPC over HTTP: refusals, both handshakes, a beat applied as one undo step and read back,
  undo/redo, commands, play, `analyze_mix`, a rendered WAV, an exported file, the Settings status line, a new token,
  the switch, and the "open AGstudio" message once the tab is gone.
- **Limits.** Dev server only; needs an open tab (and one click in it before anything is audible); the guide and
  catalogs are large reads (the guide about 29 kB, `list_plugins` 43 kB, `list_commands` 51 kB, `tools/list` 61 kB
  with the action schema), each under the 25 000-token result limit Claude Code applies; a client that cannot show
  audio content gets only the text of `render_preview`; no live notifications to the client (it re-reads with
  `get_project`).

## Reference track matching (`core/reference`, `app/reference`, `ui/features/reference`)

The musician drops in a song they own. AGstudio measures it and the buttons and Studio use the numbers to shape
the musician's own song. **Only derived measurements are kept** (tempo, key, beat grid, section boundaries and
energy, loudness, true peak, a coarse spectral balance, stereo width). Nothing of the song is copied, sampled,
transcribed or played: no note, chord or audio of it is read or written by any match, and the file is never placed
in the song.

### What a project keeps (`Project.reference`, optional, `ReferenceTrack` in `core/model/types.ts`)

- Title, content hash, duration, tempo (null without a steady beat), beats per bar, key with Camelot code and
  confidence, LUFS, true peak, the energy per bar (at most 1024 values), the sections (kind, seconds, bars of the
  reference's own grid, energy 0–1, tonal balance, width) and the whole song's tonal balance and width.
- `sampleId`: the file as a sample of the project (`Project.samples`), for the title and for analyzing it again. It
  is stored through the sample store like any import, so the clean-up of unused audio keeps it while the project
  mentions its hash; a saved project file bundles it with the other samples. No channel or clip plays it. Replacing
  or clearing the reference drops the sample when nothing else uses it (`app/reference/doc.ts`).
- `repairReference` (`core/schema/migrate.ts`): a reference that cannot be read as measurements is forgotten (the song
  stays), values are clamped, bad sections dropped, a gone sample leaves the numbers in place. Idempotent.

### Measuring (`app/reference/analyze.ts`, `spectrum.ts`)

- The `TrackAnalysis` comes from the existing `trackAnalyzer(s).analyze` (public API; `TrackAnalysis` is unchanged). The
  tonal measurement is this module's own: the file is decoded again (44.1 kHz) and `measureTone` runs the mid signal
  through cascaded Linkwitz–Riley splits at `TONE_CROSSOVERS` (60, 150, 400, 1k, 2.5k, 5k, 10k Hz: eight bands, sub,
  bass, low mids, mids, upper mids, presence, highs, air) over the whole song and over each analyzed section, plus
  side/mid width (capped at 10). Stored as each band's share of the energy in dB under the total, so songs compare at
  any loudness. A 3-minute song takes about 2 s in all (analysis in its Worker, the tone pass on the main thread with
  yields). The bands overlap a little at their edges (a tone in the middle of an octave band puts 40 % of its power in it).
- The measurement is cached by hash in memory and IndexedDB (`reference-measure:v…`); `buildReference` (`core/reference/track.ts`)
  is the pure assembly.
- The musician's own song is measured the same way by `song-tone.ts`: the busiest part (`busiestWindow`, as leveling
  does) rendered through the master chain with the Limiter, measured with `Measurer` (LUFS, true peak) and `measureTone`.

### Comparing and matching

- **Tone** (`core/reference/bands.ts`): the reference's *main tone* is its sections at energy ≥ 0.6 weighted by length
  (an intro or a break is not what the mix is trying to sound like). `compareTone` takes the median of the eight
  differences out first (shares add up to a constant, so one heavy band makes the others look light) and lists the bands
  more than 3 dB off, the biggest first, with a plain sentence ("The low end (60–150 Hz) is 4 dB lighter than the
  reference: bring it up about 4 dB with …"). Bands empty in both are ignored.
- **Tempo and key** (`app/reference/match.ts`, `core/reference/key.ts`): the tempo is set (a reference without a steady
  beat leaves it, with a warning). The key move is the shortest (−6…+5 semitones) to the reference's key, going to its
  relative key when one is major and the other minor (C major and A minor share their notes). The song's key is the song
  key setting, else the best Krumhansl–Temperley fit of its pitched notes. Pitched and bass channels' notes move (drums
  and unknown roles stay); variants stay unmodified; the song key setting follows. A key the analysis is unsure of
  (< 0.3) is not matched.
- **Arrangement** (`core/reference/plan.ts`, `material.ts`): the reference's sections become `arrange` sections. Bars are
  the section's seconds at the project's tempo (equal to the reference's bars when the tempos match; at another tempo the
  same time becomes the bars that fit), rounded and snapped to phrases of 4 within a bar; parts under 2 bars join the
  neighbour, parts over 64 bars split, more than 24 sections or 512 bars are reduced (the plan says how). Energy
  0–1 → 1–5 keeping each part's usual range; names by part ("Drop 2"). *Which patterns play* comes from the project: the
  existing sections (`inferSections`) are the palette, each reference part takes the group of patterns closest in energy
  (same kind of part on a tie); with no song yet, the patterns are layered from the sparsest to all of them. `arrangeInDraft`
  then does the craft (fills, transitions, FX) with `mix: 'keep'`, replacing the song's arrangement. The last section's
  stop effects ring a little past its last bar.
- **Loudness**: `autoLevel` and the `level_mix` after-edit take an optional `targetLufs` (the reference's, within −30…−4).
  With one, the Limiter's input may go to +20 dB (else 10) and is corrected up to 5 times by a secant estimate (a Limiter
  returns less than it is given); it warns when the Limiter is pushed past +10 dB or cannot reach the target. Headless
  Chrome, a house song at 124 BPM with the role mix: the Limiter saturates at −9.3 LUFS against a −8.4 reference.
- Every edit is **one undo step** (`history.transact`); the Studio's edits fold into the answer's step.

### UI (`ui/features/reference`) and Studio

- The **Reference** window (View menu, Alt+Shift+R, action search "Use a song as my reference"): drop a file or choose one
  (or one from the music library, which is also a drop target for library rows). Header with title, Change, Clear; a table
  of tempo, key, loudness, true peak and width next to the song's; the reference's parts and the song's sections as two bar
  strips on one scale (width = bars, height = energy); the eight bands as bars with the mix's difference once it was
  listened to; the findings; and four actions: **Match tempo and key**, **Arrange like the reference**, **Match loudness**,
  **Show the tonal difference** (changes nothing). Every control has a `data-hint`; the empty window says what to do and what
  is (not) done with the song. Commands `reference.*` are in the Playlist menu and the action search.
- **Studio**: `set_reference` (`song` from the music library, `sample` of the project, `choose_file` for a one-click file
  chooser, `clear`) and `match_reference { tempo, key, arrangement, loudness, tone }` (none named: all; `tone` listens to the mix
  and reports bands > 3 dB off, changing nothing), `get_reference` (measurements next to the song's, the arrangement the plan
  would make at its tempo, the last tone check), a `<reference>` block in the context, a prompt section ("make it sound like my
  reference" → `match_reference`; never copy melodies, chords, drum patterns or audio). A reference that still has to be analyzed
  is set by an after-step (`set_reference`, then `match_reference` waits behind it in the same answer) folded into the answer's
  undo step; with a cached measurement it is a plain edit. The four match commands are `ai: false`, covered by `match_reference`
  in `test/unit/ai-coverage.test.ts`.

### Tests

Node: `core/reference/*.test.ts` (tone comparison, section plan, material, key move and transposing, build and repair),
`app/reference/spectrum.test.ts`, `actions.test.ts`, `app/ai/ops/reference.test.ts` (one undo step each, undo restores the project
exactly), `ui/features/reference/reference-view.test.ts`. Browser: `test/browser/reference.test.ts` writes a synthetic 16-bar
intro, 32-bar drop, 16-bar break and 32-bar drop at 128 BPM scaled to about −8 LUFS as a WAV, analyzes it for real (128 BPM, A
minor, the four parts, tonal balance per part), sets it on a house song at 124 BPM and checks tempo 128, markers at bars 1, 17, 49
and 65, and the master within 1.5 dB of −8 LUFS, through both the window's functions and a Studio answer.

### Limits

Tuned on synthetic songs; real recordings with long tails or fades make the last section a bar or two longer. The key move is
exact only when the song's key is known (setting or clear notes). Audio-clip channels are not transposed. Loudness is bounded by the
mix's peaks: a mix with high peaks cannot be made as loud as a mastered song by the Limiter alone. The tonal bands are coarse
(eight) and measured over the mid signal.
