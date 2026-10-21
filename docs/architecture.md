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
- Installable as a desktop app (a PWA from Chrome: its own window, dock icon, offline start, opens project files); see
  "Installable app (PWA)". No Electron.

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

Enforcement: ESLint `no-restricted-imports` per folder (see `eslint.config.js`), plus five tsconfigs run by `tsc -b`:
`app` (DOM), `core` (no DOM lib, keeps core pure), `worklet` (`types: ["audioworklet"]`), `node` (build config), `sw` (the service
worker, WebWorker lib).

### Where big jobs live (the readability passes)

Files stay under about 500 lines and functions under about 40 (`docs/code-style.md`): a big job is a folder or a small
family of files with one door. These are the splits to know when looking for something (each file's comment says what it
does):

- **Composition root** (`src/app`): `services.ts` reads as numbered steps; the prefs, engine and selection wiring is in
  `service-wiring.ts`, created in the same order as before. Long-lived objects are still made only there.
- **Schema repair** (`core/schema/repair/`): one module per part of the project, behind `index.ts`. **DJ deck control**
  (`app/dj/deck-control/`): one module per job (loader, cues, loops, jog, tempo, recorder, streams…), behind the deck
  controller.
- **AI** (`app/ai`): `context/` (budget and the channel, mixer, pattern and playlist lines), `read/` (read tools in
  groups: project, music, sound, arrangement, measurement), `ops/` (one module per kind of action; `ops/automation/`
  and `ops/session/` are folders), `focus/` (the `<focus>` block), `schema/`, and the catalog the AI is told about:
  `catalog-items.ts` (one list of plugins, tools, chains, racks, MIDI effects and commands), `catalog-index.ts` (the index in the system prompt),
  `predict.ts` + `predict-words.ts` (which items a request needs), `catalog-details.ts` (their details). The beat writer (`assistant/apply.ts`) keeps its door and has `beat-writer/`
  behind it (channel matching, sounds, plan, write).
- **MCP** (`app/mcp`): `tools.ts` builds the tool list from `edit-tools.ts`, `transport-tools.ts`, `history-tools.ts`,
  `read-tools.ts` and `audio-tools.ts`; shared pieces are in `common.ts` and `tool-deps.ts`.
- **Mix** (`app/mix`): `auto-level.ts` is the door; targets, level math, the loudness stage, the listening window, the
  renderer and the loudness edit are in `mix/leveling/`.
- **Export** (`app/export`): `audio-export.ts` runs prepare, measure, render and write steps over one run object;
  `zip-stream.ts` is the stem zip writer, `video/` the video export. The dialogs are in `ui/features/export`: sections
  (`AudioExportSections`, `VideoSections`, `ExportFooter`), the runs in hooks (`use-audio-export.ts`,
  `use-video-export.ts`), and `register.ts` split into `export-now.ts` (the export-now commands) and `export-args.ts`
  (reading their arguments).
- **Pitch editor** (`ui/features/pitch-editor`): `controller.ts` handles pointers and state, `pitch-draw.ts` paints one
  layer per function (grid, notes, pitch lines, overlay, keys, ruler), `pitch-types.ts` has the shared types,
  `pitch-commands.ts` the commands and `pitch-menus.ts` the note menus.
- **Windows** (`ui/features/*`): the channel rack (`ChannelRow`, `StepGrid`, `InsertBox`, `AutomationRow`,
  `RackHeader`, `RackRows`, `StepLight`, with `step-paint.ts`, `step-graph-draw.ts`, `rack-drop.ts`), the launcher
  (`LauncherCells`, `slot-drop.ts`, `view-controller.ts`), the sample browser (search, filter and selection bars, the
  list, the preview footer, `useSampleNavigation.ts`), the Studio chat (`Header`, `Conversation`, `Composer`,
  `PerformanceStrip`), the visualizer (`controller.ts` has one method per panel, `draw.ts` paints), and the presets
  bar. The playlist and piano roll controllers are folders (`playlist/control`, `piano-roll/control`), one module per
  tool or layer.
- **Shell** (`ui/shell`): `MenuBar.tsx` and `MenuDropdown.tsx` (submenus, dynamic entries, command rows);
  `HoverTip.tsx` owns the element and `hover-tip.ts` the delays and gaps.
- **Vocal cleanup**: pure DSP in `core/audio/cleanup/` (`spectral-denoise.ts`, `noise-profile.ts`, `breaths.ts`, `clicks.ts`, `render.ts` the chain, `test-signals.ts`), the
  settings' meaning in `core/audio/cleanup-edit.ts`, the draft mutators in `core/ops/cleanup.ts`, the renderer in `app/actions/cleanup-render.ts` with
  `app/cleanup/` (Worker, jobs, window state, the AI read) and the window in `ui/features/vocal-cleanup`. The clip edit chain (cleanup, then pitch)
  is `STAGES` in `core/audio/playback.ts`. The "Vocal cleanup" section has the details.
- **Audio to MIDI**: pure listening and planning in `core/audio/transcribe/` (one file or small family per mode: `melody.ts`,
  the drum files `drum-bands`, `drum-views`, `drum-rules`, `drum-leak`, `drum-cuts`, `kit-clean` behind `drums.ts`, `chords.ts`, `bass.ts`;
  then `plan*.ts`, `quantize.ts`, `timeline.ts`, `suggest.ts`, `listen.ts`), the draft mutator in `core/ops/transcribe.ts`, the app in
  `app/transcribe/` (Worker, remembered listening, `convert.ts`, `audition.ts`, `slices.ts`, `args.ts`, `report.ts`) and the dialog in
  `ui/features/audio-to-midi`. The "Audio to MIDI" section has the details.
- **Actions** (`app/actions`): the pitch renderer is `PitchRenderer` in `pitch-render.ts` (with `pitch-clip.ts` for the clip
  lookup and error type; `pitch.ts` keeps the door); the arranger's `transitionInDraft` is `app/arrange/transition.ts`.
- **Effect racks**: the model in `core/model/rack.ts` and `types/rack.ts`, the edits in `core/ops/racks.ts`, the queries in `core/query/rack.ts`, the macro
  maths and the `.agrack` file in `core/rack/`, repair in `schema/repair/rack.ts`; the engine's rack in `engine/rack/` (`rack-effect.ts` the graph,
  `rack-split.ts` the four splits, `rack-branch.ts`, `macro-links.ts`) on top of `engine/slot-chain.ts`; the factory racks, your racks and the files in
  `app/racks/`, the AI's in `app/ai/ops/racks.ts` and `read/rack-tools.ts`, the window in `ui/features/rack`. The "Effect racks" section has the details.
- **Engine** (`src/engine`): `engine.ts` is the facade; see the list under [Graph](#graph) for what each file does.

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
- `DocChange { next, prev, patches | null, origin, glideSec? }` feeds the engine (`origin`: edit | gesture | undo | redo | load;
  `glideSec` is set by `transact(…, { glideSec })` for a snapshot recall: the mixer glides over that long instead of stepping).

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

The transport around it (`sched/transport.ts`) is split by job: `plan-state.ts` holds what has been planned (the cursor,
the segments, the launcher axis position, the stop position), `positions.ts` answers where the transport is from that
state (tick, tempo and launcher position at a time, with no side effects), and `replan.ts` decides what a live edit does
to notes that are already sounding. `transport-trace.test.ts` pins what it sends and answers on 60 seeded random
sessions.

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
- A channel with MIDI effects is collected through its chain (`engine/sched/fx-events.ts`, see "MIDI effects"):
  its events carry `fx` instead of a `noteId`, and a re-plan asks `fxNoteEnd` whether a sounding one is still made.
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
channel: instrument.output → vol → StereoPanner → [mute] ──► insert chIn
insert : chIn/routeIn → slot 1…N → scTap → [mute/solo gate] → preTap → StereoPanner → fader → postTap ──► routes
slot   : in ─► bypass / dry / latency-aligned dry / fx … wet ─► out   (gates crossfade ~10 ms)
master : the same strip; postTap → masterOut → SafetyLimiter (worklet) → destination
         preview bus → masterOut;  monitor bus (metronome, later) → limiter only
```

Routes, sidechains, delay compensation and the persistent per-insert nodes are described in
[Mixer routing, sidechain and delay compensation (M10)](#mixer-routing-sidechain-and-delay-compensation-m10).

- `engine/engine.ts` is the facade (`EngineApi`); each job it delegates has its own file: `output-clock.ts` (the heard time,
  the start lead), `song-note-sink.ts` (song events held back by delay compensation), `project-mirror.ts` (a new project version applied to the
  graph), `channel-strip-sync.ts` and `scheduling-watch.ts` (its steps), `transport-model.ts` (what the transport plays), `launcher-link.ts` (the clip launcher on the transport),
  `scheduler-clock.ts` (the worker timer and the keep-up statistics), `note-preview.ts` and `sample-preview.ts` (live
  notes and the browser's audition), `live-capture.ts` (recording and live inputs), `live-meters.ts`, `test-clicks.ts`,
  `tempo-info.ts` (the tempo plugins see) and `port-set.ts`. Also `transport-driver.ts` (play, stop, seek, count-in, the
  scheduler clock's tick, the playhead and heard-time reads, the residency's position, the next beat),
  `offline-hooks.ts` (what an offline render calls instead of the clock: start, pump, end, prepare) and
  `output-stage.ts` (the master, preview and monitor buses, the safety limiter, the panic duck, the fade-out when an
  engine is replaced, the output visualizer tap; reachable as `Engine.output`).
- `engine/insert-strip.ts` has `InsertStrip` (the master uses it too), `engine/slot-chain.ts` `SlotChain` (the row of effect slots an insert and a rack branch both are), `engine/fx-slot-strip.ts` `FxSlotStrip` (with `fx-instance.ts`
  and, for the peak meters, `insert-meters.ts`); `engine/mixer-graph.ts` owns them. Every insert id has one persistent channel input (`Engine.insertInput(id)`): it feeds the insert while the
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
after dispose; tells the host when it falls asleep and wakes (see "Idle parking" under Mixer routing). Unconnected inputs arrive with zero channels → pass zero buffers. Effects use `channelCount: 2`,
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

**Render determinism.** Two offline renders of one project (same sample rate and chunk size, cold or warm sample cache)
are bit-identical (`test/browser/render-determinism.test.ts`). Three things guarantee it: generators and noisy kernels
use seeded RNGs (`Rng`, kit sounds seeded from their name, plugin noise from the channel's id); every sample is made
ready before the chunk that plays it (`prepareOffline`); and **nothing sums three or more signals through a plain
fan-in**. Chrome adds the inputs of a node in an order that changes from run to run, and float addition is not
associative, so a node with three audible inputs (overlapping drum voices, channels into an insert, inserts into the
master, the oscillators of a synth voice, the overlapping hits and clicks of the 808) renders differently by one float step each time. `OrderedMix`
(`src/sdk/ordered-mix.ts`) is the fix: on an offline context it puts the sources on a ladder of unity-gain stages with at
most two inputs each (two inputs add the same either way), in the order they were attached; on a live context it connects
directly, so playback costs nothing extra. `GraphVoices` uses it for its voices, `InsertBus` for `chIn` and `routeIn`
(`engine.insertInput(id)` returns the mix: attach to it, never connect to the bus node), and a plugin that sums its own
voices or oscillators should too. Left alone on purpose: inputs that are silent except one or two (the master's preview
and monitor buses, a slot's bypass/dry/wet gates), since adding exact zeros is order-free. Different chunk sizes can still
differ by a last bit, because which mix slot a voice takes depends on when finished voices were cleaned up.
**Where a route lands in the sum also has to be repeatable.** A mix adds its sources in slot order (`s0 + (s1 + (s2 + …))`), and
a source's slot is the lowest one free when it attaches. The delay compensation changes a route's `PadLink` when an effect on its
path reports its latency, and effects finish loading in whatever order the browser gets to them, so a link that built its
replacement before dropping the old path took a different slot each time: the huge project's 30 s render ended in one of two
hashes (one ulp apart, from sample 3,000, about two loads in three one way), in any length of render. A link switched in one
step now drops the old path first (a crossfading link in a live engine is not ordered and does not matter), so the replacement
takes the slot just freed and every link keeps the slot its creation gave it (`test/browser/render-determinism.test.ts`
changes the three links of a mix in every order, and renders the huge project eight times in a page).
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
  **Where the editor code lives.** The playlist and the piano roll each have a thin controller class
  (`playlist/controller.ts`, `piano-roll/controller.ts`: the window's handle, the events wired, the frame run) and one
  folder of modules that take a shared context (`playlist/control/`, `piano-roll/control/`): the services, the elements,
  the viewport, the mutable interaction state and the long-lived helpers. Each module does one job: drawing the layers
  (`layers.ts`, `overlay.ts`), one tool's pointer handling (`clip-drag.ts`, `pattern-draw.ts`, `cut-tools.ts`,
  `comp-swipe.ts`, `note-drag.ts`, `draw-tools.ts`, `note-tools.ts`...), the ruler and markers, the track headers or the
  piano keys and event lane, the follow, the viewport (`viewport-control.ts`), and `pointer.ts`, which only decides which
  tool a press belongs to. What both editors do the same way is in `timeline/`: `listeners.ts` (the cleanup list),
  `scrollbar.ts`, `wheel.ts`, `edge-scroll.ts`, `playhead-line.ts`, `viewport-saver.ts`, `selection-box.ts`. Their
  drawing is in plain files next to the controllers (`playlist/draw-clips.ts`, `lane-grid.ts`, `lane-headers.ts`,
  `ruler.ts`, `marker-flags.ts`, `take-use.ts`; `piano-roll/render.ts`). Frame-loop code in these modules is written
  to allocate nothing (a frame record filled in place, drawing functions bound once): keep it that way.
  "Play this" (`app/actions/transport.ts`; commands `transport.playPattern`, `transport.playFrom`,
  `transport.playRange`): the piano roll's and channel rack's ▶/■ (`transport/PlayPatternButton`), the browser's
  pattern menu and the playlist's clip, marker, empty-spot and ruler menus set the transport view (pattern + mode,
  or the loop region) and then play, so the toolbar's play button is never needed. The buttons subscribe to the
  engine's play/stop events and the view's mode and current pattern, never the playhead. Pattern bodies in playlist
  clips (`playlist/pattern-body.ts`) are built once per pattern and zoom as a path per velocity step, and blitted from a
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
    - Guided tours (`features/tours`, see "Help, tours and What's new"): eight tours on a demo song, each card
      highlighting the real control through `data-tour` / `data-window-type` / `data-menu` anchors, followed every frame.
      Help → Take the tour is the first of them.
    - The Help window and the Features page (`features/help-center`), the "Learn: …" rows of the action search and What's
      new (`features/whats-new`, opens once per version) are described in the same section.
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

## Touch (`src/ui/touch`, `sdk/ui/touch-assist.ts`, `features/keys-panel`, `features/touch`)

AGstudio works on touchscreens (tablets, Chromebooks, laptops with a touchscreen) in Chrome. Everything uses Pointer Events
and reacts to `pointerType: 'touch'` only: a mouse or pen gets exactly the handlers it always had, so the mouse tests did not
change. Three pieces:

- **Touch surfaces (canvas editors).** `touch/surface.ts` `attachTouchSurface(element, handlers, cleanups)` listens while
  *capturing*, ahead of the editor's own listeners on the same element, and asks `touch/recognizer.ts` (pure: no DOM, no
  timers; `recognizer.test.ts`) what the fingers mean. It sets `touch-action: none` and `data-touch-surface` on the element.
  - One finger: the verdict is `pass` and the editor sees the events as from a mouse (draw, move, select, erase: whatever the
    tool is). Nothing is delayed.
  - A second finger: `onMultiTouchStart` drops the first finger's drag through the editor's own `cancelDrag` (the one Esc
    uses: a gesture is cancelled, nothing is committed), and from then on the events of both fingers are swallowed
    (`stopImmediatePropagation`) until every finger is up. Two fingers pan; the horizontal separation zooms time, the vertical
    one the rows (track height, key height), both around the midpoint (`timeline/touch-view.ts` `applyTwoFingers`, the touch twin
    of `wheel.ts`, used by the playlist, the piano roll and the pitch editor). An axis zooms only once its separation changed by
    10 px and was at least 36 px wide, so a wobbly pan does not zoom. Fingers arrive one event at a time (one has moved while
    the other has not, which looks like a pinch), so the surface asks the recognizer for a frame once per animation frame
    (`flush`), when both have caught up. The frame object is reused: no allocation per move.
  - A finger that rests (500 ms, within 10 px): `longPress`, the right-click. The editor drops the press (`cancelDrag`) and
    opens its menu; the lift is swallowed. A real right-click deletes in the playlist and (without Select) in the piano roll, so
    a long press opens the clip's or note's menu instead (the playlist's ▾ menu, the piano roll's note menu, the empty-spot menu,
    the track menu on headers, the marker or ruler menu on the ruler).
  - Two taps within 320 ms and 32 px: a synthetic `dblclick` after the second tap's own pointer events (the order a mouse
    makes). The browser's own `dblclick` and `contextmenu` that follow a touch are dropped (an echo window of 1 s).
  - Where it is wired: playlist grid, ruler and headers (`playlist/control/touch.ts`), piano roll grid, ruler and event lane
    (`piano-roll/control/touch.ts`; the lane only takes the sideways part of a pan or pinch, its height is its value), pitch
    editor stage and ruler (`pitch-editor/controller.ts`). Automation clips are edited inside the playlist grid, so they follow
    it (points show on the selected clip; a long press on a point opens its menu).
- **Page-wide helpers** (`touch/global.ts`, installed once by `main.tsx` through `installTouch(services)`). For everything that is
  not a surface or a text field: a resting finger sends a `contextmenu` event to the element (menus that listen for it
  open), else shows the element's `data-hint` (`TOUCH_HINT_EVENT`, shown by `shell/hover-tip.ts` even with tooltips off: a
  touchscreen cannot hover), and the click that would follow the lift is dropped; two taps send a `dblclick` (knobs reset,
  window titles maximize). Controls that take a resting finger themselves carry `data-touch-own` (knobs, faders, number boxes,
  the DJ platter and overview, momentary DJ pads, the step grid, the Keys panel). `base.css` sets `touch-action: pan-x pan-y`
  on the page (no pinch or double-tap zoom, lists still scroll); sliders, steps and `data-touch-own` say `none`.
- **Fingers on controls** (`sdk/ui/touch-assist.ts` `TouchAssist`, public so plugin knobs get it). With one finger a control has
  a dead zone (6 px: a resting finger changes nothing), and two ways to go fine (a tenth as fast): a second finger put down
  anywhere (until it lifts), or the first finger resting 500 ms before it drags. A rest that lifts without a drag opens the
  control's menu (automation, controller link, reset). Used by `Knob`, the mixer's `Fader`, `DragNumber` and the DJ `Slider`.
  Each ignores events of other pointers once a drag runs, so a second finger on the same control cannot take it over.
  The step grid paints along a finger (`StepGrid` finds the step under the finger with `elementFromPoint`: a touch pointer is
  captured by the first step, so no `pointerover` reaches the others).

**Touch layout** (`touch/layout.ts`, pref `touchLayout`: `auto` | `on` | `off`, command `options.touchLayout` with an
`argsHint`, the View menu, Settings → Look, help and interface, AI `settings.touch_layout`). `auto` is on when
`matchMedia('(pointer: coarse)')` says the main pointer is a finger (a tablet; a touchscreen laptop keeps its trackpad as the
main pointer, so it is off until chosen). The result is `<html data-touch="on" | "off">`, nothing else: sizes are CSS, in
`touch/touch.css` (menu rows, text fields, the hit area of every `role="slider"` grown to 40 px with an invisible `::after`,
step squares) and in each feature's own module under `:global(:root[data-touch='on'])` (toolbar buttons, menu labels, window
title bars and resize handles, the PAT/SONG switch, editor toolbars, rack rows and steps, the action search rows (the
palette's scroll arithmetic reads `isTouchLayout()`), the Keys panel). `--ag-touch-target` is 40 px. A toolbar button
**Search** (touch layout only) opens the action search, whose shortcut needs a keyboard. Limits: step squares are 34 px tall
but still 17 px wide (the step geometry is shared with the graph and the mini roll; dragging across steps paints them), and
small buttons inside dense panels (mixer strip buttons, plugin windows) grow only where listed above.

**Keys panel** (window `keys`, command `view.keys`, `Alt+8`; `features/keys-panel`). A piano (three octaves, octave buttons)
and sixteen drum pads (keys 36 to 51, pad 1 bottom left, the Drum Pads instrument's keys), played with any number of fingers
(`use-touch-notes.ts`: one note per pointer id; a key held by two fingers stops with the last; a finger sliding across the
piano plays each key it reaches, the pads only play when touched). Notes go through `services.live.noteOn(key, velocity,
{ source: 'screen' }, event.timeStamp)`, the same path as the typing piano and MIDI, in the pointerdown handler itself.
Velocity (`prefs.keysVelocity`, command `keys.velocity`, AI `settings.keys_velocity`): from where the finger lands (lower on a
key, the middle of a pad: louder; `key-math.ts`, unit tested) or one fixed level (soft, medium, loud).

**Tests.** Unit: `recognizer.test.ts` (thresholds, timing, two-finger maths, reuse of the frame), `layout.test.ts`,
`keys-panel/key-math.test.ts`. Browser tests use **real touch input** (`test/helpers/touch.ts`: Chrome's DevTools
`Input.dispatchTouchEvent` through Vitest's `cdp()`, so the page gets genuine touch pointer events with implicit capture
and touch-action; for `touchEnd` the points listed are the ones that lift): `touch-playlist`, `touch-piano-roll`,
`touch-controls`, `touch-shell` (windows, menus, search, hints, layout, step painting, Keys), `touch-launcher`. A synthetic
`new PointerEvent(...)` cannot capture a pointer that does not exist, which is why the older mouse tests stay as they are.

## Help, tours and What's new (`features/tours`, `features/help-center`, `features/whats-new`, `app/demo-session.ts`, `app/demo-project.ts`)

AGstudio has far more features than a menu bar can show, so findability is a feature of its own. Four parts, all built from what the app has registered (nothing to keep in step by hand except the lists named below), and all tested.

### Guided tours (`features/tours`)

- **The engine.** A `Tour` (`tour-types.ts`) is an id, a title, a summary, minutes, an area, search keywords, the window types whose "?" offers it (`windows`) and `steps`. A `TourStep` has an `id`, a `target`, a `title`, a `body`, an optional `prepare(services)` that makes the target appear (opens the window) and an optional `tryIt` (a button that runs one command: only commands that open a window or pick a tool, a test checks; a tour never edits the song for you). `{key:command}` in a body becomes that command's shortcut on this computer.
- **Targets are plain strings** (`target.ts`): `tour:<name>` is `[data-tour="<name>"]` (the transport, the browser, the Studio button, the hint bar), `window:<type>` is `[data-window-type]`, `menu:<id>` is a label of the menu bar (`data-menu`) and `slot:<id>` a toolbar part (`data-slot`). Tours point at the menu label and say which entry to choose, instead of opening menus. A name that is not `[\w-]+` is refused, so a step can never break out of the selector. Prefer windows, menus and `data-tour` anchors over toolbar slots: slots move into the toolbar's "More" panel at narrow widths.
- **The card** (`TourOverlay.tsx`, an overlay) dims the page, highlights the target (`onFrame`, so it follows windows that move and resize, with no React commits) and places the card beside it with `placeBeside`. It is a labelled dialog (`aria-labelledby` the tour's name with "step n of m" and the step's title, `aria-describedby` its text, `aria-modal`). The first card takes the focus, so a screen reader says it as a dialog; later cards keep the focus on Next and are announced through the live region (`announce`: "Step 2 of 7: title. text"). Arrow keys and Escape work from anywhere (captured, with `holdModal` so shortcuts stand down), Tab stays inside the card, and when it ends the focus goes back to what had it (after a frame, because the restored windows may take it). In the **touch layout** the card is a full-width sheet at the bottom (at the top when the target is low) with `--ag-touch-target` buttons; a menu label that a narrow screen scrolls out of view is scrolled in once.
- **State** (`tour-state.ts`, a zustand store, not React): `startTour(services, idOrTour, { step?, demo? })`, `goToStep`, `endTour`. Starting a tour while one runs replaces it without restoring in between (never two demos).
- **The tours** (`data/*.ts`, `tour-list.ts`): `overview` (the old tour: browser, channel rack, transport, piano roll, playlist, mixer, Studio, more windows, help), `first-song` (sounds, beat, melody, song, play, mix, export), `record-vocal` (input, record, takes and comp, pitch, cleanup, align, effect chain, harmonies), `dj-mixing` (auto-mix, tweak and export, decks, controllers), `clip-launcher` (grid, fill, perform, record), `harmony-chords` (chord lane, Chords window, parts that fit, piano roll, harmonies, lyrics), `mix-master` (faders and groups, snapshots, meters, Maximizer, reference, balance) and `studio-mcp` (Studio button, chat, ask about a part, connect other apps, safety, new plugin). Every window type belongs to exactly one tour's `windows`, so every window's "?" offers its tour (`addWindowHelpLink`, below); a test fails for a new window with no tour.
- **Spotlights** (`spotlight.ts`): a one-card tour with `demo: false`, used by What's new's "Show me". It runs on the musician's own project and swaps nothing.
- **Commands**: `tour.start` (argument: a tour id; `argsHint` lists them, so Studio and MCP can start one: "show me how to record a vocal"), `tour.stop`, and the older `help.tour` (the overview). The Help menu has a **Guided tours** submenu.

### The demo song and "never lose work" (`app/demo-session.ts`, `app/demo-project.ts`)

Every tour of the list runs on a demo song, so each window has something to show (a beat, a bass and keys, two patterns on the playlist, a chord track in A minor, a reverb, a Maximizer and Limiter on the master). `createDemoProject(registry)` builds it from the same ops a musician's edits use (new ids each time; title "Tour demo (safe to discard)"). `services.demo` (`DemoSession`) swaps it in and out:

- `begin()` keeps everything about the open project: `History.snapshot()` (the project, its undo and redo steps, the saved cursor, whether it is dirty), `captureView` (windows, editor state, selection) and the file's name, handle and key. If the project has unsaved changes it first writes a **version** ("before a guided tour"), so even a crashed tab can bring it back from Versions. Then it loads the demo as an unsaved project with **no file handle**: Save can never overwrite the musician's file with the demo.
- `end()` calls `History.restore(snapshot)` (undo history included), `applyView` and puts the file state back. The tests check the project is `toBe` the same object, deep-equal and with the same `history.status()`, after every tour ended any way (Done, skip, Escape).
- **Anything that would replace the project meanwhile** (New, Open, Open recent, an import, a version restore, recovery) goes through `ProjectFiles.confirmReplace`, which first runs `setBeforeReplace`'s function: the demo ends and the musician's project is back, so "keep your changes?" is about their song, not the demo. The tour ends with it.
- **A reload or a crash mid-tour** brings back the musician's project, not the demo: the reload snapshot and the crash autosave (`app/persistence/session.ts`) read `services.demo.own` (the kept project, view and file link) while the demo is on screen. Closing the tab with the demo open asks about "unsaved changes" like any dirty project.
- A spotlight (`demo: false`) never touches the project.

### Help window and Features page (`features/help-center`)

- **Topics** (`help-topics.ts`, `collectHelpTopics(services)`): gathered when the window opens, so a feature that registers a window, a command or a tour is in Help without anyone editing a list. Categories: Tours, Lessons, Windows (the "?" text of every window: its intro and moves), Commands (every command with a hint, grouped by its own category, with its shortcut and a "Run it" button when it needs no argument), Shortcuts (by command category), Keyboard navigation (`a11y/keyboard-help-data.ts` plus the screen reader notes) and Touch and gestures (`touch/gestures.ts`). A topic has a button (start the tour, open the window, run the command).
- **Search** (`help-search.ts`) reuses the action search's ranking (`palette/search.ts`: every word must match, the title counts most, newcomer synonyms such as bpm → tempo): a topic is an `ActionEntry` whose keywords are its keywords and its moves. `ActionEntry.boost` puts a tour ahead of a window page when both match equally.
- **`HelpWindow`** (window type `help`, command `help.open`, argument: words, or `{ query, topic, category }`; topic ids are `window:mixer`, `tour:first-song`, `cmd:file.save`, `shortcuts:Transport`…) lists categories as buttons with counts, the results on the left and the topic with its moves on the right; opened again with other props it starts over from them. Empty search results say what to try and hand the words to the action search (which hands them to Studio).
- **"Learn: …" in the action search** (`addActionProvider('help.learn')`): a row for every tour, lesson and window with help; "learn", "tutorial", "how to" and the tour's own keywords find them, and a tour starts, a lesson starts, a window row opens its page in Help.
- **Every window's "?"** (`workspace/window-help.ts`): `addWindowHelpLink(type, link)` puts buttons under the how-to. The tours feature adds "Take the tour: …" for the tour listing the type; the help centre adds "More in Help" for every window (`ALL_WINDOWS`). `FloatingWindow` renders them.
- **Features page** (`feature-map.ts`, window type `features`, command `help.features`): `buildFeatureMap(services)` groups the registered windows, commands (with the menu each one is in, found by walking the menus, and its shortcut) and tours into areas (`AREAS`: which window types, tours and command categories each area names). Anything no area names lands in "More", so the page is complete before anyone files it, and `help-center.test.ts` fails while "More" is not empty, so a new window or command category gets an area. Each entry has a button that starts it (a command that needs an argument has none: it is used from a menu, a key or Studio).

### What's new (`features/whats-new`)

- `WHATS_NEW` (`entries.ts`) is the list, newest first: a title, two sentences, a small picture (`Illustrations.tsx`: inline SVG in theme colours, some moving a little unless "Less motion" is on; no files) and a `show` step. **Show me** closes the panel and runs a spotlight on that step (opens the window or points at the menu).
- `WHATS_NEW_VERSION` is bumped when a new batch is added. `showWhatsNewAfterUpdate` (called by `main.tsx` after the welcome decision, never over crash recovery) opens the panel once for someone who has used AGstudio before (`welcomeSeen`) and has not seen this version (`prefs.whatsNewSeen`); it records the version when the panel opens, so it never opens by itself twice, and it counts a first-time user as up to date (they have the welcome screen). Help → What's new (`help.whatsNew`) opens it any time.

### Tests

`tours.test.ts` (unit: the lists, targets parse, commands named exist, tour buttons only open windows or pick tools, every window has one tour, every tour run through ends with the project `toBe` the original), `demo-session.test.ts`, `help-center.test.ts` (topics, search finds the right topic for a job, "Learn:" rows, every window's "?" links, feature map completeness), `whats-new.test.ts` (once per version), and `test/browser/tours.test.ts` (in the real shell: every step of every tour and every "Show me" has a target that is present, visible and on screen with the highlight around it; the card is a labelled dialog, announced, keyboard-driven, focus kept and returned; the touch layout; the project deep-equal after every ending; the reload snapshot holds the musician's project mid-tour; Help, the "?" links, Features and the "Learn:" rows work). `test/unit/ai-coverage.test.ts` covers the new commands (`tour.start`, `tour.stop`, `help.open`, `help.features`, `help.whatsNew`: all with hints, the ones taking an argument with `argsHint`) and the new windows (`help` and `features` are in `OPEN_WINDOWS`, so Studio can open them).

## Accessibility (`src/ui/a11y`, `features/accessibility`, the `--ag-scale`, `data-contrast`, `data-motion` and `data-palette` page attributes)

AGstudio works with the keyboard alone and with a screen reader, and has a look for low vision and colour blindness, without
changing anything for people who use none of it. Everything is plain DOM and the existing stores: no new dependency.

- **Tab stops.** Every `<button>` is a native Tab stop (nothing carries `tabIndex={-1}` any more). Mouse users never focus the
  toolbar buttons (their pointer-down is cancelled, as before), and `ui/keyboard.ts` lets Space and Enter press a control that
  the keyboard focused (`:focus-visible` on a button, tab, menu item, switch...) instead of running a shortcut, so Space still
  means play/stop for a mouse user and "press" for a keyboard user. A mouse click leaves nothing `:focus-visible`.
- **Roving groups** (`a11y/roving.ts`). A container with `data-roving` (`horizontal`, `vertical` or `grid`) is one Tab stop:
  its controls get `tabindex` 0 (the active one) or -1, and the arrow keys, Home and End move inside it (`rovingKeyDown`, called
  first by the global key handler). One MutationObserver on the page keeps the stops right as React adds, removes and disables
  controls, so a group is only markup: `<div role="toolbar" aria-label="…" data-roving>`. Fields that use the arrows themselves
  (text boxes, selects, range inputs, sliders, spin buttons) are never taken over.
- **Moving between parts of the screen** (`features/accessibility/panes.ts`). Ctrl+F6 and Ctrl+Shift+F6 (Alt+9 and
  Alt+Shift+9 where F-keys need Fn) go through the menu bar, the transport, the browser panel and every open window in the
  order they were opened; F6 itself stays the channel rack, as in FL Studio. Alt+0 "Where am I?" says the pane, the front
  window, the selected sound and pattern and the transport state. A window is a `role="dialog"` named by its title
  (`aria-modal` stays off: it does not block the rest) and is focusable itself; focus entering a window makes it the focused
  window (the shortcuts of that window apply) and Esc on its frame or title bar closes it (inside, Esc belongs to the
  content). `features/accessibility/focus-follow.ts` moves the focus into a window that a key press opened and onto another
  window when the focused one closes, but only after keyboard input (`a11y/modality.ts` tracks the last input), so a mouse
  user's focus is never moved.
- **The live region** (`a11y/announce.ts`). `announce(text, 'polite' | 'assertive')` writes into one of two hidden elements
  (`role="status"` and `role="alert"`); the same sentence twice in a row still speaks (an invisible mark alternates). The
  announcers in `features/accessibility/announcers.ts` listen to stores that exist anyway: play and stop (the engine), record
  armed / on / off, PAT and SONG, every toast (errors are assertive: finished exports, saves and failures all come through toasts),
  the Studio's thinking and replies (long ones are cut at a word), plus the settings commands and the editors' keyboard cursors.
  Nothing runs per frame: playing makes no React commits (`test/browser/a11y-shell.test.ts` counts them).
- **Interface size** (Settings → Accessibility, `prefs.uiScale`, 90 to 150 percent; commands `options.uiScale`,
  `options.uiScaleUp/Down/Reset`). `a11y/preferences.ts` sets `--ag-scale` on `<html>`; every `font-size` in the CSS is
  `calc(Npx * var(--ag-scale, 1))` (a mechanical rewrite: at 100 % the value is the old one), the font tokens and the toolbar and
  title-bar heights scale with it, and canvas text goes through `fontPx(size)` (`timeline/canvas.ts`; a row-limited size is
  `Math.min(fontPx(10), rowHeight - 4)`), so rulers, notes, clip titles, meters and lanes follow. Heights of other fixed-size
  controls are not scaled (they are shared with JavaScript row maths), so at 150 % the dense rows are tight but never clipped
  in the checked windows.
- **High contrast.** Two themes (`contrast`: black and white with a yellow accent, `contrast-light`: white and black with a blue
  one; the accent setting is ignored there so the checked colours are the ones shown), and `prefs.highContrast` (`auto` follows
  the system's `prefers-contrast: more`) which sets `data-contrast="more"` on any theme: quiet text and lines move toward the
  main text colour and the focus ring gets thicker. `@media (forced-colors: active)` keeps the focus ring and pressed states.
  The focus ring is `outline: var(--ag-focus-width) solid var(--ag-focus)` for every `:focus-visible`; `--ag-cursor` is the
  keyboard cursor of the canvas editors.
- **Less motion.** `prefs.reduceMotion` (`auto` follows `prefers-reduced-motion`) sets `data-motion="reduced"` (or `full`):
  transitions and animations are off in every stylesheet, the karaoke lyrics scroll jumps, and the playlist's and piano
  roll's follow-playhead never glides or slides: the smooth style turns into the page style and a page turn lands in one
  frame (`FollowFrame.reducedMotion`, `timeline/follow.ts`).
- **Colour-blind safe colours** (`prefs.colorSafe`, `data-palette="safe"`). Meter low/mid/high, the lit LED, notes and the
  danger colour switch to the Okabe-Ito blue, yellow and orange family (darker versions on the light themes); on top, wherever
  colour carried a state the canvas editors add a shape: the mixer meter gets notches at -18 and -6 dB and a triangle while
  clipping, playlist clips get a pattern badge per hue family (`a11y/color-patterns.ts`: eight patterns, so clips of different
  colours differ by more than colour) and diagonal stripes when muted, selected notes get a heavy outline, a selected chord or
  lyric word a heavy outline and a corner triangle (`a11y/selection-mark.ts`), and the lyrics' sung and current words are
  underlined. `theme.colorSafe` (from `readTheme()`) is the flag canvas code reads.
- **Settings, AI and MCP.** The four settings are prefs, commands (menu Options → Accessibility, the action search) and fields of
  the `settings` action (`interface_size_percent`, `high_contrast`, `reduce_motion`, `color_blind_safe`, also read back by
  `get_settings`), so Studio and MCP clients set them like the window does. The two theme ids are in `options.theme`.
- **Keyboard help.** Help → Keyboard navigation (command `help.keyboard`, window `keyboard-help`) and the end of the
  Shortcuts window list every navigation key and what a screen reader says (`a11y/keyboard-help-data.ts`, the editors'
  keys in `keyboard-help-editors.ts`); `docs/shortcuts.md` carries the same list (generated by `test/unit/shortcuts-doc.test.ts`).
- **Keyboard cursor of the canvas editors** (`ui/timeline/key-cursor/`). The playlist, piano roll and pitch editor each have one
  Tab stop (their grid: `role="application"`, a label, a hidden `aria-describedby` summary of the notes or clips and the cursor, a
  `:focus-visible` frame) and a cursor that lives in the controller context (`state.keyboard`), never in React: it moves by the snap
  step, a track, a key, a bar or an octave, selects and extends, adds, deletes, moves and resizes through the same History calls as
  the mouse (a held key is one undo step through `mergeKey`), and is drawn on the overlay layer from `--ag-cursor` as a dashed
  box with solid corner ticks (`drawKeyCursor`), only while the grid has the focus from the keyboard. Every move is spoken
  through `CoalescedAnnouncer` (one sentence per 120 ms, newest wins; `describe.ts` words them: "C6, bar 1 beat 2, note 1/16,
  velocity 102, selected"), `?` says everything at once, and the view scrolls to the cursor in one jump (`revealTicks`,
  `revealRow`), never a glide. `router.ts` hands the keys to the editor ahead of `ui/keyboard.ts` (each feature's `register()` starts
  it, which runs before `installKeyboard`; only a stack that has the keyboard focus gets keys, and a click or touch inside it
  hands them back to the window's own shortcuts until the next Tab). Space stays play/stop and Enter selects. The pitch editor's
  cursor goes note to note (it has no snap grid). Files per editor: `control/key-cursor.ts`, `key-edit.ts`, `keys.ts` (playlist
  and piano roll, plus `key-automation.ts` for automation points), `pitch-editor/keyboard.ts` and `keyboard-text.ts`. Tests:
  `test/browser/keyboard-piano-roll.test.ts` (21), `keyboard-playlist.test.ts` (22), `keyboard-pitch-editor.test.ts` (11), unit tests in
  `key-cursor/key-cursor.test.ts`.
- **Controls, menus and dialogs, per window.** The rest of the shared pieces: `a11y/own-keys.ts` (a focused slider, spin button,
  list box, tab strip or menu keeps the arrows, Page keys, Home and End; window shortcuts stand aside: `focusOwnsKey` in
  `keyboard.ts`), `sdk/ui/slider-keys.ts` (Knob, Fader and the DJ sliders are focusable sliders: arrows 1 %, Shift 0.1 %, Page 10 %,
  Home and End the ends, Delete resets, `aria-valuetext` with units; plugin authors can use `sliderKeyTarget`), DragNumber as a spin
  button (arrows, Page, Home, End; a digit, Enter or F2 starts typing), `controls/dialog-focus.ts` (`useDialogFocus`: focus goes in,
  Tab stays inside, Esc closes, focus returns to the opener; every modal is a labelled `dialog` or `alertdialog`), menus (context
  menus and the menu bar's dropdowns take the focus when opened from the keyboard, arrows, Home, End, letters and ← → between
  menus; checkable entries are `menuitemcheckbox`, swatches `menuitemradio`; Tab or Esc closes and returns focus; Shift+F10 opens
  a focused thing's menu) and the action search as a combobox with a listbox (`aria-activedescendant`). Roving also treats any
  `role="toolbar"`, `tablist` or `radiogroup` as a group, skips controls that take no room and menus opened inside a group, and
  listens in the bubble phase too so arrows work inside dialogs. Per window: the menu bar is a `menubar` and one Tab stop; the
  transport, studio and project, windows and history groups are roving toolbars (the whole toolbar is 5 Tab stops); the channel
  rack's mutes, names and steps are one grid ("Kick step 5", `aria-pressed`; Space or Enter toggles, Shift+Space solos, Enter on a
  name selects, again opens the editor); the mixer's strips are named groups whose buttons are one grid (Enter on a name selects,
  again or F2 renames, Shift+Space solos); the clip launcher's pads are one grid named like "Scene 2, track 3, Drums, playing"
  (Enter or Space launches); the DJ decks' overview seeks with the arrows and each deck's groups are toolbars; the sample list is a
  list box with an active row; each Browser section's list is one vertical stop (88 Tab stops became 14); plugin windows have
  labelled sections, a preset toolbar and slider knobs; the Studio conversation is a `log` that announces additions.
- **Tests.** `test/browser/a11y-contrast.test.ts` computes the contrast of 34 token pairs in all eight themes, with every
  accent, with more contrast and with the safe palette (text 4.5:1, marks such as the focus ring, notes, meters and LEDs 3:1,
  the High contrast themes 7:1 and 4.5:1) from the resolved CSS, and simulates protanopia, deuteranopia and tritanopia for
  the safe meter, note and light colours; `a11y-color-safe.test.ts` (patterns and selection marks), `a11y-shell.test.ts` (live
  region, pane cycling, window dialogs, focus following, the Space rule, settings reaching the page, no commits while
  playing), `a11y-audit.test.ts` (names, roles, tab order and focus rings of every window, menu and dialog),
  `keyboard-playlist.test.ts` and `keyboard-piano-roll.test.ts` (the keyboard cursors), `sheet-music.test.ts` (the Sheet music window's cursor and
  note entry, see "Sheet music"), unit tests for the pure parts.
  Limits: the interface size does not scale fixed-height controls; the DJ decks' own meters and the plugin windows' custom
  canvases keep their colours and sizes; screen reader behaviour is checked by the tree it gets (roles, names, values, live
  text), not with a real reader.

## Persistence (`src/app/persistence`, `src/platform`)

- `.agproj` = zip (fflate, `core/io/project-file.ts`): `meta.json` (`{ format: 1, appVersion, savedAt }`),
  `project.json` and `view.json` (deflate 6), `samples/<sha256>.<ext>` (original bytes, stored uncompressed). Plugin code
  is never embedded; plugins are referenced by id + version. Reading migrates (`core/schema/migrate.ts`) and repairs (`core/schema/repair/`, one file per part of the project) and
  throws `ProjectFileError` with a user-facing message; a damaged `meta.json`/`view.json` is tolerated and reported in
  `repairs`. Opening verifies each embedded sample against its hash before it enters the store. Save writes the zip
  a piece at a time and Open reads it an entry at a time (see [Long audio](#long-audio-dj-mode-foundations)).
- Runtime sample store: OPFS `blobs/<sha256>.<ext>` (`platform/opfs.ts`), layered over memory when OPFS is missing or
  full (`app/persistence/blob-store.ts`); decoded per `(hash, sampleRate)` into the shared sample cache (memory budget,
  see [Long audio](#long-audio-dj-mode-foundations)); undo removes references, not blobs; unused blobs are removed by the
  safe clean-up described under [Clean-up of unused audio](#clean-up-of-unused-audio). `decodeAudioData` resamples and detaches its input; Chrome
  rejects AIFF, so the engine's decoder has the PCM parser in `core/io/wav-decode.ts` (which also reads `smpl` and AIFF
  `INST`/`MARK` loop/root data) turn it into float WAV in a Worker (`engine/pcm.worker.ts`).
- Save/Open (`app/project-files.ts`, `services.files`): `showSaveFilePicker`/`showOpenFilePicker`, keep the handle for
  Cmd+S, `createWritable()` swaps atomically. Fallback: `<input type=file>` / `<a download>`. Pickers need a recent
  user gesture, so a command shows its picker before any slow work, and the unsaved-changes prompt is an in-app dialog
  (its button click is a fresh gesture). Handles of recent files live in IndexedDB (`persistence/recent-files.ts`, the 40 newest: the File menu shows eight under Open recent, the Projects window all of them);
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
  listing capped at 30,000 files (see [Sample browser](#sample-browser-srccoresamples-srcappsamples-srcuifeaturessamples)). Click previews (`engine.previewAudio(bytes)`, decoded once per content into the sample
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
  (`dj-library`); and **every other value in the IndexedDB `kv` store** (this is how versions keep their samples: see Versions below) except `gc:*` and the cached track analyses
  (`dj-analysis:*` and `pitch-analysis:*`, which are keyed by hash but are not a use; both go with the blob). Recent files hold handles, never bytes, so they pin
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

## Versions and the project browser (`core/versions`, `core/projects`, `app/versions`, `app/projects`, `ui/features/versions`, `ui/features/projects`)

Never lose work, and find your projects. A **version** is the whole project (and its window layout) at one moment, kept in this
browser; the **project list** shows every project the app remembers with what a card needs (name, tempo, key, length, a picture of
the arrangement). Autosave (crash recovery) is unchanged: versions are the history, autosave is the safety net for the newest edit.

### What a version is (`core/versions/types.ts`, `app/versions/store.ts`, `platform/opfs-versions.ts`)

- **Two things, written in this order**: a thin project file in OPFS (`versions/<projectId>/<versionId>.agver`: the
  `projectFileParts` zip with no sample bytes, so reading one back goes through `readProjectFile` and an older schema is
  migrated and repaired like any opened file) and a small record in the IndexedDB `kv` store (`version:<projectId>:<versionId>`,
  `VersionRecord`): when, why (`reason`), the musician's `name`, `pinned`, `size`, `contentHash` (SHA-256 of `project.json`), the
  project's title, `facts` (bars, seconds, BPM, key, clips, patterns, channels) and what changed since the version before
  (`changes`, `summary`). Removal goes the other way, file then record. `VersionStore.reconcile()` (run a few seconds after start)
  drops a record whose file is gone and **adopts** a file with no record (rebuilding its record from the file), so an interrupted
  save or delete never leaves a version that looks fine and cannot be opened, nor one that is lost.
- **Deduplicated**: the same song again (same `contentHash` as the newest version) is not a new version; asking to *name* an
  unchanged song names and pins the newest one instead. Samples are never copied (they stay in the blob store, shared by hash
  with the open project, autosaves and every other version). The project JSON compresses about 6 to 8 times: the 113-bar stacked
  test song is 95 KB of JSON and 16.6 KB as a version (eleven versions of it, each after a small edit: 183 KB); a 10,000-note
  pattern is 770 KB and 93 KB (made in 46 ms on the main thread, or in the zip Worker). Deltas between versions were left out on
  purpose: a version must stay readable when its neighbours are pruned, retention bounds the count (below), and the gain would be a
  small multiple of a few hundred KB per project.
- **Storage clean-up counts versions as references.** The record holds `hashes`, every 64-hex run in the project and view
  (`collectHashes`, the same finder the clean-up uses), and the clean-up already treats "every other value in the IndexedDB `kv`
  store" as a use, so a sample only an old version uses is kept for as long as the version exists. Deleting or pruning the
  version removes the reference; the sample then goes like any other unused audio, after the usual 7-day grace
  (`app/versions/gc.test.ts` runs the collector on fakes). Nothing in the collector changed.

### When a version is made (`app/versions/service.ts`, `VersionService`, `services.versions`)

`services.versions.start()` (called from `ui/main.tsx`) listens; every write is queued one at a time and never rejects (a failure is
reported once). What is kept is captured synchronously (Immer makes the project a free snapshot), the writing happens in the background.
- **On save** (`files.onSaved`) and **on close** (`pagehide`, compressed on the calling thread because a Worker may never answer;
  best effort, the crash autosave still covers it): only if the project changed since the last version (`baseline`).
- **After minutes of editing** (default 10, Versions window: 2 to 30): counted from the first edit since the last version
  (`checkTimer`, looked at every 30 s).
- **Before big changes**: `beforeBigChange(kind, note)` from `applyAnswer` (every Studio and MCP answer: `before-ai`), `developSong`
  (`before-arrange`), `tidyNow` (`before-tidy`) and `convertToMidi` (`before-convert`), and a generic net for any single edit of 150
  or more patches (`before-big`, from the change's `prev`, at most one per 2 minutes). The state *before* the change is what is kept.
- **On request**: `saveNamed(name)` (File → Save a version…, `versions.save`): named, pinned, kept forever.
- **Before a restore**: the project as it is now (`before-restore`), so even a restore regretted past the undo history loses nothing.
- The switch and the interval are `VersionSettings` (localStorage `agstudio:versions-settings`, not a project setting, not in prefs).

### Retention (`core/versions/retention.ts`, pure)

`planRetention(versions, now, policy, utcOffsetMinutes)` returns the ids to delete: everything younger than a day stays; from a day
to a week the newest of each clock hour; from a week to a month the newest of each calendar day (in the musician's time zone); older
goes; **pinned versions and the newest version of a project never go**; at most 400 versions that are not pinned. Run after every new
version and once at start (`VersionStore.prune`).

### What changed (`core/versions/diff.ts`)

`describeProjectChanges(before, after, plugins)` gives `parts` (short phrases for the timeline, in a fixed order: tempo, key,
patterns, clips, notes, channels, mixer, samples, other) and `lines` (every difference as a sentence). The mixer's sentences come
from `core/snapshots/diff.ts` (`diffMixerStates`, on the tracks and effects both states have; added and removed tracks and effects are
said by `diff.ts`), so "Kick: fader −14.0 dB → −1.9 dB" reads the same here and in the Mix snapshots window. Branches that are the same
object in both projects are skipped without a look. `summarizeChanges` joins the first four phrases and counts the rest.

### Restore, preview, copy (`core/ops/restore.ts`, `app/versions/use.ts`, `app/versions/preview.ts`)

- **Restore** is one `history.transact('Restore version “name”')`: `restoreProject(draft, base, target)` merges `target` into the draft
  key by key, so objects that did not change stay the very same objects (a small undo entry, a small engine reconcile), and the
  project keeps its own `projectId`. The result is deep-equal to the version; undo brings the old state back exactly. A version of
  another project cannot be restored into the open one.
- **Preview** renders the first 20 s of the version offline at 32 kHz (`renderOffline` with the version's own project, the open
  project untouched) and plays the WAV on the audition bus (`engine.previewAudio`); Stop is `engine.stopPreview()`.
- **Open as a copy** opens a version as a new unsaved project (new `projectId`, no file, dirty). **Open** on a project that has versions
  and no file opens its newest version with its own id, so its history carries on.

### Project cards and the list (`core/projects/list.ts`, `app/projects/catalog.ts`, `service.ts`)

- A **card** (`kv` key `project-card:<projectId>`, `ProjectCard`) holds name, `fileKey`, last opened / changed, `facts`, a **thumbnail**
  (`core/versions/thumbnail.ts`: the playlist cut into 96 columns, one row per track with clips, at most 12 rows, as a few numbers)
  and the musician's `pinned` / `removed`. It is written when a project is opened, saved or given a version, and the open project's card is
  always shown with the song as it is now. The **drawing** is `thumbnailRects`, plain geometry in whole pixels, the same for the same
  input; `ProjectThumbnail` only paints it at its card's width in the theme's colours.
- `mergeProjectList({ cards, recents, autosaves, versions })` makes one row per project from what the app already remembers: the remembered
  file handles (`persistence/recent-files`, now 40 of them), unsaved autosaves, and projects that have versions. A project is listed once
  however many places know it; a clean autosave of a filed project is not listed; a removed card hides it (its file, autosaves and
  versions are never touched). Autosaves from before cards existed get a card the first time the list is read (the newest few at a time,
  with the autosave's own times), so they show their numbers and picture too. `sortProjects` (pinned first, then last opened / last changed
  / name / length / tempo, ties by name then id) and `filterProjects` (every word of name, key or "128 bpm") are pure.
- A row opens from where it lives: a file (`files.openRecent`), an autosave (the recovery read), or its newest version. Open a copy:
  `files.openRecentAsCopy` for a file, `versions.openAsCopy` otherwise.

### UI

- **Versions** (View menu, File → Versions…, ⌥⇧V; window type `versions`): "Save a version…", the switch and interval, the timeline grouped
  by day (what, when, why, what changed), per row Listen / Restore (Open copy for another project's versions) / ⋯ (open as a copy,
  rename, keep forever, delete; deleting a kept one asks), "What changed since then" (computed on demand against the open song), and a
  footer with the versions and bytes of this project and of all projects and the retention rule. It says what to do when empty.
- **Projects** (File → Projects…, ⌥⇧O; window type `projects`; the welcome page links to it): search, sort, cards with the picture,
  tempo, key, length, where it is kept, when it was opened, badges (open now, unsaved changes, N versions), Open / Open a copy /
  Versions / Remove, a pin, and the same in the right-click menu. File → **Open recent** is a submenu of the newest files plus "All projects…".

### AI and MCP

Commands (so Studio's `command` action and MCP `run_command` have them): `versions.save` (optional name), `versions.restore`,
`versions.openCopy` and `projects.open` (each by name; `gesture: true`, so the musician confirms with one click: they replace the
song), `versions.keep` (pin). Read tools: `get_versions` (the open project's versions with what changed, size, kept forever, whether save
points are automatic, the storage they use) and `get_recent_projects` (tempo, key, length, versions, pinned, unsaved work). A read tool
may declare `prepare()`: MCP awaits it so the answer is read from storage just now; Studio's look-ups use the cache the service refreshes
after every change. Both windows are in `OPEN_WINDOWS`.

### Tests

`core/versions/*.test.ts` (retention math, diff text, thumbnail geometry and determinism, time words), `core/projects/list.test.ts`
(merging, ordering, search), `core/ops/restore.test.ts` (exact restore, undo, shared objects), `app/versions/store.test.ts` (dedupe,
what changed, prune, reconcile), `service.test.ts` (save points at the right moments on a fake clock, restore and its safety version,
copy, find), `gc.test.ts` (a sample kept by a version, freed after it is deleted and the grace passes), `app/projects/service.test.ts`
(autosave cards, ordering, pin, remove, open), `ui/features/versions/commands.test.ts` (commands and read tools),
`app/versions/versions.browser.test.ts` (real OPFS and the Worker compressor), `ProjectThumbnail.browser.test.tsx` (the same pixels
every time), `test/browser/versions-ui.test.ts` (the windows in the real React shell). Crash recovery is `app/persistence/*`, unchanged.

### Limits

Versions are per browser profile (not synced, not in the `.agproj`; "Save as" a project to take its state with you). Preview plays the
first 20 s only. A project that is only a recent file and was never opened since cards existed has no tempo or picture until it is
opened once. The Settings → Storage table does not list versions yet (the Versions window shows their size). A restore replaces the
project's content, not the window layout.

## Sample browser (`src/core/samples`, `src/app/samples`, `src/ui/features/samples`)

Your sample folders (the File System Access folders of `persistence/sample-folders.ts`) as a searchable library: every
file is analyzed once (what it is, a loop's tempo and bars, the key or note, loudness, brightness), the results are kept,
and the window finds, auditions and places sounds. View → Sample browser (Alt+B); the browser panel's "Sample folders"
section lists the folders and opens it (folders under 300 files are still listed there as a tree).

### Analysis (`core/samples`, pure, no DOM; `analyzeSample(channels, rate, { path })` in `analyze.ts`)

- **Measurements** (`features.ts`, ~3.5 ms per short file): a peak envelope (5 ms blocks, a running maximum so a low note's
  ripple isn't decay: onset, attack, time to fall 20/40/60 dB, audible length, ring after 0.3 s, level), the power
  spectrum of 2048-point frames over the first 0.45 s from the onset (six bands: < 90, 90–250, 250–1000, 1–4 k, 4–10 k, > 10 kHz;
  centroid, 85 % roll-off, flatness), bursts in the first 50 ms (a clap stutters), and the pitch of the body with the
  voice analyzer's YIN (`core/voice/pitch.ts`: median note, share of audible frames pitched, glide down from the first
  frames, spread).
- **One-shot or loop** (`analyze.ts`): files over 60 s are `long` (header only). From 1 s up, a file with ≥ 5 hits
  (`findOnsets`: 9 dB rises of a peak envelope or of its high-passed copy, against the loudest moment, so a held 808's ripple
  is no hit) is run through the transient tempo detector (`core/audio/transients.detectTempo`, which snaps to whole bars);
  it is a loop when its length is 0.5, 1, 2, 4… 32 bars at that tempo (or half or double it: a drum-and-bass loop read at 87
  asks the DJ beat tracker, which knows where the drums sit, and becomes 174). A name that says "loop" (≥ 1.5 s) or "one
  shot" decides it. Loops get tempo, bars, `loopKind` (drums / bass / melodic) and a key from the DJ chromagram
  (`core/dj/chroma`, `estimateKey`; shown only at confidence ≥ 0.35, so a drum loop with a tuned kick has none).
- **Category** (`classify.ts`): a score 0..1 per category (kick, snare, clap, hat, open hat, cymbal, tom, perc, 808 / bass,
  fx, vocal, tonal) from soft ramps over the measurements (a hat is all top and falls 40 dB within 0.15 s, an open hat
  within ~1 s, a cymbal later; a kick is low, under ~75 Hz and gliding, an 808 is the same ringing on; a clap stutters; a
  snare has a body and a top; a tom is pitched 80–400 Hz with a glide; a tonal note sustains steadily; a sung vowel
  wobbles). The best score is the category (nothing ≥ 0.25: none), the confidence is the score held back by the runner-up's.
  **File names** (`names.ts`: "Kick_03", "HH open", folders such as "Snares", "128 bpm", "Am", "C#1") nudge it: the name
  agreeing makes the answer surer and decides between categories the sound can't separate (a "Shaker" that looks like a
  hat), while a clear sound a name contradicts (a snare named "Kick") stays what it sounds like. `basis` says which.
  A pitched one-shot gets its note (`midi`, `root`) from the pitch, unless the file declares one (a WAV `smpl` unity note or an AIFF
  base note, read by `decodePcm`), which wins for the pitched categories (not for hats, snares or claps).
- **Fingerprint** (`similarity.ts`): 13 numbers in 0..1 (brightness, six bands, decay, pitched share, attack, noisiness,
  pitch, stutter) stored with the analysis; "similar sounds" is a weighted Euclidean distance over the same kind of file, with
  a penalty for another category (`similarTo`).
- **Measured** (synthetic corpus, `test/helpers/sample-corpus.ts`: the engine's 11 kit sounds and 35 genre-kit pieces, the Drum
  Pads' 18 built-in sounds, and randomized hand-made kicks, snares, claps, hats, cymbals, toms, 808s, notes, risers; the
  thresholds were tuned on it, so read the numbers as consistency, not as a promise about every sample pack). The "clear"
  cases are the ones a person would not argue about: **100 %** of 182 at 44.1 kHz and of 300 more from a fresh seed, 100 % at
  22.05 kHz, 99.2 % at 48 kHz, 98.4 % at 96 kHz, 100 % with the level 24 dB down, with a −66 dBFS noise floor and with a DC
  offset, 99.5 % with 0.3 s of silence in front (the misses are one borderline lo-fi snare that stutters like a clap, and a
  noisy snare at 96 kHz read as perc); `sample-classification.test.ts` asserts ≥ 90 %. The unclear ones (a shaker that is a
  hat, a conga that is a tom, a rumbling impact that is an 808, a sung vowel that may be a synth) are 22 of 26 right and not
  counted. Notes are within half a semitone on tonal sounds and 808s. Loops (`renderTestSong`, 12 styles × drums / drums and
  bass / everything): tempo and bars right in 33 of 36 (91.7 %; asserted ≥ 90 %); the three misses are one 75 BPM pattern read
  at double time (150 BPM, 4 bars: the octave ambiguity of slow loops, which the window's ½× 2× filter and the preview's half/double
  rule absorb); the key of 16 chord loops (8 tonics, major and minor) is exact 16 of 16 (asserted: the key or its relative
  in ≥ 80 %). Speed: ~280 files/s on one core in Node (CPU time, short one-shots), **1,340 files/s** through the Worker pool (4
  Workers, headless Chrome, 1,500 in-memory WAVs, on a laptop loaded with other work: `test/browser/sample-analysis.test.ts`
  prints it); a real folder is slower by the time the browser takes to hand over each file.

### Running it (`app/samples`)

- `SampleBrowser` (`browser.ts`, `services.sampleBrowser`, started by the feature): follows the `sampleFolders` store, makes a
  row per file (`BrowserRow`: id `<folder key>:<path>`, name, folder, path, handle, `analysis`, state, favorite, tags,
  last used), shows cached analyses at once, then reads each file's size and time in batches of 48 and checks them against
  the cache (`core/samples/cache.ts`: path, size, modification time and `SAMPLE_ANALYSIS_VERSION` must all match; a hash of
  the audio is never used or stored), and queues the rest. Results are applied to the rows in batches every 200 ms (one
  store update per batch, so 5,000 files make a few dozen React renders, not 5,000); progress is `done / total` and files per second.
- Files are read and analyzed in a pool of Workers (`runner.ts`, `analysis.worker.ts`; `min(4, cores − 2)`, stopped 5 s after
  the last job): `read.ts` parses WAV and AIFF (`decodePcm`, only as much of a big file as the first 32 s need), FLAC
  (`decodeFlac`) and skips songs over 60 s by their header; MP3, OGG, M4A and unusual WAVs come back as "needs decode", the
  main thread decodes them with `decodeAudio` at 44.1 kHz (the browser's decoder runs off the main thread) and sends the
  audio back to the Worker. Without Workers (Node tests) the same code runs inline.
- **Cache and storage rules**: one IndexedDB `kv` record per folder, `sample-analysis:<folder key>` (`{ version, files: { path:
  [size, mtime, analysis] } }`, saved at most every 4 s while it grows and when the run ends; entries of removed files are
  pruned, a removed folder's record is deleted), your marks in `sample-user:v1` (favorites, tags per file, the last 300
  used) and the view in `sample-view:v1`. None contains a 64-hex run, so the storage clean-up (Clean-up of unused audio above:
  "any stored value mentioning a blob's hash") never reads them as audio in use; the files are not in the sample store at
  all until you place them, and placing one imports it through `importAudioFile` like any drop. Bumping
  `SAMPLE_ANALYSIS_VERSION` (`core/samples/types.ts`) analyzes everything again. Failed files are retried next time.
- Folder limit: 30,000 files per folder (`MAX_FILES_PER_FOLDER`).

### The window (`ui/features/samples`)

- Search over folder, path, type, tempo, key and your tags (every word must match, `-word` excludes), chips for each type
  (with counts), loops, favorites, recently used, "song key" (`fitsKey`: a note in the song's scale, a loop in its key or the
  relative key), a tempo range with ½× 2×, twelve key buttons, a folder list (folders and first-level subfolders), your tags,
  sort by name, tempo, key, length, loudness, type or recently used (the column headers sort too). All of it is
  `core/samples/query.ts` (pure, unit-tested), so the list the window shows and `list_samples` agree.
- The list is windowed (`useWindowedRows`, 28 px rows, `overflow-anchor: none` so the spacers don't fight the scroll):
  5,000 sounds draw ~40 rows. Rows show a star, name and folder, type (with "?" when the confidence is under 0.5), BPM, key,
  length and your tags; click auditions, ⌘/Ctrl-click and Shift-click select, ↑ ↓ step and audition (Shift extends), Enter
  plays or stops, A adds, F stars, Esc stops (the window's own keys: `keyboard.ts` leaves the typing piano quiet there),
  double-click adds (a one-shot as a sampler channel, a loop as an audio clip), drag carries the file like a desktop file
  (`ui/audio-drag.ts`, so the rack, the playlist and the Drum Pads' pads take it as before), right-click: play, add as a
  sampler channel, add to the playlist, make a kit, find similar sounds, favorite, tags. The selection bar adds tags (Enter) and
  "Make a kit from N one-shots". Empty states say what to do: no folders (Add folder), access to give again (Reconnect), no
  audio, no match (Clear filters).
- **Audition** (`actions.ts` `previewRow`, `core/samples/preview.ts`, `Engine.previewAudio(bytes, opts)`): a loop is time-stretched
  to the project tempo keeping its pitch (WSOLA in the stretch Workers; the copy is cached like the decode) or resampled with
  a playback rate, as the footer's switch says, starts on the song's next beat while it plays (`Engine.nextBeatTime`: the
  audible time plus the ticks to the next beat, within ~12 ms in `test/browser/sample-preview.test.ts`) and repeats until the
  next sound or Stop; a half or double reading of the tempo counts as the tempo it is (87 in a 174 song plays as it is). With
  "Notes in song key" a tonal sound, 808 or vocal is moved by the smallest turn onto the song key's tonic (playback rate).
  The preview level (0–150 %, the preview bus gain) is saved with the view.
- **Placing** (`actions.ts`, each one undo step): sampler channels; an audio clip at the song position marker on the first
  track with room (`ordinaryLaneFor`; a loop with a tempo gets `stretch: 'stretch'` and `sourceBpm`, and lasts its bars at any
  song tempo); one Drum Pads pad; **Make a kit** (`core/samples/kit.ts` `planKit`): a new Drum Pads channel with kick on pad 1
  (an 808 on 2), snares 3 and 5, clap 4, closed hats 7 and 9, open hats 11 and 13, toms low to high on 6, 8, 10, 12, cymbals
  14 and 16, percussion and the rest on free pads from the end of the kit; pads without a sound keep their built-in drum;
  loops and long files are left out and listed.

### Studio and MCP

- `list_samples` (read tool, so also an MCP tool): the sounds with type, confidence, tempo, bars, key, length, loudness and
  brightness, favorites and tags, filtered like the window (text, category, kind, tempo range, key, in song key, favorites,
  recent, tag, folder, similar to a sound, sort, limit) plus how many files, how far the analysis is, the by-type counts and the
  song's tempo and key. `place_sample` (to channel, clip or pad) and `make_kit` (named sounds, or a folder and/or search words)
  are checked when the answer is read and done after it (`ai/ops/samples.ts`, after-step `samples` in `app/samples/step.ts`:
  the file is read and stored, then the edit joins the answer's undo entry through `amend`). Commands: `samples.open`
  (Alt+B), `samples.addFolder`, `samples.reanalyze`, `samples.stopPreview`; `samples.makeKit` acts on the window's selection and
  is covered by `make_kit` in `test/unit/ai-coverage.test.ts`.

### Tests

`core/samples/*.test.ts` (names, query, kit, cache, preview), `test/unit/sample-classification.test.ts` (accuracy and its
variants), `sample-loops.test.ts` (tempo, bars, key, loop or one-shot), `sample-similar.test.ts` (nearest sounds; speed, tagged
`perf`), `app/samples/browser.test.ts` (cache hit and miss, changed file, version bump, removed files, failures, batches,
favorites and tags), `actions.test.ts`, `app/ai/ops/samples.test.ts` (ops, the step, the read tool);
`ui/features/samples/samples-window.browser.test.ts` (5,000 rows scrolled without drawing them all, filters, keyboard,
favorites, similar, kit, tags, every control named with a hint, empty states), `test/browser/sample-analysis.test.ts` (the Worker
pool: 1,500 files, same answers as inline, FLAC and MP3, cache with Workers) and `sample-preview.test.ts` (the engine).

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
analyzePitch(samples, sampleRate, { start?, minHz?, maxHz? }) // cleaned pitch frames + sung notes (pitch-notes.ts): see Pitch correction
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

## Pitch correction (`core/audio/psola.ts`, `core/audio/pitch-edit.ts`, `core/voice/pitch-notes.ts`, `app/actions/pitch.ts`, `ui/features/pitch-editor`)

Correct the pitch of a recorded vocal (or any one-voice line) note by note, like a graphical tuner: the clip's sung notes
appear as blobs on a piano grid with the pitch line as sung; the musician drags them, snaps them to the key, flattens drift,
tames vibrato. The corrected sound is a new sample that the clip plays; the original stays.

### Analysis (`core/voice/pitch-notes.ts`)

- `analyzePitch(mono, sampleRate, { start })`: `trackPitch` (YIN, ~5 ms hop, 65–1100 Hz), `cleanF0` (an octave slip moves back,
  an isolated outlier or the tracker's wild last frames as a voice dies away go unvoiced, dropouts up to two frames are bridged,
  runs under 20 ms are dropped), then `segmentNotes`: a run of voiced frames (unvoiced gaps under 30 ms are bridged) is cut
  where the median-filtered pitch leaves the note's running centre by 65 cents and settles on a new level for 50 ms (the
  boundary goes where the glide began); pieces under 40 ms join the nearer neighbour (a sliver at the end of a run far from it is
  dropped), notes with under 30 ms of pitch are dropped. Thresholds: `PITCH_NOTE_THRESHOLDS`.
- **Octave repair** (`core/voice/octave.ts`, in `trackVoicePitch`, which the analysis and the renderer share): YIN follows the
  strongest periodicity, so a voice whose fundamental is far weaker than its second harmonic (a strong formant near 900 Hz over a
  note at 440 Hz or above) was read an octave high for a whole note, and a third-harmonic voice an octave and a fifth. After
  `cleanF0` the track is walked in 29 ms steps; for each step with a pitch (median of its frames) a Hann-window spectrum is taken
  (58 ms, or 116 ms when the lowest candidate is under ~175 Hz) of the audio decimated to 8.8 kHz. For the divisors 3, 2 and 1.5
  (lowest candidate first) the candidate fundamental g = f / d is accepted when the spectrum has narrow lines at the two multiples
  of g that f's own comb lacks (g and 3g for d = 2; g and 2g for d = 3 and 1.5): each at least 7 % / 3.5 % of the strongest peak, 4×
  above the floor around it (the lower quartile of the magnitudes within ±0.45 g) and together 11× (geometric mean). Mains hum or
  noise gives one line, never both. A step's answer stands only if a neighbouring step agrees; the step's frames near its pitch
  (±150 cents) are divided by d. It runs per window, not per note, because a note read an octave high can join the true note above
  it into one long note. Cost: +34 ms of CPU for 60 s of singing on top of the tracker's 170 ms (a loaded machine). Candidates
  below 80 Hz are not tried, and fundamentals under ~86 Hz cannot be resolved by the 116 ms window.
- Per note: `pitch` (the median, MIDI, fractional), `drift` (3–97 % range of the slow line, cents: a 170 ms moving average, which
  follows glides and wander but not vibrato, measured away from the ends where the window is short), `vibratoDepth` (cents,
  peak to peak) and `vibratoRate` (Hz, from the zero crossings of pitch − slow line; none outside 3.5–9.5 Hz or under 25 cents).
- Cost: 112 ms for 60 s of audio before the octave repair, about 150 ms with it (Node, one thread). Results are cached in
  memory (`actions/pitch.ts`, 8 analyses, keyed by sample hash + sample rate + the analysed range, which is the clip's part of
  the sample plus 0.25 s each side) and always run in a Worker per job (`app/pitch/pitch.worker.ts`, `pitch-jobs.ts`; inline in
  Node tests). Analyses of recorded (embedded) audio are also **kept in the IndexedDB `kv` store**
  (`app/pitch/analysis-store.ts`): key `pitch-analysis:v<PITCH_ANALYSIS_VERSION>:<rate>:<from>:<to>:<sample hash>`, value
  `{ version, at, analysis }` (typed arrays and numbers). A reload or reopened project reads the entry instead of listening
  again; a damaged entry or a failing store is a cache miss. Any change that can alter a result bumps `PITCH_ANALYSIS_VERSION`
  (now 2: the octave repair), older entries are never read and are deleted once per session, and at most 24 are kept (the
  newest by when they were stored). **Storage clean-up**: the key starts with `pitch-analysis:` and ends in the hash, so the
  collector (`app/storage/kv.ts` `isAnalysisKey`, like the DJ analyses) neither counts the entry as a use of the audio nor
  pins it, and deletes it with the blob; nothing else about the audio is stored.

### The edit (`AudioClip.pitchEdit`, `core/audio/pitch-edit.ts`)

`PitchEdit { notes, transition?, renderedSampleId?, renderedFor? }`; a note is `{ from, to, pitch, shift?, drift?, vibrato? }`
in seconds on the sample's own timeline (so trims, splits and tempo changes keep working: a split clip carries the same edit).
`shift` moves the whole note (cents; the target is `pitch + shift / 100`), `drift` flattens its slow wander (0–1), `vibrato`
scales the wobble (0 removes it, 1 as sung, 2 doubles it). With c the sung pitch (cents), s its slow line and m its median:

    shift at t = shift − drift · (s − m) + (vibrato − 1) · (c − s)

A note with nothing changed is not touched at all; the shift curve glides over `transition` ms (default 25; 0 = hard tune) and
never moves unvoiced frames. `snapToKey` picks the nearest allowed pitch class (ties down) by a strength 0–1;
`splitNote`/`mergeNotes` keep the target; `applyPitchAction` is the one entry for the editor's buttons and the AI. The field is
one commented block in `types.ts`; `core/schema/repair/playlist.ts` cleans it (`sanitizePitchEdit`: clamps, sorts, removes overlaps, and forgets a
render whose sample is missing).

### TD-PSOLA (`core/audio/psola.ts`)

Pitch marks come from the phase of the fundamental (complex demodulation by the pitch track's phase, averaged over two periods;
a mark where the phase crosses 2π, at a fraction of a sample), unvoiced stretches carry marks every 8 ms. Synthesis marks follow
the analysis time (speed unchanged): the next lies one period ÷ ratio after the last, takes the nearest analysis mark and
overlap-adds its grain (two periods under a Hann window, read with cubic interpolation so grains land between samples; wider
for falls). Every sample is divided by the sum of its windows and blended to the input where none reaches; with ratio 1 the
grains rebuild the input to 1e-9, so untouched stretches come back unchanged and an edit has no seams. Ring buffers keep memory
flat for any length. Formants stay (each grain keeps its period's spectrum), within ±12 semitones.

Measured (Node 22): pitch ratio within 0.12 cent at −1200, −700, −230, 17, 500 and 1200 cents on a synthetic voice with a 900 Hz
formant; the formant's centre moves by 0.6–1.8 % at ±5…7 semitones (a plain resample would move it by 33–46 %); no sample step
beyond 1.6× the voice's own and no overs. A whole chain on 60 s of a sung line (40 notes with vibrato, snapped to the key,
re-analysed): matched notes within 1.8 cents (median 0.5). 60 s of stereo renders in 0.27 s (analysis 0.11 s).

### Render and playback (`app/actions/pitch.ts`)

- `startPitchRenderer` (created once in the feature's `register`) watches the document: after an edit (origin `edit`, not
  undo/redo/load) that touches a clip with a non-neutral `pitchEdit` whose render is out of date (`editSignature` ≠ `renderedFor`)
  it waits 450 ms and renders: the sample's channels over the edited stretch (first to last changing note ± 0.3 s) go to a Worker
  (`renderPitchEdit`: its own YIN track of that stretch, `shiftCurve`, `psolaShift`), come back spliced into a copy of the whole
  sample (same length and timeline, so offsets, fades, trims and tempo follow work unchanged), are scaled down if they pass
  full scale, encoded as 24-bit FLAC off-thread, written through the sample store (`importSampleBytes`) inside
  `whileBusy(…, { project })`, and recorded by `setPitchRender`: the new `SampleRef` goes into `Project.samples`, the clip names
  it, the previous render's entry goes when no clip plays it. A newer edit cancels the job in flight; a result for an out-of-date
  signature is dropped.
- **Undo**: the commit is `transact(…, { amend: <the edit's undo entry> })`, so the edit and its render are one undo step and
  undo restores the earlier edit with its earlier render (the old render's `SampleRef` comes back through the same patches;
  history keeps its hash referenced). If something else became the newest entry meanwhile, the render is a step of its own.
- **Storage**: the render's hash is in `Project.samples`, so it is kept like any sample (app/storage); the original stays
  referenced by the channel. The analysis is kept separately and pins nothing (above).
- **Engine**: `clipSampleId(channel, clip)` (`core/audio/playback.ts`) is `pitchEdit.renderedSampleId` else the channel's sample;
  `sample-residency.ts` plans a clip's buffers from its own sample, the clip player's `base(clip)` / `request(clip)` read it
  (`channel-strip.ts`), and a missing render falls back to the channel's sample. Offline renders and exports use the same path.
  Reverse is refused (the edit's timeline is the forwards sample). The playlist clip draws the **corrected render's waveform**
  (`clipSampleId`, the same length and timeline as the recording; the recording's own until the engine has the render's) and
  carries a "Pitch corrected" tag in its title.
- **A/B** (`editor.pitchOriginal`, `core/query/hear.ts`): session state, not in the document and not undoable. While a clip is in
  the list, `connectEngine` hands the engine `originalSound(project, ids)`: a memoized copy in which that clip has no
  `renderedSampleId`, so it plays its own recording; every change of the document passes through the same filter (together with
  the comping "listen to this take"), exports and offline renders read the real project. It clears when the clip goes away, when
  the editor shows another clip and when its window closes.
- Analysis range ≤ 15 minutes of sample (`PITCH_MAX_SECONDS`).
- **With a vocal cleanup on the clip** (see "Vocal cleanup"): the analysis stays on the recording, but the render reads the cleanup's render
  (`clipSourceSampleId(channel, clip, 'pitch')`: the order is recording, cleanup, pitch, then gain and fades), so the shifted voice carries no
  noise, breaths or clicks. A new cleanup render clears `renderedFor` of the pitch render, which makes the pitch renderer make it again
  from the new source (a run whose source changed meanwhile is dropped).

- **After alignment** (see Vocal alignment): the analysis and the render read the clip's *aligned* sound when it has one
  (`alignedSampleId`), and the render signature carries which aligned sample it was made from (`pitchRenderSignature`), so an
  alignment that changes re-makes the correction in the same undo step. Align first, then tune.

### The Pitch editor window (`ui/features/pitch-editor`, window type `pitch-editor`)

- Opens from the audio clip ▾ menu ("Pitch editor…"), Alt + double-click on an audio clip, the Playlist menu / action search
  ("Pitch editor for the selected audio clip", `pitchEditor.openClip`), or View → Pitch editor (Alt+Shift+P).
- `controller.ts` is imperative (grid, content and overlay canvases on the frame loop; React renders the toolbar only): the
  viewport's ticks are milliseconds, its rows MIDI notes; wheel scrolls, Ctrl/Cmd+wheel zooms time, Alt+wheel the rows, middle
  drag pans, a scroll thumb. Notes are blobs at their target pitch (an outline and a line show where a moved one was sung); the
  thin line is the pitch as sung, the bright one the corrected pitch (`shiftCurve` over the analysis frames). Drag a blob up or
  down (whole semitones; Alt = cents; "Drag in key" lands on the key's notes); the drag previews locally and commits one undo
  step on release. Shift-click and a marquee select; Split tool / S cuts a note where you click, M joins it with the next;
  Delete resets; ↑/↓ move by a semitone (Alt: a cent); right-click menu. Toolbar: Snap all (or selected) to key with a key chooser
  (starts as the song key) and Strength 0–100 %, Drift and Vibrato sliders (selected notes, or all), Transition, play from the
  selected note, status ("Listening…", "Rendering 40 %…", "Corrected audio ready"), Render now, More ▾ (merge, reset, remove all).
  The **Corrected / Original** pair next to Play is the A/B switch (key **B** while the editor has focus, command
  `pitchEditor.toggleOriginal`): the lit one is what you hear and the status line says "Hearing your original recording" while it
  is on; both are disabled until the clip has a correction.
  Sliders merge into one undo step per drag (`mergeKey`).
- Empty states say what to do (no clip chosen, listening, reversed audio, no notes found). Every control has a `data-hint`;
  the "?" panel lists the moves.
- `pitchState` (`app/pitch/state.ts`) is the editor's view state (target clip, analysis, selection, key); not in the document.

### AI and MCP

- `pitch` action (`app/ai/ops/pitch.ts`): `snap_to_key` (key default: the song key; `strength` %), `flatten_drift`, `vibrato`
  (`amount` %, 0 removes it), `shift` (`semitones` or `to_midi`), `transition` (`ms`), `reset`, `clear`; the clip by id or
  track + bar; notes by 1-based number (`notes`) or bars (`from_bar`/`to_bar`). With notes known (an edit exists, or the
  clip was analysed) it is a plain edit in the answer's undo step; otherwise the answer queues the `pitchEditor.apply`
  command (an app command after-step, its own undo step) that listens first. The render follows by itself.
- `get_pitch` (`app/pitch/report.ts`): per note its number, bar, start/end seconds, MIDI pitch and name, cents off, in-key flag,
  drift and vibrato measured, and what was changed. A clip never analysed starts its analysis and answers `analyzing`.
- Commands `pitchEditor.openClip`, `.play`, `.snapToKey`, `.apply`, `.clear`, `.toggleOriginal` (A/B; `argsHint` describes `clip` and
  `original`, so it is in the command catalog the AI and MCP see; a listening choice, not an edit); window `pitch-editor` in
  `OPEN_WINDOWS`. `get_pitch` also says `hearing` (`corrected sound` or `original recording`).

### Tune (`plugins/builtin/tune`)

New params (all defaults sound as before except the return to rest below; the golden test pins the default patch and the presets): **Target** (key and
scale, or the notes of a guide channel), **Guide channel** (which instrument channel, see `notes: { param }` in
[plugin-sdk.md](plugin-sdk.md#effects-that-follow-notes)), **Keep natural drift** (the singer's slow line, a 100 ms one-pole
against a 1 s average, minus the note's average, is left in by that share), **Added vibrato** depth (cents) and rate (Hz, fades
in over 0.35 s after each note starts), **Keep formants**. Played notes: the nearest held note to the detected pitch (a chord
gives the nearest note, with the same hysteresis), none held = the voice is left alone. Keep formants is pitch-synchronous
overlap-add on the same delay lines (up to 8 grains of two periods, read at speed 1 at a constant delay near the 12 ms
latency, spaced period ÷ ratio, taken from the voice's own period grid, normalised by the window sum and faded in and out
against the splice shifter's output), so the latency is unchanged and no allocation happens in `process()`. Presets added: "Hard
trap tune (C minor)", "Natural pop (C major)", "Robot".

**Return to rest.** After a correction ends the splice head used to drift back to its centre at ≈ 3 cents (0.002 frames per
frame) from as far as 376 frames away: 1.1–2.9 s, with the output meanwhile off the delayed input (and off the dry path of the
mix). Now, once the correction has stayed under a cent for 30 ms (a glide through a note is not an end), `rest()` starts a
crossfade to a nearer head: straight to the centre once no pitch has been found for 8 detections (≈ 43 ms: a pause, a
consonant), else a whole number of periods towards it (the same waveform point, so no click), and what is left (under half a
period) drifts at 0.0035 frames per frame (≈ 6 cents; it was 0.002). No allocation (`rest` is in the audio-thread audit).
Measured (head back at its centre, a note 23 cents sharp for 2.5 s then exactly in tune, 110–262 Hz): while the voice goes on
1.5–2.9 s → 0.2–1.0 s (higher notes return sooner: the leftover is under half a period); after a 0.4 s pause 1.1–2.5 s →
0.05–0.11 s after the pause ends (it is home during it). The largest sample step stays within 1.2× the voice's own (also across
noise between notes). The golden test pins the default patch and nine presets: six of those ten renders (Natural vocal tune,
Hard tune robot, Minor pentatonic snap, Deep voice hard tune, Hard trap tune, Natural pop) are bit-identical to before;
**default patch, Gentle correction, Pop tune and Robot** differ only from the first such return on (0.48, 0.48, 1.74 and 1.31 s
into the melody; chunk levels within 0.35 dB), so their goldens were regenerated on purpose (`TUNE_GOLDEN_RECORD=1`).

**High notes and the rest decision.** The detector's estimate (`Yin.frequency`, a parabola through the difference function
at whole lags) is a few tenths of a cent off at 150 Hz but 1–2 cents at 300 Hz and 3–6 at 700 Hz for a voice with strong upper
harmonics (the error grows with the pitch and with the fractional part of the lag). A held note at D4 or above therefore
asked for a correction of 1.4 cents or more and never counted as in tune (`REST_CENTS` is 1): at 392 and 523 Hz the head
never went home at all (8 s measured), at 294 Hz it took 0.76 s against 0.17 s at 262 Hz. `Yin.refinedFrequency()` fits again
through three points a quarter lag apart on the same window, reading the signal between samples (Catmull-Rom): under 0.4 cent
over 150–700 Hz on harmonic and formant voices. Tune asks for it only when the plain correction is under 8 cents
(`REFINE_WITHIN_CENTS`) and uses it only to decide on rest (`isInTuneByCloserEstimate`: the closer estimate says under a cent and the
glided correction has caught up with its goal, so a glide from one note to the next is never taken for a settled voice).
The correction itself still comes from the plain estimate, so a played preset sounds as it did. Measured as above (a note
23 cents sharp for 2.5 s, then exactly in tune; seconds until the head is back at its centre; before → after):

| note | after a 0.4 s gap | voice goes on |
|---|---|---|
| 110 Hz | 0.108 → 0.108 | 0.975 → 0.975 |
| 164.81 Hz | 0.052 → 0.052 | 0.911 → 0.911 |
| 220 Hz | 0.052 → 0.052 | 0.399 → 0.377 |
| 261.63 Hz | 0.052 → 0.052 | 0.169 → 0.169 |
| 293.66 Hz | 0.196 → 0.135 | 0.756 → 0.572 |
| 392 Hz | never (8 s) → 0.113 | never → 0.415 |
| 523.25 Hz | never → 0.052 | never → 0.172 |

Of the ten golden renders (default patch and nine presets) eight still match their stored values; **default patch and Gentle correction**
differ from about 0.8 s on, where the melody holds E4 (330 Hz) and the head now goes home (the stored values were regenerated on purpose).
CPU (bench, % of one core, best of 9, a busy machine): default patch 0.51–0.52 before, 0.52–0.54 after.

Measured (Node, 48 kHz, voice with a 900 Hz formant at 196 Hz moved +500…+900 cents): pitch error ≤ 2 cents either way; the
formant (energy centroid) moves 31–64 % with the plain shifter and 1–5 % with Keep formants. CPU (% of one core, best of 7,
this machine): default patch 0.38–0.40 (the same before and after the change), guide notes 0.44, drift + vibrato 0.46, keep
formants 0.51, keep formants while correcting 0.57.

### Tests

Node: `psola.test.ts` (pitch ratio < 1 cent at nine shifts, formant peak < 5 % at ±5 semitones, no clicks, gliding shift, zero
shift returns the input, stereo, deterministic), `pitch-notes.test.ts` (sung notes with vibrato, drift, a legato step, a pause,
a sag; offsets; silence and noise), `pitch-edit.test.ts` (snap, split/merge, validation, signature, shift curve incl. drift and
vibrato numbers, the whole chain landing on the key within 6 cents, determinism), `core/ops/pitch.test.ts` (undo restores the
earlier edit and render, render replacement, shared render after a split), `app/actions/pitch.test.ts` (each editor operation is
one undo step, slider drags merge, render amended into the edit's step, hashes kept), `app/ai/ops/pitch.test.ts`,
`core/schema/migrate.test.ts` (repairs), `core/voice/octave.test.ts` (160 synthetic notes over four formant voices: the tracker alone
misreads 14, the repair none, with vibrato and noise 9 of 60 → 0; no false repairs on calm voices, breath and mains hum, a missing
fundamental or an octave leap; the evidence and the cost), `app/pitch/analysis-store.test.ts` and the stored-analysis cases of
`app/actions/pitch.test.ts`, `ui/features/pitch-editor/ab.test.ts` (A/B), `ui/features/playlist/corrected-wave.test.ts`,
`ui/features/pitch-editor/model.test.ts`, Tune kernel tests (guide notes, drift, vibrato,
formants, a source audit that the audio-thread methods allocate nothing, heap kept after a long run) and golden test, runner and
`NoteFeedHub` tests. Browser: `test/browser/pitch-correction.test.ts` (the engine plays the render, the original without it, falls
back when it is missing), `tune-notes.test.ts` (a guide channel pulls a recorded voice through a real AudioWorklet), UX audit.

### Limits

The octave repair needs two clear lines of the lower fundamental in the spectrum: a fundamental that is only just there (under
~5 % of the strongest peak) or below ~86 Hz stays as the tracker read it, and a note shorter than a window beside a loud neighbour
can be mixed. One voice at a time: chords
and noisy takes give no notes. TD-PSOLA keeps formants well within about ±5 semitones and sounds rougher at ±12; a shifted
note repeats or skips whole periods. Breaths and "s" sounds are never shifted.
The edit works on the clip's sample, not on its reverse or on a stretched copy (tempo follow still works on the render).

## Vocal alignment (`core/audio/align`, `core/audio/wsola/warp.ts`, `app/actions/align*.ts`, `app/align`, `ui/features/align`)

Make doubles, backing vocals and ad-libs line up with a lead, like VocAlign: the syllables of a clip move onto the
timing of a guide clip (and, if asked, its pitch contour), or a vocal is snapped to the song's grid. The aligned sound is a
new sample that the clip plays; the recording stays. Align first, then tune: the Pitch editor works on the aligned sound.

### The chain of sounds a clip can play (`clipSampleId`, `core/audio/playback.ts`)

    channel sample  ──align──▶  AlignEdit.renderedSampleId  ──pitch edit──▶  PitchEdit.renderedSampleId

`clipSampleId(channel, clip)` is `pitchEdit.renderedSampleId ?? align.renderedSampleId ?? channel.sampleId`, and it is the one
funnel for the engine, the residency plan, the waveform and the exports, so nothing else knows about the chain. Every render is
as long as the original and on its timeline (trims, fades, tempo follow work unchanged). The pitch render is made *from* the
aligned sound (`alignedSampleId` in `core/audio/align/edit.ts`; `analyzeClip` and the pitch renderer read it), so it already
contains the alignment. Its render signature (`pitchRenderSignature` = `editSignature`, plus `|aligned:<sample id>` only while
the clip has an alignment render) therefore changes when the alignment's render does, and the pitch renderer re-makes it; with
no alignment it is exactly `editSignature`, so earlier projects keep their renders. The pitch re-render is folded into the same
undo step as the alignment that caused it. The notes of a pitch edit are seconds on the sample's timeline: aligning *after*
tuning moves syllables by up to ~100 ms, so the notes should be found again in the Pitch editor (a limit, below). Other renders
(vocal cleanup, harmonies) join the same chain by adding their own field and a link in `clipSampleId`.

### The record (`AudioClip.align`, one commented block in `types/playlist.ts`)

`AlignEdit { mode: 'guide' | 'grid', guide?, tightness (0–100), pitch? (0–100 %), strength? (0–100 %), stepTicks?,
renderedSampleId?, renderedFor?, warp? }`. `renderedFor` is the signature of the plan the render was made for; `warp` is the
overlay's points. `core/ops/align.ts` (`setAlign`, `setAlignRender`, `clearAlignRender`) are the draft mutators;
`core/schema/repair/playlist.ts` (`repairAlign`, `sanitizeAlignEdit`) cleans damaged data and forgets a render whose sample is
missing. Removing a render drops its `Project.samples` entry unless another clip (an alignment or a pitch render) or a channel
plays it. The storage clean-up needs nothing: the render's hash is in `Project.samples`, so it is kept like any sample.

### The plan (`core/audio/align/plan.ts`, pure)

`planAlignment(project, clipId)` gives the stretch of the clip's sample to render (the part the clip plays ± 0.3 s, `region`),
the part of it that is audible, the guide's sound on the same axis (`GuidePlan`: which sample it plays, where that sample is at
the start of the stretch, which part is audible) or the grid lines of the stretch (`GridPlan`), and the **signature**: every
input of the render as a string (mode, tightness, pitch, source sample, region, audible spans, guide clip, its sample and place,
a digest of the grid lines). Moving the clip or the guide, a new tempo, another sample under the guide all change it; the render
and its own signature do not. A clip is refused with a plain reason when it does not play at its own speed (Reverse, Pitch,
Follow tempo: `isPlainPlayback`), when its audio is missing, or when the guide is itself or part of a ring (A follows B follows A).

### Features, match and move (`core/audio/align/*.ts`, pure, deterministic, Worker or Node)

1. **Features** (`features.ts`), every 5 ms (`ALIGN_HOP_SEC`): a 20 ms Hann window (1024 at 44.1 and 48 kHz); 12 mel bands from
   100 Hz to 7.5 kHz as dB *relative to the frame's own loudness* (the shape of the sound: vowels against consonants; weight 1); the
   loudness against the clip's own 95th percentile (weight 1.6); the spectral flux (rises per band, gated by how much sound there
   is; weight 1.6); and voiced / unvoiced from the shared YIN tracker (`trackVoicePitch`; weight 0.7). Outside the audible part
   everything is silence, so the match never leans on sound the clip does not play. The vectors are pre-weighted, so a frame
   distance is a plain sum of squares. Level, pitch and tone differ between two voices; shape, energy contour and onsets do not.
2. **Match** (`dtw.ts`): dynamic time warping in a **band** of ±0.5 s around the diagonal (`MAX_ALIGN_SHIFT_SEC`), so the trace
   table is `frames × 201` bytes and the work is linear in the clip's length (a 3-minute clip: 36,000 frames, 7.5 MB of trace; a
   full table would be 1.3 billion cells). Steps keep the speed of the clip between ¼× and 4× ((1,1); (1,2) to (1,4); (2,1) to
   (4,1)); a step that is not diagonal costs a penalty (more for the steeper kinds) **where either voice sounds** and is free
   where both are silent, so a held note keeps its offset and a gap can be squeezed or stretched to make up the time between two
   syllables. Both voices get `2 × band` frames of silence at either end and the path may begin and end at any offset, so a
   double that comes in 300 ms late is matched from its first frame. The result is the clip frame matching every guide frame.
3. **Lag curve** (`lag.ts`): the lag of a frame is how much later than the guide the clip was there (seconds; output time o plays
   the clip's own sound from o + lag(o)). The raw path is smoothed with a moving average weighted by how much both voices sound (in
   a silence the path is arbitrary, so it takes the lag of the sound next to it). **Tightness** sets the window (1.2 s at 0 to 30 ms
   at 100, a constant ratio), a dead zone (offsets under 60 ms are left alone at 0, none from 60 up) and the DTW step penalty (0.5 at
   0 to 0.05 at 100). The move fades out at the ends of the stretch (the margin). Then **attacks are kept**: `syllableOnsets`
   (`onsets.ts`: flux and loudness rise, peak-picked, then placed where the envelope reaches 20 % of the attack's peak) finds the
   consonants and syllable starts of the clip; across each the lag is flat from 53 ms before to 40 ms after (what the WSOLA frames
   need so that every frame that reaches the attack continues the input exactly), and its value is pinned. The last step limits the
   speed to ½–2× where the clip sounds and 0.2–4× in silence, with the pins as hard constraints: the stretch a big change needs is
   made in the vowels and gaps *before* the attack, so the attack lands where the match put it (`limitSpeed`: a forward, backward
   and forward projection, then a clamp inside the lags that can still reach every pin).
4. **Render** (`warp-render.ts`, `wsola/warp.ts`): WSOLA (30 ms frames, ±8 ms search; the same similarity search and overlap-add as
   the constant time-stretch: `wsola/stretch.ts` now exports `overlapAdd`, `frameGeometry` and `similaritySearchFor`, and
   `timeStretch` itself is unchanged, its characterization snapshots untouched) along a **piecewise-linear time map**
   (`WarpTimeMap`: an anchor per 5 ms frame, plus the kept spans that play at the input's own speed). Pitch stays, the stereo image
   holds (every channel uses the same frames), the output is as long as the input.
5. **Pitch alignment** (`pitch-follow.ts`, optional, strength 0–100 %): the aligned clip is tracked again; where both voices are
   voiced the distance to the guide is read in cents, the *interval* the clip sings (the median over ±0.25 s, rounded to whole
   semitones: a harmony a third above stays a third above) is taken away, and `strength` of what is left (up to 75 cents; more is a
   different note or a tracker slip) is the shift curve for **TD-PSOLA** (`psolaShift`: formants stay, unvoiced frames and
   deviations over the limit are never touched), glided over about 30 ms and bridged over gaps up to 80 ms. The guide's vibrato is
   followed too.
6. **Tighten timing to the grid** (`grid.ts`): every onset within `maxMoveSec` (the smaller of 120 ms and 45 % of a grid step) of a
   grid line gets a target (onset + strength × distance); the lag is a line through those moves and zero away from them
   (`lagThroughMoves`), then step 3's fade, kept attacks and speed limit, then the same render. Grid lines come from the tempo map
   (`GridPlan`), so tempo automation is followed.

`alignToGuide(input) → { channels, lagSec, hopSec, kept, stats }`; stats are the median and largest move, the time moved, the
overlap, and the median pitch deviation before and after. `warpKnots` thins the lag to a few hundred `[sampleSec, moveMs]` points
(Douglas–Peucker, 1.5 ms, at most 2,000) for the project file and the overlay.

### Render and playback (`app/actions/align-render.ts`)

- `startAlignRenderer` (created once in the feature's `register`) watches the document: after an edit (origin `edit`, not
  undo/redo/load) that touches the playlist, the transport, the channels or the samples, every aligned clip is planned; when its
  `renderedFor` differs from the plan's signature it waits 450 ms and renders. The clip's stretch of the sample (and the guide's
  sound as mono on the same axis, `app/align/guide-audio.ts`) go to a Worker (`app/align/align.worker.ts`, `align-jobs.ts`; inline
  in Node tests); the result is spliced into a copy of the whole sample (`spliceRendered`, shared with the pitch renderer), encoded
  as 24-bit FLAC off-thread, written through the sample store inside `whileBusy(…, { project })` and recorded by `setAlignRender`
  (sample entry, `renderedFor`, `warp`). A newer edit cancels the job in flight; a result for an out-of-date signature is dropped.
  Moving the clip or the guide, changing the tempo or the guide's own sound re-render by themselves.
- **Undo**: the commit is `transact(…, { amend: <the edit's undo entry> })`, so the settings and their render are one undo step (a
  batch of clips is one step for all of them) and undo restores the earlier settings with the earlier render.
- **A/B** (`editor.alignOriginal`, `core/query/hear.ts` `unalignedSound`): session state, not in the document and not undoable. The
  engine hears a copy of the project in which the clip has neither the alignment's render nor the pitch render (made from it), so it
  plays the recording as recorded. It clears when the clip goes away and when the Align window closes.
- The playlist draws the **aligned waveform** (`clipSampleId`), a tag ("Aligned", "Tightened to grid") and the **warp overlay**
  (`ui/features/playlist/warp-overlay.ts`): a thin line along the bottom that rises where the sound was moved earlier and dips where
  it was moved later (full height = 150 ms), faintly shaded down to its dotted baseline.

### UI (`ui/features/align`, window type `vocal-align`)

- Entry points: clip ▾ / right-click on an audio clip ("Align to guide…", "Tighten timing to the grid", "Remove alignment" when
  aligned), the Playlist menu and the action search (Mod+K) for the same commands.
- The **Align window** is small and not modal, so you listen while you adjust: *Follow a lead* (a guide chooser listing every other
  audio clip as "name · track, bar", Tightness 0–100 %, Pitch alignment 0–100 %) or *Snap to the grid* (1/4 to 1/32, Strength
  0–100 %); **Align** / **Update alignment** (one undo step), Play, an **Aligned / Original** switch (A/B), Remove, and a status line
  ("Making the aligned sound… 40 %", "Aligned: syllables moved 35 ms typically, 120 ms at most", the reason when something failed,
  "Render now"). It acts on the selected audio clips (several at once = a batch aligned to one guide). Its empty state says what to
  select. Every control has a `data-hint` with its units; the "?" panel lists the moves.
- Commands (all with a `hint` and an `argsHint`, so they are in the AI/MCP catalog): `align.open`, `align.apply`
  (`{ guide, clips?, tightness?, pitch? }`), `align.tighten` (`{ clips?, strength?, grid? }`), `align.remove`, `align.toggleOriginal`.

### AI and MCP

- Actions (`app/ai/ops/align.ts`): `align_clips { guide | guide_track + guide_bar, clips | tracks, tightness, pitch }`,
  `tighten_timing { clip | track + bar | clips | tracks, strength, grid }` and `remove_alignment`. Each is a plain edit of the clips'
  settings in the answer's undo step; the renderer follows by itself. Clips the check refuses come back as warnings with the reason.
- Read `get_alignment { clip? }` (`app/align/report.ts`): per aligned clip its track and bar, mode, guide (id, track, bar),
  tightness, pitch %, grid strength, **state** (`ready`, `rendering` with progress, `out of date`, `problem` with the reason), how
  far the sound was moved (median and largest, ms), what the last run measured (the pitch deviation before and after included) and
  which sound is heard (`aligned sound` or `original recording`). Window `vocal-align` is in `OPEN_WINDOWS`.

### Tests

Node: `core/audio/align/align.test.ts` (a synthetic lead and double: onsets within 10 ms with ±80 ms jitter and ±15 % lengths, a
double 300 ms late or 250 ms early, tightness monotone and 0 fixing only big offsets, stereo, a lead at another sample rate, no
overlap, determinism, no clicks at the joins, consonant bursts keep their peak, pitch kept when only time is aligned, median pitch
deviation under 10 cents at 100 %, 50 % lands between, a harmony keeps its interval, the 3-minute clip's memory and time),
`dtw.test.ts`, `lag.test.ts` (speed bounds, pins, silences take up time), `grid.test.ts`, `warp-knots.test.ts`, `plan.test.ts`
(axes, signature, refusals, rings, grid lines), `wsola/warp.test.ts`, `core/ops/align.test.ts` (undo, renders, chain order),
`app/actions/align.test.ts` (the whole flow through the real renderer and FLAC: one undo step, onsets within 10 ms *in the stored
render*, a batch, re-render on a changed setting or a moved guide, removal, A/B), `app/ai/ops/align.test.ts`,
`ui/features/align/align.test.ts` (menus, commands, A/B in the engine) and the AI coverage audit.

### Measured (Node 22, one thread, 48 kHz mono; the machine was shared with other work, so times are upper bounds)

- Onset accuracy: 40 doubles with ±80 ms start jitter and ±15 % length changes (10 syllables each): every onset within 7.1 ms of
  the lead's (median of the worst per double 3.4 ms; before alignment they were up to 270 ms off). With ±100 ms and ±25 % some
  syllables have no gap left to squeeze: 11 of 40 doubles then have one onset off by up to 60 ms.
- Pitch: a double sung up to 35 cents off, no vibrato: the median deviation from the lead goes 19.9 → 2.1 cents at 100 % (10.7 at
  50 %).
- Speed and memory: a 6.25 s clip aligns in 0.13–0.2 s; a **3 min 7 s** clip with pitch alignment in 5.9 s wall (6.3 s CPU), peak
  array memory 218 MB above the 72 MB of the two inputs (the trace table is 7.5 MB of that).

### Limits

Alignment needs a clip that plays at its own speed (no Reverse, Pitch or Follow tempo) and works on one voice at a time; the match is
bounded to ±0.5 s from where the clip is, so a clip further off has to be moved close first. Two doubles with no gap left between
syllables (or a guide with words the clip does not sing) cannot be matched exactly: the attacks stay sharp, but the match lands where
it can. Pitch alignment corrects up to 75 cents from the interval the clip sings and cannot turn a harmony into a unison. Notes of a
pitch edit made before the clip was aligned (or re-aligned) keep their old times: remove them and let the Pitch editor listen again.
A guide that follows another guide works (the chain renders in turn); a ring is refused.

## Beat assistant (`src/core/beat`, `src/core/voice`, `src/app/assistant`, `tools/ai`)

- **Beat format** (`core/beat/spec.ts`): `{ title, message?, bpm?, swing?, bars (1–4), tracks: [{ name, sound, notes:
  [{ step, len?, key?, vel? }], volume?, pan?, params? }] }` on a 1/16-step grid (steps snap to 1/6 step = 40 ticks, so
  1/32 and triplet rolls fit). `validateBeatSpec` clamps everything and drops what doesn't fit; nothing unvalidated
  reaches the project. Sounds: the kit pieces (samplers), `808` (`agstudio.bass808`: overlapping notes glide), `bass`,
  `lead`, `pad` (3xOsc settings) and `pluck`.
- **The assistant class** (`app/assistant/assistant.ts`) is only the public surface (`AssistantApi`). The work is one
  module per job in `app/assistant/beat-assistant/`, each working on the shared `AssistantSession` (services, store,
  the AI conversation, the request in flight): `send.ts` (a request and its backend), `turn.ts` (apply an answer, look
  things up, listen to the mix and ask again), `take-recorder.ts` (mic recording and import), `mix-listening.ts`,
  `follow-up-steps.ts`, `plugin-building.ts`, `external-apply.ts` (AI apps over MCP), `offline-beat.ts`.
- **Applying** (`app/assistant/apply.ts`, split into `beat-writer/`: plan, channel matching, sounds, write): one history transaction writes a pattern and its channels, reusing the
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
    Claude plan, run in print mode per turn with no built-in tools (its only tools are AGstudio's read tools, see "AI context: cached prefix, index, lookups"), resuming its session for follow-ups. How the system prompt
    and the schema reach it is `tools/ai/claude-turn.ts`: as `--system-prompt` / `--json-schema` arguments when the
    command line is safely short for the system (macOS and Linux, always in practice), otherwise through the CLI's
    stream-json input (an `initialize` control message carrying `systemPrompt` and `jsonSchema`, then one user message),
    which is what every Windows turn does (see "Windows, macOS and Linux" below; `AGSTUDIO_CLAUDE_TRANSPORT=stdin|argv` forces one);
  - **api** (`tools/ai/api-backend.ts`): the Anthropic SDK with `ANTHROPIC_API_KEY` from `.env.local` (re-read per
    request): streaming, `output_config` effort `medium` + JSON schema, server-side refusal fallback
    (`fallbacks: "default"`) on models that have it, an append-only history (thinking blocks kept);
  - **codex** (`tools/ai/codex-backend.ts`): the musician's ChatGPT plan through their own Codex CLI (found through
    `AGSTUDIO_CODEX_BIN`, the PATH, the ChatGPT app's `Contents/Resources/codex` and the usual install folders; on Windows the PATH with
    PATHEXT-style extensions and the npm, pnpm, WinGet and Scoop folders, see `tools/platform/find-cli.ts`).
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
  thread there (it starts from the same system prompt, with the catalog index in it) and switching back continues the old one. Claude
  Opus 5.5 and Sonnet 5.5 reject forced tool choice, which is why the answer is a structured output rather than a
  tool call. The endpoint refuses requests without the `x-agstudio` header or from another origin; the model id is
  checked per backend (`claude-…`, or Codex's `[a-z0-9][a-z0-9._:-]{0,63}` or empty).
- **Offline** (`core/beat/local.ts`): when no key is set, a deterministic generator reads style, tempo, key and
  "busier/simpler" from the description, uses per-style drum grids, writes an 808 that follows the kick, and maps a
  performance onto drums (beatbox) or an 808/melody (hummed contour moved into register and key, connected notes
  overlapping so they glide). A request for a whole song ("a sad trap song at 140", "make a full song") goes to the
  song generator below instead; a beat request, or a take to follow, stays here.

## Offline song generator v2 (`core/song`, `app/assistant/song-answer.ts`, `beat-assistant/offline-song.ts`)

With no AI set up (or the "Offline generator" chosen) "make a full song…" writes a finished song with no model call. The
musician's bar for AI songs applies to it too: smooth transitions, variation, groove and a set-up mix by default. The
generator is pure (`core/song`, no DOM, deterministic); the app turns its plan into the same actions an AI answer carries,
so applying, undoing, leveling and playing are the AI path's own code.

### What a request produces
- `request.ts` reads the words: style (the beat generator's style words), tempo ("at 140"), key ("in F minor", or
  "minor"/"major"), mood (sad, dark, uplifting, chill… → `Mood` of the harmony palette; sad, dark, tense and dramatic lean
  minor, happy and uplifting major), length ("48 bars", "about 2 minutes", "short", "long") and busier/simpler. What the
  words leave open (style, tempo inside the style's range, key, mode, mood) comes from the **seed**: the hash of the words,
  plus 7919 × the number of songs this conversation has written (so the same words asked again are another song, and
  New chat starts the count over). `isSongRequest` tells a song ("song", "full track", "verse", "chorus", "intro",
  "64 bars", "2 minutes") from a beat ("trap beat with 808s", "busier hats", "Arrange it: 4 bars…").
- `harmony.ts` picks a progression from `core/harmony/progressions` that fits four bars in the song's mode, scored by
  mood tag (+4), the style's moods (+0.8 each) and genres (+1.6 each) and a seeded nudge, then a weighted pick among the best
  four (so seeds differ). The verse and intro play it, the chorus plays it or (about every second song, rarely in dance
  music) a second one, the build plays it turned around two bars (it ends leaning into the chorus), the break turned one
  or three bars. Some styles use the key's sevenths. The whole song's chords go on the chord track in one `chords` action
  (a name per bar, a dot where the chord holds).
- `voicing.ts` voices every chord part (pad, keys) with the harmony module's candidate voicings and one more rule: a
  dynamic program over the loop (its last chord leads into its first) whose cost is the movement between voicings, the
  leap of the top voice and, heavily, **parallel fifths and octaves** between the outer voices and between the bass note
  and the top. `parts.ts` plays the voicings in the style's rhythm for the kind of section (`COMP_HITS`: held, half, push,
  lazy, two, stabs, offbeat, tech, dembow).
- `bass.ts` writes the bass from the chords and the pattern's kick by a per-style rule (`BassRule` in `profiles.ts`): an
  808 on the root at each kick hit, held to the next, sliding into the chord's fifth or octave at the end of the phrase
  (trap every second bar, drill every bar, reggaeton at the loop's end), a sub on the kick with now and then a fifth or
  octave (boom bap, afro), the harmony module's walking line (lo-fi) or root-fifth line (pop), rolling 16ths between the
  kicks with an octave on the last 16th of each beat (house, progressive house), the offbeat 8th (trance, big room, EDM),
  a syncopated groove (tech house, three seeded figures), long roots (future bass, melodic dubstep), a sub and a growl
  (dubstep), a reese on the two-step kick (drum & bass). Every bass note is a tone of its chord; a chord change always
  starts a new note.
- `motif.ts` + `melody.ts` write the lead from a **two-bar motif** made once per song for the verses and once for the
  hooks: a rhythm from the style family's cells (`plain`, `bounce`, `laid`, `driving`; the second bar the first or
  another cell) and a contour (a walk of scale steps that arches; the second bar repeats the first bar's contour with its
  last move changed when the rhythm repeats). A pattern is four bars: the statement, then the response (turned upside
  down, or the same shape a step higher), a long cadence note on a chord tone at the end. The hook has three strengths
  (hook; hook 2 with the same statement and a new answer, plus a counter-melody; hook final an octave higher and busier),
  the second verse is the first with one note moved and a busier answer, the bridge is the verse thinned and inverted, the
  intro plays a quiet teaser of the hook. Notes on the first or third beat or lasting a beat or more are **always chord
  tones** of the chord under them (nearest in the direction the motif moves, so a contour survives); the notes between
  are chord tones or scale tones reached and left by step, at most two steps long; leaps stay under a sixth when a nearer
  tone exists. The lead stays in the style's register (`lead.low`/`high`).
- `colour.ts`: the dance styles (and the biggest chorus of the others) get a chord-tone **arpeggio** (every 8th, trance
  every 16th); the others get a **counter-melody** in hook 2 and the final hook: chord tones under the lead, starting where
  the lead does not, a third or sixth below the note it sounds against, moving as little as possible.
- `drums.ts` takes the style's grid (`drumGridOf`) at four strengths: light (the verse: no ghosts, open hat or rim), build
  (rising 16th hats), full (the chorus: extra kick hits off the backbeat at a seeded step in bars 2 and 4, trap hat rolls
  at the end of bar 4) and peak (the last chorus: more rolls, an open hat). The arranger adds the fills and builds.
- `shape.ts` lays the sections out: the EDM pack's own songs (`SONG_SHAPES`; tech house keeps its bass in the intro),
  three general ones (rap, pop, chill) and a club house shape; a length asked for halves the long sections (the intros,
  breaks and builds before the peaks) and then drops the optional ones (a third hook, the bridge, the second build, the
  second verse), or repeats the song's peak with a turn before it. `generate.ts` assigns the patterns (intro, verse,
  build, chorus, chorus final, break, and the melodies) by role and by how many times the role came before, then writes
  each once as a four-bar `BeatSpec`; velocities follow the section's energy (×0.85 at 1 … ×1.05 at 5) and the beat.
- `metrics.ts` measures a plan from its notes (the tests use it): the lead's chord-tone ratio on strong notes, the bass's
  root and chord-tone ratios, the parallel outer voices, the motif reuse (rhythm and contour trigrams that come back),
  the lead's range, the syncopation.

### Applying it (`app/assistant`)
- `songToAnswer(plan)`: `song` (tempo, swing of the style, key), `chords` (the chord line), one `beat` per pattern (`pattern:
  "new"`, a `ref`), one `arrange` (every section, `mix: 'auto'`) and a `level_mix` on the **first loudest section** (the
  arranger's own leveling listens to the song's first 20 seconds, which are the intro: a trance song levelled there ended
  1.1 dB short of its target; the last `level_mix` of an answer is the one that runs). `writeOfflineSong` also removes the
  new project's empty "Pattern 1" and goes through `applyTurn` (one undo step; the arranger's fills, transitions and FX;
  the mix set up by role; the level step; song mode and play), with `offline: true` on the chat message. The conversation's
  "current beat" is cleared, so a follow-up ("busier hats") writes a new beat instead of rewriting the song's last pattern.
- Changing the song afterwards works offline too: see "Offline edits" below. A request after a song is no longer written as a separate beat.
- Starter ideas and the "Who answers" help text say the offline generator writes full songs and changes them.

### Measured
- Across the 17 styles at 8 seeds (136 songs; `core/song/song.test.ts` asserts these with its own bounds): **100 %** of the 5 971
  strong-beat lead notes are chord tones (bound 80 %); **100 %** of the 1 129 bass notes on a chord change are its root
  and 100 % of all 8 363 bass notes are chord tones or approach notes (bound 90 %); **0 of 3 777** chord changes have
  parallel fifths or octaves in the outer voices (bound 5 % each, 2 % overall; with the rule off, 17 % of a trap song's
  changes do); the lead motif comes back: 35 % of the rhythm-and-contour trigrams of a song's melody occur more than
  once (11 % to 66 % across songs; the test holds each between 8 % and 80 %, and the mean between 20 % and 55 %)
  while 56 % to 95 % of the distinct shapes occur once; 51 % of the lead's notes are off the beat.
- 16 seeds of "a sad trap song": at least 4 progressions, 14 different hooks, 6 different hook rhythms, 4 tempos, 5 keys.
- The arrangement check (`checkArrangement`, the strict inferred-sections form too) finds no bugs in any of the 17 styles.
- Loudness through the real engine (`test/browser/offline-song.test.ts`, the song's loudest 8 bars through the master
  chain after the level step): trap −10.16 LUFS (target −10), lo-fi −12.58 (−13), trance −8.72 (−9), all −1.05 dBTP; a
  whole song takes about 12 s from the request to the leveled, arranged mix in the browser.
- Templates are unchanged (they stay a beat and an intro, with their baked levels): the DJ analysis fixtures and
  `template-levels.ts` depend on them.

## Offline edits (`core/offline-edit`, `app/assistant/beat-assistant/offline-edit.ts`)

With no AI, plain words change a song that is already in the project. The interpreter is pure (`interpretEdit({ text, project, roles, focus, variation })`, deterministic, never changes the project) and answers with the same actions an AI's answer carries, so `applyTurn` does the rest unchanged: one undo step, the focus guard and its approval question, the arranger's follow-up work, the leveling step, autoplay. **No new ops**: the AI coverage test and the characterization snapshot did not change.

### When it runs (`beat-assistant/send.ts`)
- A part picked in the playlist (focus: range, section or clips), or a project with pattern clips on its playlist and no beat of this conversation in progress (`applied` is null). A take, or a follow-up to a beat this conversation wrote, still goes to the beat generator ("busier hats" after "trap beat" rewrites that beat).
- `interpretEdit` returns `edit` (applied), `reply` (a plain answer, nothing changes: help, a part the song lacks, nothing to change there, words it cannot read: "connect an AI") or `none` (the words are a new beat or song: "a house beat at 124", "make a sad trap song", "boom bap beat with swing"; these go to the generators as before). Selected notes still need an AI.
- `session.offlineEdits` counts the changes of the conversation (reset by New chat): it is part of the seed, so asking for "a new melody" again gives another one, and the same words in a fresh chat give the same one.

### Reading the words (`words.ts`, `scope.ts`, `interpret.ts`)
- `normalizeWords` (lower case, "&", counts as digits where a count belongs), `amountOf` ("a bit" small, "a lot" large, else medium), `decibelsIn` ("+3 dB", "down 3 dB"), `tempoChangeIn`, `keyChangeIn`, `splitClauses` (commas, "then", an "and" that starts a new request: "busier hats and a new melody for the chorus" is two clauses).
- The part (`scope.ts`): "bars 9–16", "from bar 9 to 16", "the first 8 bars", "the last 12 bars", sections by marker name or role ("the chorus" is Hook, Chorus and Drop alike; "verse 2", "the second verse", "the last chorus"; no ordinal means every match), and a place around a part ("into the chorus", "before the last chorus", "at the end"). The part picked in the playlist wins over the words. A part the song lacks is answered with the parts it has.
- Each clause is read by the first rule that fits (`RULES` order: specific before general, so "hit harder" beats "louder" and "add a breakdown" beats "fill"). A part named in one clause carries over to the clauses with none.
- **The guard**: when every clause names the same single part (or a part was picked), `guard` is that span and the app turns it into a range focus (`focusFromRange`), so the guard copies patterns shared with the rest of the song. A place around a part is not the part (no guard). Several parts at once ("the chorus" with three hooks) have no guard: patterns that also play elsewhere are left alone and named in the reply.
- `song-facts.ts` and `rule-kit.ts` hold what rules share (sections, which patterns play where, `patternParts`: the patterns and channels a note edit writes into: the part's patterns, or the source of every pattern for the whole song, since unmodified variations are rebuilt from their source when the answer commits).

### What it can do (`rules/`, with `help.ts` holding the words the help shows)
| Intent | Examples | Becomes |
|---|---|---|
| Hats and drums | "busier hats in the chorus", "simpler drums", "no hats in bars 9–16", "add a fill at the end of bar 8", "hat rolls" | `vary` double_hats / hat_roll / thin (level 2 normally) / without / fill / hat_roll, `develop` for fills through the song |
| Hit harder | "make the kick and snare hit harder", "punchier kick" | `note_tool` velocity-scale per pattern and channel; a clap layered under a snare that has none (`add_channel` + `write_notes`); saturation on the Kick bus and a sharper attack on the Drums bus (whole song only) |
| New melody | "write a new melody for the hook", "a different hook for the last chorus" | `write_notes` with `songMelody` from the chord track and a new motif seed, one pattern at a time, kept in the old line's octave |
| Chords | "change the chords in bars 9–16", "darker chords", "use seventh chords", "make it sadder" | `chords` progression (palette, not the one playing, by mood and style), then `voice_chords` (rhythm and register of the old part), `bassline` (808 style for an 808), `fit_melody`; `update_harmonies` when voices exist |
| Key, tempo, swing | "transpose up 2 semitones", "change the key to F minor", "tempo 128", "a bit faster", "double time", "swing 30%" | `song` key / bpm / swing; a key change also `chords` set (typed again, shifted), `note_tool` transpose on pitched parts, `edit_channel` pitch for a vocal; a named part only moves its notes and chords |
| Song parts | "add a breakdown before the last chorus", "make bars 25–32 a breakdown", "add a build", "add a drop", "add an outro" | breakdown: `vary` without drums and bass, `transition` dip and rise, a `marker`; build: double hats, hat roll, rise; drop: rise, crash, marker; outro: `arrange` appended after the end. Nothing is deleted. An intro before bar 1 is refused (it would move the song) |
| Variation, transitions | "more variation", "smoother transitions", "a riser into the chorus", "a crash at bar 17" | `develop`, `transition` |
| Vocals | "add harmonies to the vocal", "a third above and a fifth below", "clean up the vocal", "remove the breaths" | `make_harmonies`, `clean_vocal` on the voice clips (fixed distances when the song has no key) |
| Mix | "turn the lead up 3 dB", "quieter drums", "more reverb on the lead", "make the pads wider", "mute the hats", "pan the pad left", "level the mix" | `edit_insert` / `edit_channel`, `route`, `add_effect` stereo, `setup_mix` + `level_mix`; a named part gets an `automate` clip that goes back at its end, and mute becomes `vary` without |
| Style | "make it sound like house", "turn it into lo-fi" | `song` swing and tempo (when far from the style's range), the drums written again in the style's grid (`songDrums`) with `write_notes`, the 808 follows (`bassline`), a lo-fi effect for lo-fi |
| Other | "undo", "tidy up the song", "what key is this in", "help" | `command` edit.undo, `tidy`, replies |
Not done offline: making a melody or chords simpler or busier by themselves, an intro before bar 1, changing between major and minor, notes of a selection, sound design. These get a reply that says so and what to do instead.

### Tests
- `core/offline-edit/words.test.ts` (words); `app/assistant/offline-edit.phrases.test.ts` (78 phrasings against a generated trap song, the guard of 17 more, vocals, amounts, determinism, the empty playlist); `app/assistant/offline-edit.test.ts` (on generated trap, boom bap and house songs: hats busier in the named section only, chord track changed only in bars 9–16 and the pad on the new chords, every pitched note moved and the drums not, a breakdown with no drums and a marker, a melody on the chords that differs each time, 23 phrasings each one undo step, a picked part holds, the approval question, unknown words change nothing); `test/browser/ask-ai.test.ts` (the card).

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
channels ──► chIn ───────────────► routeIn ─► slot 1 … slot N ─► scTap ─► [gate] ─► preTap ─► pan ─► fader ─► postTap
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

- **Stages made when first needed.** A gain at 1 does nothing but cost the audio thread time on every block, so the mute/solo
  gate of an insert and the mute gate of a channel (`[gate]`, `[mute]` above) are made the first time that insert or channel is
  muted (at gain 1, so nothing changes until it moves), the channel's pitch signal (`PitchSignal`: the summing gain and its
  connections into the instruments' pitch params) when the pitch first moves, and a channel has no node of its own for its
  instrument's output (the instrument connects to the volume gain). Renders are bit for bit what they were
  (`test/browser/render-mixer-golden.test.ts`: hashes of a mix with pan, volume, sends, a bus, latency compensation, a mute and
  a solo, recorded before the stages became lazy).
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

### Idle parking (`engine/idle-parking.ts`, `engine/parking-plan.ts`, `engine/worklet-port.ts`)

Chrome pulls audio from the destination backwards through connections and processes every node it reaches, silent or not: about a
quarter of a microsecond for a gain, three for an AudioWorklet kernel, per 128-frame block. A project is mostly idle at any
moment (69 of the huge project's 200 channels sound in a typical four bars, none in a gap), so what cannot sound is cut out of
the graph until a note comes, and the audio thread pays for what plays. Measured on the huge project before this: 100 % idle.

- **Who says it sleeps.** The SDK's `Sleeper` (`docs/plugin-sdk.md`, "Sleeping"): `WorkletPort.sleep`, optional `sleep` on an
  `InstrumentInstance` or `EffectInstance`, and a ready-made `SleepSignal`. The SDK processor (`worklet/runner.ts`) already put a
  kernel to sleep after a second of silence (an instrument with no key held, an effect with silent input and output); it now also
  posts `{ t: 'sleep', received }` when it is asleep with nothing queued (`received`: how many messages it has taken in, every
  kind but sync and dispose) and `{ t: 'wake' }` when it wakes by itself (a note came due, sound reached an effect). The host's
  `WorkletPortImpl` counts what it sends and believes a sleep only when nothing is in flight, so a note on its way is never lost
  to a sleep reported before it arrived. `GraphVoices` (the Sampler, 3xOsc and the audio clip channels), the 808 (a timer that
  collects finished voices) and the algorithmic Reverb report theirs by hand; a convolution Reverb and every plugin that does not
  report never sleep as far as the mixer is concerned (a native-node effect is judged by its `tailTime`, below).
- **What a sleeping port does with events.** An instrument's port drops a note off and an all-notes-off (nothing is
  sounding; an all-notes-off used to wake every sleeping instrument at every stop), holds param changes (the latest of each) and
  the last eight transport anchors, and sends them in front of the next note or controller, which wake it. An effect wakes on
  sound, which the host does not see, so it is sent everything as usual and only notes (it may be following them), controllers and
  messages count as waking it. A kernel that sounds by itself with the song (`wakeOnTransport`) never reports a sleep.
- **What is cut.** Chrome only skips nodes nothing downstream pulls, and an AudioWorkletNode with no connected output is pulled
  by itself (measured: a worklet disconnected from everything keeps being processed; one whose gain is disconnected from the
  destination is not). So the cuts are made at the far end: a channel whose instrument has slept for half a second is taken off
  its insert's mix (`ChannelStrip.park`: the instrument and the volume, pan and mute nodes stop being processed), and an insert
  whose inputs are all parked and whose effects sleep is cut between its last effect and its sidechain tap (`InsertStrip.park`:
  the route inputs, the slots' gates and every effect stop; the tap, gate, fader and sends keep running on silence for a few
  nodes, which is where the idle 4 % goes, and meters, sends and sidechain keys downstream need nothing special).
- **When an insert may park** (`InsertParkingPlanner`, pure, `parking-plan.test.ts`): every channel routed to it is parked,
  every insert routed or sidechained into it is parked (so a chain of buses goes quiet in order), nothing else is attached to its
  channel mix or route mix (`OrderedMix.size`: a live input's monitor keeps it running), every effect that reports its sleep is
  asleep and every one that does not (native nodes) has had silence at the input for its `tailTime` plus half a second, summed
  over the chain (an echo can leave one effect after another has gone quiet). The master never parks (it also takes the preview,
  the metronome and the decks).
- **Waking.** The port that is handed a note sets `asleep` false before anything else, which calls `IdleParking.changed()`, which
  works out the plan again and puts the wiring back synchronously from the inserts out to the channel, before the note is
  posted: a scheduled note (one a MIDI effect generated too: it reaches the strip like any note) wakes its path at least a lookahead (120 ms) before it is due, and a live note on the very call, with
  no measurable cost (the engine's part of key-to-sound time: 1.29 ms into an awake channel, 1.29 ms into a parked one,
  `test/browser/idle-parking-perf.test.ts`). Parking waits for a 250 ms timer; waking never does. Topology changes (a new
  route, a slot added, an effect finished loading) re-plan at once.
- **Taps.** An AnalyserNode with an input and no output is pulled by the browser by itself, which would keep a parked plugin and
  everything feeding it being processed (every Analyzer, EQ Pro, Limiter, Multiband… has one), so `HostImpl.setParked` makes
  its taps let go of the node while parked and read silence (`TapImpl.setParked`); a tap on a sleeping strip reads silence
  without waking it. Insert meters read the fader's output, downstream of the cut. Sync barriers are messages and need no
  processing: a parked kernel still answers them.
- **Offline renders never park**: `Engine.idle` is absent, so the mixer graph is the one it always was (a port still drops and
  holds what a sleeping kernel has no use for, which leaves the audio exactly as it was: the hashes of the fixture songs did not
  move). `?nopark` on the app's address, or `idleParking: false` in the engine options, turns parking off in a live engine;
  `engine.stats().parked` says what is parked.
- **Traps found on the way.** `GraphVoices.add` cleaned up finished voices before registering the new one and put an empty
  instrument back to sleep under its own note (a kick lost: the meters test measured 0.6 LU quieter live); a held sleeping
  effect's param changes and anchors must not wait for the kernel's own wake, because by then audio is flowing (a ducker not
  ducking); an instrument whose voices end every few hundred milliseconds would be parked and woken in a loop, hence the half
  second before a channel parks.

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
never silenced by an insert solo. The mixer dims strips a solo silences. A solo-safe insert (see "Mixer snapshots and
groups") is never gated by a solo, and what it routes to stays audible with it.

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

## Mixer snapshots and groups

Snapshots save the mixer's values and recall them later; groups link tracks and give them a VCA. Both are optional
fields of the project (absent until used, so older projects and the fixtures stay as they were, and no schema bump:
`Mixer.groups`, `Project.mixSnapshots`, `Insert.soloSafe`), validated by repair (`core/schema/repair/groups.ts`,
`snapshots.ts`, `mixer.ts`): unreadable parts are dropped or put back to safe values, a group keeps only real tracks (the
master never, each track in one group) and goes when it has none, and a snapshot may outlive the tracks it remembers.

### Snapshots (`core/snapshots`, `core/ops/snapshots.ts`, `app/actions/mix-snapshots.ts`)

- **What is kept** (`MixSnapshot`): per track (the master too) its name, fader, pan, mute, solo, send levels by target and,
  per effect slot, the plugin id, bypass, dry/wet and the **values** of its parameters; the VCA levels; and, only when
  saved "with routing", who sends to whom (and whether before the fader) and each effect's sidechain source. No notes,
  patterns, clips, plugin `state` or samples: a snapshot of a 30-track mix is a few kilobytes, and recalling one can never
  change what is played. At most 64 per project.
- **Recall** (`recallSnapshot(draft, snapshot)`) writes exact values straight to the tracks, never through a group's
  links, inside one `history.transact`, so it is **one undo step** and undo restores every value exactly. Routing (when the
  snapshot has it) is applied removals first, then additions checked for loops, so a recall never makes audio loop. A track
  made after the snapshot is left alone; one deleted since is skipped; parameters are only restored while the slot still
  holds the effect that was saved. Recalling a state the mix already has changes nothing (no undo step).
- **Glide.** Recall passes `glideSec` (30 ms) to `transact`, which puts it on the `DocChange`; the engine's project mirror
  hands it to `MixerGraph.reconcile`, and faders, pans, the mute gate and send levels move with a time constant of a
  quarter of it (`AutoLane.setBase(…, glideTau)`) instead of the usual 4 ms, so switching while the song plays does not
  click. Ordinary edits carry no `glideSec`. Effect parameters are not glided here: they move the way plugin params do.
- **A/B.** The pair and the side are session state (`session.snapshotCompare`). `toggleCompare` recalls the other snapshot
  as a gesture-free `transact` with a merge key, so quick back-and-forth is one undo step. It is bound to Alt+Shift+B and
  to the A/B button of the mixer and of the Mix snapshots window; a deleted snapshot leaves the pair.
- **Diff** (`core/snapshots/diff.ts`): "what is different" as sentences with units, in mixer order ("Kick: fader −14.0 dB →
  −1.9 dB", "Kick · EQ: Gain −9.0 dB → +3.0 dB", "VCA of Drums: …"), against the mix as it is (`diffAgainstCurrent`: what a
  recall would change) or between two snapshots. Tracks and effects present on one side only are named once.

### Groups and VCAs (`core/ops/groups.ts`, `core/ops/linked-edits.ts`, `core/query/mix-groups.ts`, `engine/vca-stage.ts`)

- **Group** (`MixGroup`): name, colour, members, `links` (faders, pans, mutes, solos), a `mode` (`relative`: the others keep
  their distance, as a gain ratio for faders and an offset for pans; `absolute`: they all take the moved value) and
  optionally `vca`, a linear gain. Make one from the picked tracks (Shift- or Ctrl-click strips, session state
  `markedInsertIds`) with Group, or "Link selected", which joins them to the group one of them is already in.
- **Linking is done by the editing code, not by `setInsertProp`**, which stays a single-track write (snapshot recall, the AI
  and controller links write exact values to exactly the track they name). `planLinkedEdit(project, id, 'volume' | 'pan')`
  reads the track and its mates when a drag begins and returns an absolute recipe, so running it again with the same value
  gives the same result and dragging back restores everyone even where a mate hit the end of its travel (`useLinkedInsertEdit`
  in the mixer). A fader that starts at silence has no ratio, so its mates stay. `setMutedLinked` and `toggleSoloLinked`
  do the same for the switches (soloing a group solos all of it). All of it is one undo step per drag or click.
- **VCA.** The level multiplies the members' levels in dB and moves no fader. In the engine each member strip gets one
  `GainNode` between the fader and its post-fader tap (`VcaStage`): the strip's sound, post-fader sends and meter are scaled;
  pre-fader sends and the sidechain tap are not. It adds no latency and costs one gain; a strip whose group has no VCA has no
  node, so projects without VCAs render exactly as before (and a group whose VCA is at 0 dB renders bit for bit like no
  group). A node, once made, stays at unity when the VCA goes (so taking it away never clicks). Each member has its own
  `AutoLane` registered under `vca:<groupId>` (the automation target `{ kind: 'vca', groupId }`, on the fader taper like a
  track's volume; labelled "VCA · name"), because members sit different delay-compensation times behind the song's clock:
  the automation driver already handles several lanes under one key, and each gets its own shift. Realtime and offline
  use the same lanes. Where several members sum, `OrderedMix` is untouched: the VCA adds no new summing point, so two
  offline renders stay bit-identical (`test/browser/mixer-groups.test.ts`).
- **Solo-safe** (`Insert.soloSafe`, right-click a strip): `soloState` keeps a solo-safe insert audible while another is
  soloed, with what it routes to (so it still reaches the master); its sources are not brought back. A mute still wins.

### UI (`ui/features/mixer`)

The mixer has a toolbar (Snapshots, Save, A/B, Group, Link selected), a coloured band on grouped strips (click: pick the
group; right-click: its menu), a VCA strip per group with a VCA (right after the Master, a fader like the others: drag,
wheel, double-click for 0 dB, right-click for automation), Shift/Ctrl-click to pick tracks (with an "Pick this track too"
menu entry for touch) and "Solo-safe" in the strip menu. The Mix snapshots window (View menu, Alt+Shift+S) lists the
snapshots: click a name to recall it, A and B to set the pair, Diff for what is different, ⋯ (or right-click) for update,
rename and delete; it says what to do when empty. Every control has a `data-hint` with units; nothing is hover-only.

### AI and MCP

`mixer_snapshot` (save, recall, compare, update, rename, delete, diff) and `mixer_group` (create, edit, remove, vca_level)
run inside the answer's one undo step; `edit_insert` takes `solo_safe`; automation targets take `kind: "vca"` with a
`group`. Reads: `get_mix_snapshots` (with `diff`), `get_mix_groups`; `get_mixer` names a track's group and solo-safe flag.
`compare` also sets the A/B pair for the musician's switch after the edit (`mixerStateAfter`). MCP gets all of these through
the same op and read-tool lists.

### Limits

Linking applies to the mixer's own controls (faders, pans, strip buttons): a MIDI controller link or automation recording
moves the one track it names; use the VCA (a link target and automation target) to move a group from a controller. The A/B
glide covers faders, pans, mutes and sends; effect parameters and bypass jump the way they always do. A track is in at
most one group. Snapshots do not keep effect plugin `state` (only parameter values) or the order of effect slots.

## Effect racks (`core/model/rack.ts`, `core/ops/racks.ts`, `core/rack`, `engine/rack`, `engine/slot-chain.ts`, `app/racks`, `ui/features/rack`)

A rack is one effect slot of an insert that holds a small graph of effects, so a sound designer can build a complex effect from
the built-ins, move many settings with eight macro knobs, save it and share it. Everything inside is ordinary data and
ordinary effect instances: nothing about a rack needs a new kind of plugin.

### What is stored (`FxSlot.rack`, optional, added in v3 without a version bump)

- The slot's plugin is the built-in `agstudio.rack` (`RACK_PARAMS`: `macro1` … `macro8` as 0–1 floats and an output `gain` in dB), so
  the macros are **plugin parameters**: automation, MIDI learn, mixer snapshots, the AI's settings and the generic knob panel work on
  them with no rack-specific code. The rack's dry/wet is the slot's `mix`.
- `Rack` (`core/model/types/rack.ts`): a `split` (`parallel`, `bands`, `midside`, `leftright`), `crossovers` (Hz, one fewer than the
  bands), one to four `branches` (id, name, `levelDb`, `pan`, mute, solo, and `fx`: ordinary `FxSlot`s with no sidechain, never racks:
  at most 8 per branch) and eight `macros` (a name and `MacroMapping`s: a target, `min`, `max` in the target's own units and a
  `curve`: linear, exponential or inverted).
- **An effect inside a rack has a slot id that is unique on its insert**, so `{ insertId, slotId }` finds it anywhere: its plugin
  window, presets, taps, `setPluginParam`, controller links, automation targets and snapshots needed no new owner type. The
  lookups that went through `insert.fx.find` use `locateSlot` (`core/query/rack.ts`) now.
- Targets of a mapping (`MacroTarget`): an effect's parameter, an effect's dry/wet, a branch's level or pan, a crossover, the rack's
  output. A target follows at most one macro. `pruneMappings` drops mappings whose target went (an effect removed or moved out, a
  branch merged, a split that has no crossovers).
- Edits (`core/ops/racks.ts`, draft mutators like the mixer's: one `history.transact` each, so one undo step): `addRackSlot`,
  `groupIntoRack` (the chosen effects become one branch, keeping their ids), `ungroupRack`, `setRackSplit` (branches are added or the
  last ones removed to fit; default names follow the split), `addBranch`, `removeBranch` (a `bands` rack merges the band and drops a
  crossover), `setBranch`, `setCrossover(s)`, `addRackFx`, `removeRackFx`, `moveRackFx` and the macro edits. `addFxSlot` and
  `replaceFxPlugin` give anyone who adds the rack plugin an empty rack.
- Repair (`core/schema/repair/rack.ts`): the number of branches a split takes, crossovers ascending and apart, eight macros with names,
  unique ids, no rack in a rack, no sidechain inside, mappings only to targets that exist, one macro per target.
- Mixer snapshots keep what a recall can restore: the macros and output (parameters of the rack slot), every effect inside under its
  own slot id (`SnapshotSlot`), and `SnapshotSlot.rack` (branch level, pan, mute, solo and the crossovers); the diff names them.

### Engine (`engine/rack/`, `engine/slot-chain.ts`)

```
input ─► split ─► branch 1 … branch N ─► sum (OrderedMix) ─► output gain ─► output
branch : feed ─► head ─► effect 1 … effect N ─► tail (mute/solo gate) ─► [alignment delay] ─► level ─► pan
```

- **`SlotChain`** is what an insert's slots always were (keyed `FxSlotStrip`s wired in series, their latency, tail, parking,
  alignment, automation and plugin reloads), pulled out of `InsertStrip` so a branch uses the same code: an effect inside a rack is an
  `FxSlotStrip` like any other (async load, fades, bypass, faults, taps, sleeping kernels). The rack is an `EffectInstance`
  (`RackEffect`) made by the slot through the built-in definition `RACK_DEF` (`HostDeps.rack` hands it the slot's view; the engine
  wraps its plugin resolver so the rack needs no installing).
- **Splits** (`rack-split.ts`, native nodes): `parallel` feeds every branch the input; `bands` is a Linkwitz-Riley tree (24 dB/oct from two
  Butterworth biquads per side; every band but the top passes through a second-order allpass per crossover above it, because the sum
  of an LR4 pair is exactly that allpass), so the bands add up to the input again with only the phase turned: **flat to 1e-5 dB from
  30 Hz to 18 kHz for 2, 3 and 4 bands**; `midside` gives the first branch (L+R)/2 and the second (L−R)/2, each on both channels, and puts
  the mid back as it is and the side as (+S, −S), so an empty M/S rack is the input to within 1e-6 (and effects that make stereo out of
  a dual-mono side keep it); `leftright` gives each branch one channel and puts each result (mixed down to one channel) back on its side.
- **Latency** (PDC): a branch's latency is the sum of its live effects'; the rack's is the slowest branch's, and every quicker branch (the
  dry one, an empty one) gets a delay of the difference after its chain, so the branches add up in time (an impulse through branches of
  375, 160 and 0 frames comes out as one impulse). The rack reports the total to its slot (`RackBuild.onLatency`), which rebuilds its
  latency-aligned dry path (`FxInstance.setLatencyFrames`) and tells the mixer's delay compensation; it follows effects loading,
  bypass, adding and removing. **Muting or soloing a branch never changes the latency** (the delay stays), so nothing shifts in time.
  Parameter shifts follow: each branch's chain is moved by the preceding effects' latency, the levels and pans by the rack's total.
- **Sleeping and cost**: a branch that does not sound (muted, or left out by a solo) fades out and is then cut off at both ends and its
  chain parked, so nothing in it is processed (an unused branch costs nothing). The rack asks of its insert's idle parking only what the
  audible branches need (`NestedEffect.idleNeeds`: the effects that report their sleep must sleep, the others need silence for their
  tail), reports its own tail (the longest chain), and passes `setParked` to the effects' taps. Offline renders never park.
- **Determinism**: the branches join through an `OrderedMix`, the M/S and L/R decodes are attached in a fixed order, and two offline
  renders of a rack with latent effects, bands and automated macros are bit for bit the same.

### Macros (`macro-links.ts`, `AutoLane.follow`, `core/rack/mapping.ts`)

A macro is the `ParamHandle` lane of its rack parameter, so it already has everything a parameter has: the document value, automation
clips (scheduled ahead on the audio clock), controller links. A mapped target's lane **follows** it (`AutoLane.follow(source, map)`): the
source lane binds a small relay in place of an `AudioParam`, and every `set`, ramp, target and cancel it schedules reaches the target
lane mapped through `macroTargetValue` (and from there the target's own `AudioParam`s and its `onChange` listeners, so effects that
take a parameter as an event follow too). So a macro sweeps a mapped parameter sample-accurately in realtime and offline, a long ramp
of a bent map (exponential, log knob, stepped parameter) is cut into 20 ms pieces (at most 64) so a frequency sweep stays even in
octaves, a plugin made later starts at the followed value (`ParamHandleImpl.value`), and a followed lane ignores its own document
value and automation until the mapping goes (it then ramps back to its own value). The map works in the target's **knob travel**
(`toNormalized`/`fromNormalized`), so 200 Hz → 8 kHz moves evenly in octaves; `exponential` is the position squared. A new mapping
starts at the target's value now and sweeps toward the end of its range that is further away (`startingRange`), so the sound does not
jump. Effects inside a rack run as full processors (AudioParams) while the rack's macros are automated.

### Racks you can pick (`app/racks`, `core/rack/file.ts`)

- **Factory racks** (`factory.ts`, data: plugin ids, presets, settings and what each macro moves, by place in the rack): Parallel NY
  compression, Multiband saturation, Mid/side widener, Dub delay throws with macro, Lo-fi tape with macro. Each builds with new ids
  (`build.ts`), every macro moves something real (a test sweeps each macro 0 → 1 on stereo noise and requires a change), and each stays
  within 9 dB of the level that went in.
- **Your racks**: `PresetLibrary.saveRack` (IndexedDB `user-racks:v1`, repaired when read), by name like chains; `.agrack` files
  (`{ format: 'agstudio-rack', version, name, description?, slot }`, `readRackFile` says what is wrong in plain words and repairs small
  damage, listing each repair; samples and sidechains are not kept; the rack needs its effects installed). A rack put on a track is
  cloned with new slot, branch and mapping ids (`cloneSlotWithNewIds`).
- AI and MCP: `add_rack` (a catalog name, or an empty rack with a split), `edit_rack` (split, crossovers, dry/wet, output, bypass,
  ungroup), `rack_branch`, `rack_effect`, `rack_macro` (name, value, map with range and curve, unmap, clear), `group_into_rack`,
  `save_rack`; `edit_effect` and `remove_effect` take an effect inside a rack by id or `@ref`; the read tools `get_racks` and the
  rack inside `get_mixer` (branches, effects, macros with what each drives and the sweep in units); the plugin catalog lists the racks.
  A macro is automated through the automation action with the rack's `macro1` … `macro8`.

### UI (`ui/features/rack`)

- **Rack window** (type `rack`, opened by double-clicking a rack slot, from the browser's Racks, or with `open`): the split selector, the
  rack's dry/wet and output, the eight macro knobs (named, double-click to rename, a ◆ count of what each moves; click one to list its
  mappings with the range ends in the target's own kind of input, the curve and a way to let go), and a column per branch (rename, mute,
  solo, level and pan knobs, effect cards with bypass, dry/wet and a menu, **drag a card to another branch or place**, drop an effect
  dragged from the browser, `+ Add effect`), with a crossover knob between two bands. An empty rack and an empty branch say what to do.
- **Map to macro** is a submenu of the right-click menu of every control a macro can move (`addParamMenuItems`: an effect's knobs in its own
  window or a card, its dry/wet, the rack's output; the branch and crossover knobs have their own menu): the macro starts where the
  setting is. A mapped knob shows a diamond mark (`ParamStatus` kind `macro`) and says which macro moves it; an effect's own window says
  "In rack · branch" with a button back to the rack.
- **Mixer slots**: a rack slot shows "Rack · 2 branches" and opens the rack window; Ctrl- or Shift-click marks slots (an outline,
  `session.markedSlotIds`), right-click offers **Group into a rack** (the marked slots, or just this one), and for a rack **Ungroup**,
  Save as my rack…, Export as a file…; Add ▸ Effect rack and the browser's Racks section put a factory rack, one of yours or an empty
  one on the selected track. Commands: `mixer.addRack`, `mixer.groupIntoRack`, `mixer.importRack`.

### Tests and measurements

`src/core/ops/racks.test.ts`, `core/rack/rack.test.ts` (ops, undo, repair, snapshots, mapping maths, `.agrack` round trip),
`app/racks/racks.test.ts`, `app/ai/ops/racks.test.ts`, `engine/param-lane.test.ts` (follow), `test/browser/rack.test.ts` (alignment of
branches of 375, 160 and 0 frames; PDC total 535 for chains in series, 160 after bypassing the slow effect; bands flat; mid/side and
left/right round trips to 1e-6; macro maths by hand and by automation, exact; renders identical), `rack-factory.test.ts` (the five
racks on stereo noise), `rack-realtime.test.ts` (a live engine: a macro turned while the song plays, the latency the lo-fi effect
inside reports), `rack-ui.test.ts` (the window, menus, drag and drop, named controls).
Cost (offline, 8 s of noise through EQ Pro, Compressor, Saturator and Chorus, best of four, wall clock around the render only, a busy
machine): the four effects on the insert 732 ms, the same four in a one-branch rack 745 ms (+2 %), one to each of four parallel
branches 775 ms against 768 ms (+1 %), one to each of four bands 969 ms (+26 %: fifteen biquads and the extra sums).

### Limits

A rack cannot contain a rack, and an effect inside one takes no sidechain from a track (it keys from its own input). Moving an effect
to another branch rebuilds its instance (its tail restarts). Macro automation reaches an effect that sits after latent effects in its branch earlier than it
is heard (by their latency: a few milliseconds at most). A rack's own latency is not shown as a number
(the mixer's "Delay comp." is). Ungrouping a multi-branch rack puts all the effects in one chain (the parallel routing and the macros are
lost). A snapshot does not keep branch order, names or macro mappings.

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
  scale" shades out-of-scale rows, tints the root's rows and dots the scale's keys; "Scale lock" (was "Snap to scale") snaps drawn and
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
- **MIDI effects and recording**: on a channel with MIDI effects, note recording keeps the keys played or the notes the effects made of them
  (`prefs.recordMidiFx`, Options > Record MIDI effects; `LiveInput` re-emits the engine's generated notes as `fxOn`/`fxOff`), see MIDI effects.
- **AI**: `transport` actions can `record` (arm and play) and switch the metronome.

## MIDI effects (`core/midi-fx`, `core/ops/midi-fx.ts`, `engine/sched/fx-events.ts`, `engine/live-midi-fx.ts`, `app/actions/midi-fx*.ts`, `ui/features/midi-fx`)

A chain of effects per instrument channel that changes the notes on their way to the instrument, for the song and for live keys
(FL's channel arpeggiator, Ableton's MIDI effects). Ten effects: **Arpeggiator** (up, down, up and down, random, as played, chord;
rate 1/4 to 1/32 with triplets and dotted notes; 1 to 4 octaves; gate; swing; start on the key press or on the song grid; latch;
velocity as played, fixed or accented), **Chord** (a named shape, notes you add, stacked in the song key, or the chord track's chord;
inversion, open, drop 2, spread), **Scale** (snap or filter to the song key, the chord track's chord or a scale you pick), **Note repeat**
(a roll with a loudness ramp), **MIDI echo** (synced delay, feedback, pitch and length per echo), **Humanize** (timing in ms, velocity,
seeded), **Velocity** (compress or expand curve, fixed, range), **Transpose**, **Note length** (fixed, scaled, legato) and **Random**
(chance to play, octave jumps, seeded). Pitch bend and modulation generators are not part of it.

### One pure function runs everywhere (`core/midi-fx`, no DOM, unit tested)

- `FxNote` is a note in ticks on the song's timeline (fractions allowed; `end` is Infinity for a key still held, live) with a stable
  `id`. An effect is a `MidiFxDef`: `params` (SDK `ParamSpecs`, so the window, the automation menu and the AI get labels, units and
  ranges for free), `presets`, `reach(values)` (how far it can move a note sooner or later, in ticks) and
  `run(input, run) → notes`. `runChain(active, input, span, context)` runs the enabled effects in order and returns the notes that
  start in `span`, sorted; each effect is asked for the span widened by the reach of the effects after it, and nothing carries state
  between calls. The chain, the notes and a context (`FxContext`: song key, `chordAt(tick)`, `msToTicks`, `live`, `automated`)
  fully decide the output.
- **The grid is the song's, not a clock's.** The arpeggiator finds *groups* (the stretches during which notes overlap) and puts its
  steps on `groupStart + k·step` ("on key press") or on multiples of the step ("next step of the song grid"); the note a step picks
  is a function of the notes held at that tick and the step number. A group always gets its first step, so a key tapped between two
  grid steps still plays once. Latch lets a group's notes ring until the next group begins. So any window of the song asked for in
  pieces, planned again after an edit, or baked, gives the same notes: **re-plans keep arpeggios in phase by construction**
  (`midi-fx.test.ts` renders with an edit in the middle).
- **Seeded and repeatable.** Randomness is a hash of (the slot's `seed` param, the effect id, the note's identity and start): the same
  note always gets the same draw, a re-plan or a bake changes nothing, and editing one note never reshuffles the others. Humanize
  and Random draw per note; the arpeggiator's random pattern draws per step. A live humanize can only delay (a key cannot be moved
  before it was pressed).
- **Music theory in core.** Core may not import the SDK's note theory, so `scale-tools.ts` builds on `core/harmony` (`scalePitchClasses`,
  chord qualities); the scale ids match the SDK's.

### In the model

`InstrumentChannel.midiFx?: MidiFxSlot[]` (absent = none; at most `MAX_MIDI_FX` = 8): `{ id: 'mfx_…', effect, enabled, params }`, no
version bump (an older project has none, an older app ignores the field). `core/ops/midi-fx.ts` has add, remove, move, enable,
set a param (checked against the param's spec), reset, `setMidiFxChain` and `planOfSlot`; every edit goes through History like any
other. Repair (`schema/repair/midi-fx.ts`) drops what is not a slot, makes ids unique, fills the bypass switch and clamps settings; a
slot of an effect this version does not know is kept (a newer version made it) and skipped. A knob is an automation target:
`{ kind: 'midiFx', channelId, slotId, paramId }` (key `mfx:ch:slot:param`), so "Create automation clip" and "Link to controller…" work
as on any knob. The engine has no audio param to drive, so the chain reads the clip's curve where each note falls
(`FxContext.automated`, song mode only; a pattern played on its own uses the knob's value, and live play does too).

### In the schedule (`engine/sched/fx-events.ts`)

`collectNotes` hands a channel with an active chain to `collectFxNotes`: the pattern's notes become `FxNote`s on the clip's timeline
(unswung, cut at the clip's end, none before its start), `runChain` turns them into the notes to play, and **the project's swing is
applied last**, to generated notes like any other (so an arpeggio swings with the song, and a bake writes unswung notes). The result
is evaluated in **blocks of whole pattern repetitions** (about 32 bars, at fixed places in the clip, with the chain's reach of notes
on either side) and cached per (the channel's notes in that pattern, the chain, key, swing, time signature, chords, tempo map and
the automation of its knobs, the clip's place): an unrelated edit during playback costs nothing. Each generated event carries
`fx` (its id in the chain's output) instead of a `noteId`; `fxNoteEnd` is how a re-plan finds out whether a sounding generated note
is still made (and where it ends) instead of cutting it. The chord track is read at song ticks for song clips, through the pattern's
first place in the song for a pattern played on its own, and not at all for the clip launcher. `SchedulingWatch` re-plans when a
chain, the chord track or the automation of a knob changes (and only then: a project without effects is as it was).
Generated notes go to the strip like any other, so delay compensation, the note feed (melody-following effects), idle parking
(a generated note wakes its instrument a lookahead before it is due, exactly as a pattern note does) and offline renders need nothing
special. The MIDI export (`collectNotes`) includes them.

### Live keys (`engine/live-midi-fx.ts`)

`NotePreview` sends a key to `LiveMidiFx` when the channel has an active chain (`handles`: a map lookup; a channel without effects
takes the old path unchanged). The held keys are `FxNote`s with an open end; the chain runs on `[change, now + 70 ms)` on every key
event and on the scheduler's worker clock (25 ms) while anything is held, latched or ringing, and its notes are handed to the strip
with their audio times. Notes that cannot have started yet (more than 10 ms ahead) are taken back when the keys change; started
ones keep going; an output that is still held (a transpose) is released with its key. The clock is the song's while it plays
(`Engine.tickAt`, so an arpeggio lines up with what is heard) and a free-running one that starts at the first key while it is
stopped: **the first step plays the moment the key goes down** ("on key press"), or at the next song-grid step with "Start: next step
of the song grid". Latch goes on after the keys are up until a new chord is played or Stop is pressed (`Engine.stop` ends live
effects, like panic). Editing the chain while keys are held re-plans at once. `EngineApi.onLiveFxOutput` tells the app when a
generated note starts and ends (the engine host passes it across reboots); `LiveInput` re-emits them as `fxOn`/`fxOff`, which
the note recorder keeps instead of the keys played when `prefs.recordMidiFx` is `generated` and the channel has effects.

### UI, commands, AI and MCP

The window `midi-fx` (`Alt+E`, View menu) follows the selected channel: cards in chain order, each with a bypass LED, presets (ready
made, yours, save, reset), move earlier/later buttons, `Alt+Shift+Up/Down`, drag by the header, remove, and the knobs of its
`ParamSpecs` through the SDK's `AutoPanel` (right-click: automation, controller link). The same panel sits at the foot of an
instrument's window, and the channel rack shows a small badge on the name ("ARP", "CHD+2": the first effect and how many follow;
dimmed when every effect is bypassed). The toolbar has Add effect, Chains (ready-made chains, yours, save this chain, render, remove
all) and **Render to notes** (`bakeMidiEffects`: `collectNotes` in pattern mode for every pattern that has notes for the channel,
written as ordinary notes in one undo step, the effects removed, or bypassed with `keepEffects`; the swing stays the project's).
Your presets and chains are kept in the preset library (`midifx:<effect>` and `midifx:chain`). The piano roll's **Effect notes** button
shows the notes the effects make of the pattern faintly behind its own. Commands (category "MIDI effects"): `midiFx.add`,
`midiFx.bake`, `midiFx.bypass`, `midiFx.clear`, `midiFx.chain`, `view.midiFx`, and the Options menu's "Record MIDI effects"
(`transport.recordMidiFx`). Studio and MCP: `add_midi_effect`, `edit_midi_effect`, `remove_midi_effect`, `midi_effects_chain`,
`render_midi_effects`, automation target kind `midi_effect`, `settings` `record_midi_fx`; the catalog lists the effects (settings,
presets) and the chains, the project text adds a line under a channel that has effects, and `get_channel` returns `midi_effects`.

### Measured (headless Chrome, M-series Mac, 48 kHz)

`test/browser/midi-fx-live.test.ts` (engine part of the key-to-sound time, `npm run test:perf`): a plain live key 1.29 ms median, a key
on a channel with an arpeggiator 1.29 ms (difference 0.00 ms, n = 30 each); the `previewNoteOn` call itself is 0.000 ms median
(p95 0.005) on a plain channel and 0.020 ms (p95 0.055) with an arpeggiator. Offline (`test/browser/midi-fx.test.ts`): every onset of a
1/16 arpeggio lands on its frame exactly (6000 frames apart at 120 BPM, also triplets at 4000 and swing at +3000) at chunk sizes of
16, 37 and 256 render quanta; two renders of an arp + humanize + echo + random chain are bit-identical; a render with the effects
and a render of the same notes written by "Render to notes" are identical sample for sample (with project swing).

### Limits

- Pitch bend and modulation generators are not effects. The chain is per instrument channel (not per pattern or clip).
- Live humanize can only delay; live legato and the scale mode of Note length can only lengthen (the release is not known in
  advance). Live play does not read knob automation or the clip launcher's chord context.
- The chord track is read at the pattern's first place in the song when a pattern plays on its own, so a bake follows the chords
  under the pattern's first clip; the same pattern in two places of the song sounds with each place's chords.
- Recording the generated notes then playing them through the same chain processes them twice: turn the effects off (or render) first.
- A repeat's, echo's or arpeggio's reach is taken from the knob's value, not from its automation; automating the number of echoes
  above the set value can cut the tail of the last echoes at a block's edge.

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
- **Context** (`app/ai/context/`, one module per part of the text) each turn: song, channels with non-default plugin settings and
  routing, mixer tracks with levels, routes, effects (settings, bypass, sidechains), patterns (notes of
  the current one), playlist clips and the selection. The plugin and command **catalog** is a compact
  index in the system prompt (`app/ai/catalog-index.ts`); the settings, ranges, units and presets (`app/ai/catalog.ts`)
  of the plugins a request most likely needs come with the request, and the rest through read tools (see "AI context:
  cached prefix, index, lookups" below). The system prompt (`app/ai/prompt.ts`) carries the control rules, the
  beat/mixing know-how and that index.
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
- **Driving the whole app** (`ops/session/`, `ops/windows.ts`, `ops/query.ts`, `read/`):
  - `settings` (preferences, audio, export defaults, the editors' tool and grid), `select` (channel, mixer track,
    pattern, clips, notes, the loop region), `save_preset` and `open` with `action` (close, focus, maximize,
    restore any window or the browser panel). They change stores that are not the document: no undo step. They
    run right after the edit (an answer can write notes and select them) and report in `AppliedTurn.ui`, which
    is why a dry run leaves them out.
  - Extensions of existing ops: `song` title/author, `edit_channel` sample/root_key/position, `edit_insert`
    position, `add_pattern` from (copy) and split_by_channel, `edit_pattern` position.
  - **Read tools** (`app/ai/read/`, `readTools` in `read/index.ts`: name, description, JSON schema, `run(s, args)`): get_project,
    get_transport, get_selection, get_pattern_notes, get_channel, get_mixer, get_clips, get_automation,
    get_settings, get_windows, get_plugins. Compact JSON in the units the actions take (dB, 1-based bars, 1/16
    steps, MIDI keys); a bad argument returns `{ error }`. The MCP server lists the same array.
  - **Look-ups in the chat**: the `query` action (`tool`, `args_json`) runs a read tool after the edits and
    returns the result in `AppliedTurn.queries`; the assistant asks again with a `<lookups>` block (at most 3
    rounds, 4 tools per answer). This is the fallback: when the AI can call the same read tools itself during the turn
    (through MCP) it does not need a round trip.
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
  - The `command` action runs any registered command by id (`app/ai/commands.ts`). The catalog index lists every
    command's id with a short label (one line per area); the details (title, hint, `argsHint`) of the ones a request needs
    are attached, `get_commands` gives the others.
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
  6. The result card also has Share…, which packs the files into a `.agplugin` bundle (see "Sharing and managing plugins").

### Asking the AI about a part

Select clips, loop some bars, pick a marker's section or some notes, and tell the AI what to change there: only that
part changes, as one undo step.
- **Focus** (`app/ai/focus/`): `AiFocus` is a range, a section (marker id), clips or notes, each with its
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
  a part is read by the offline editor ("Offline edits"; selected notes still need an AI). `listenAndAsk` renders just the part (`AnalyzeOptions.range`).
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

### AI context: cached prefix, index, lookups

A new chat used to send the whole catalog in its first turn: system prompt 58 809 characters, answer schema 108 915,
and a first-turn text of 105 918 on an empty project (the project 1 588, `<plugins>` 49 967, `<commands>` 54 320;
143 463 with a 200-channel song). Nearly all of it was the same in every chat, and it only reached the AI's prompt cache
within one chat. Three changes fix that (the answer schema is not slimmed yet).

| characters sent by a new chat | before | after |
|---|---|---|
| system prompt | 58 809 | 76 651 (rules 59 683 + catalog index 16 966) |
| answer schema | 108 915 | 108 973 |
| turn text, empty project, "make a dark beat" | 105 918 | 5 404 (project 1 588, details 3 775) |
| turn text, 200-channel song, same request | 143 463 | 46 595 (project 39 133, details 7 421) |
| turn text, empty, "add a warm pad with a long reverb" | 105 918 | 12 012 (details 10 366) |
| turn text, empty, "sidechain the bass to the kick and export an mp3" | 105 918 | 14 057 (details 12 396) |

What changes from chat to chat is now the 5 000 to 14 000 characters of the turn (the project and the details), not
106 000. The system prompt, the schema and (for the API and CLI backends) the 32 read tool definitions (24 010 characters)
are byte-identical while the installed plugins and commands are, which is what lets the prompt caches reuse them.
`test/unit/ai-first-turn.test.ts` and `test/browser/ai-request-size.test.ts` hold the sizes (system under 72 % of
`MAX_SYSTEM_CHARS`, text under 20 % of `MAX_TEXT_CHARS`).

- **A stable cached prefix** (`app/ai/prompt.ts` `studioSystem`, `app/ai/catalog-index.ts`). The system prompt is the rules
  (`studioPrompt()`: intro, how to act, the ops' sections, the example) then the catalog index, as two blocks that join with a
  blank line. Nothing in either varies: no clock, no id, no random value, a fixed order (kind, built-in before the musician's
  own, then id in code-unit order, never the locale's), and nothing the musician can change without installing something
  (their presets and chains are in the details, not the index). The index says `Catalog index v<hash>`: the hash of its data
  lines changes exactly when a plugin, tool, chain or command is added, removed or changed. A test builds two apps, two new
  chats and a reload and requires the same bytes, and requires that a new plugin changes only the second block.
  - **A change in the middle of a chat** is told in the turn text (`beat-assistant/catalog-blocks.ts`): a `<catalog-changes>`
    block with the added, changed and removed lines (or the whole new index when more than 40 % moved, or after a reload,
    when only the version was saved). What each backend's conversation knows (version, index lines, which details it was sent)
    lives in the assistant session (`catalogKnown`, in memory; the version is saved with the tab as before) and is recorded
    only once the answer has come back (`commit`), so a request that failed is told again.
  - Each conversation keeps the system prompt it began with: the Claude CLI records it per session (`--system-prompt-snapshot`
    is on by default), and the API backend keeps it with the session's history (`ApiSession.system`), so a new plugin never
    changes the cached prefix of a chat that is going on.
- **A compact index and predicted details** (`catalog-items.ts`, `catalog-index.ts`, `predict.ts`, `catalog-details.ts`).
  `catalogItems(services)` is the one flat list (instruments, effects, piano-roll tools, effect chains, factory effect racks, MIDI
  effects and their ready-made chains, commands; the musician's own chains and racks are left out of the index so saving one
  does not change the system prompt). MIDI effects count with the plugins in the guess, racks and MIDI chains with the chains.
  The index has one
  line per plugin (`id | name | kind | category | up to 10 words | N presets`), per tool, rack, MIDI effect and chain, and one line per command
  area (`Transport: transport.metronome, transport.countIn*, …`: ids with a label of up to three words, none when the id says it,
  a star for "takes an argument"). Descriptions are cut on a phrase, never on "and" or "with".
  - **The guess** (`predictItems`) runs without a model, on the action search's own word matching (`core/search/rank.ts`,
    moved out of `ui/features/palette/search.ts`, which still uses it): each word of the request (little words dropped, plus a
    table of producer words such as "grunge", "pump", "harmonies" in `predict-words.ts`, and word stems) is matched to every
    item's name, category, keywords and description; a word that matches many items counts less; an item that matches more of
    the words counts more. The song adds: the plugin of the selected channel and the effects of the selected mixer track, the
    plugins of channels playing in the part the request is about, plugins whose channel or track the request names ("the
    lead"), the plugins the song uses and the areas it uses (chords, lyrics, launcher). The budget is 8 plugins or tools, 2
    chains and 30 commands (`DEFAULT_DETAILS_BUDGET`), each kept only when its score is at least a quarter of the group's best.
  - **The details** are the old catalog text of those items (settings with kind, range, unit and default, presets, the
    musician's own presets, a command's `argsHint`), in a `<details>` block of the turn. A conversation is sent an item's
    details once (and again when they change): the follow-up "more reverb" carries none.
  - **How good the guess is** (`test/unit/ai-predict.test.ts`, requests in `test/helpers/predict-cases.ts`, each need a list of
    acceptable alternatives): 49 of 49 needs on the 48 requests the producer words were tuned on, 14 of 14 needs on 12
    requests written before the tuning and not looked at while tuning, and 13 of 15 on a second batch of 15 written after it
    (the honest estimate for a request nobody tuned for: about 87 %). The two misses of that batch: "sound like a
    cathedral" (the Reverb has a Cathedral preset, but presets are not searched: it got its word and joined the tuned
    requests) and "I want the kick to push the bass out of the way" (a sidechain in plain words: still missed; the AI finds
    the Ducker with `search_catalog`). A miss costs a read-tool call, not a wrong answer.
- **Lookups during the turn** (`app/ai/read/catalog-tools.ts`, `tools/ai/lookup.ts`, `tools/mcp/lookup-scope.ts`). Three read tools
  join the others: `get_plugin_details {ids}` (plugins, tools and chains by id or exact name, up to 12, with "did you mean"
  for an id it does not know), `get_commands {ids | area}` and `search_catalog {query, kind, limit}` (the guess's ranking,
  ignoring the song). The system prompt says: details for the likely items are attached; look up anything else before using it
  with a read tool, or, when the turn says there are none (a `<tools>` note), with a `query` action; never guess a setting id,
  a range, a unit or an argument.
  - **The read-only door.** `POST /mcp?scope=lookup` serves the full MCP protocol but lists and runs only
    `LOOKUP_TOOL_NAMES` (the read tools of the chat, `app/mcp/defs.ts`): any other name is "no such tool". Its calls run as the
    client `agstudio-studio`, which the page answers without a toast and the settings do not list. The token is the same one;
    a caller can only narrow its own access.
  - **How a backend gets there.** The page says `readTools: true` in the request when `/api/ai/status` reports
    `lookups: { mcp: true }` (a dev server; a preview server says false) and `prefs.mcpEnabled` is on. The server builds a
    `LookupAccess` per request (never from the page): `http://localhost:<port>/mcp?scope=lookup`, the token file (made through
    the shared token store when missing), Node and `bin/agstudio-mcp.mjs`, and the tool names. **The token is never put in a
    config file, a command line, an environment or a log:** the helper reads it from its file for every request
    (`AGSTUDIO_MCP_TOKEN_FILE`); the API backend's client reads it the same way and sends it only to the endpoint on this machine.
  - **Claude Code CLI**: the turn's flags are `--safe-mode --tools "" --permission-mode dontAsk`, then
    `--mcp-config <temp>/mcp-<uuid>.json --strict-mcp-config --allowedTools mcp__agstudio__<read tool>,…` (every read tool by
    its full name, never the whole server), `--model … --effort medium --max-turns 6` (3 without lookups). The config is one stdio
    server (Node, the helper, `AGSTUDIO_MCP_URL`, `AGSTUDIO_MCP_TOKEN_FILE`) and is deleted after the turn. The stdin transport
    (Windows) takes the same flags. Each list option is followed by another option so it cannot swallow the prompt.
  - **Codex CLI**: next to `--ignore-user-config` the turn gets `-c mcp_servers.agstudio.command`, `.args`, `.env`,
    `.enabled_tools=[the read tools]`, `.default_tools_approval_mode="approve"` and start-up and tool time-outs. Codex has a
    per-server tool list and approval mode, so no write tool is even enabled (the settings parse in codex-cli 0.155: checked
    with `codex mcp get`).
  - **API backend** (`tools/ai/api-loop.ts`, `mcp-client.ts`): the request has `tools` (the read tools from the endpoint's
    `tools/list`, filtered to the allowed names), `system` as two blocks with `cache_control` (`ttl: '1h'`: the same prompt starts
    every chat) and the conversation's last block with a 5-minute breakpoint (put on a copy: three of the four allowed). While the
    model answers with `tool_use` the server calls the tool through the endpoint and sends the results back in one message
    (an error result for a failure or an unknown name), at most 6 rounds; the 7th request has `tool_choice: none`. Thinking blocks
    and tool calls stay in the kept history (append-only).
  - **Fallbacks, so a broken lookup never breaks chat**: no `readTools` (MCP off, preview server, older server) is today's
    behaviour with the `<tools>` note and `query` actions; a CLI that fails with a message about MCP is run again without
    it; an API endpoint that cannot be reached means no tools for that turn.
  - **What stays the same**: the answer still comes as the structured output and the page applies it with `applyAnswer`
    (one undo step, the focus guard, the approvals). Nothing reachable from a turn changes the project, plays it or renders it.
- **Tests**: `ai-catalog-index.test.ts` (format, determinism, versions, diff), `ai-first-turn.test.ts` (sizes, identical
  system prompts, details once, mid-chat changes, `readTools`), `ai-predict.test.ts`, `ai-catalog-tools.test.ts`,
  `ai-lookups.test.ts` (both CLIs' flags and temp files with fake `claude` and `codex`, no token anywhere, fallbacks, what the
  server accepts), `ai-api-lookups.test.ts` (breakpoints, the loop, with a fake SDK client and a fake endpoint),
  `mcp-lookup-scope.test.ts` (the door), `mcp-stdio-proxy.test.ts` (token file) and `mcp-e2e.test.ts` (the real dev server and
  page: a stand-in `claude` starts the helper from the config the server wrote, lists the tools, reads a plugin and is refused
  a write).
- **To confirm with the real CLIs** (nothing here calls a model): that `claude --safe-mode` still loads the server named by
  `--mcp-config` and that the structured output works next to `--allowedTools`; that Codex starts the stdio server and calls
  its tools without asking; that `cache_read_input_tokens` (API) rises on the second chat.
- **Limits**: lookups need the dev server (MCP is dev-only); the read tool definitions weigh 24 000 characters in every API
  request and CLI conversation (cached); a tool result is cut at 30 000 characters (API) or 14 000 (query action); the guess
  knows the producer words in `predict-words.ts` and nothing else (a plugin from the musician's folder is found by its name,
  category and description).

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
  (+8 ms onset lag), BPM is a least-squares line through the strongest evenly spaced stretch and every beat on it (first the beats
  beyond three robust sigmas, at least 8 ms, of the median-slope line are dropped while 70 % stay: a fill or the last
  beats of a section tilted the line by 0.1 BPM on a limited master), to 0.01, snapped to a whole BPM when that slips about as little; a fixed grid that slips > 15 ms (9-beat median)
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
- AGstudio templates rendered offline in Chrome as they open, at their style's loudness (`test/browser/dj-analysis.test.ts`):
  trap 140, boom bap 90, house 124 (through the Maximizer at +16 dB), lo-fi 80, drill 142 all exact, downbeats within 2.3 ms,
  keys F minor / A major / F minor exact; boom bap reads D minor (its audio is a bass on A and D only), a Camelot neighbour
  of A minor; lo-fi reads C major, the relative of its A minor (Am7 Dm7 G7 Cmaj7 lands on Cmaj7: C major scores 0.80, A minor
  0.67, leveled or not), the same Camelot number (8A / 8B), which is what the test asks for.
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
shape), risers on "DJ FX", a marker per song. `Project.dj` (optional, repaired in `core/schema/repair/dj.ts`) keeps the songs
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
  hold what is about to be heard). The kernel keeps what runs per output sample (playback, fades, loops, the window
  check); the key-lock stretch (`deck-stretch.ts`, with the attack detector `onset-scanner.ts`) and the sync follower
  (`deck-sync.ts`) run per block or per stretch frame and are their own objects; `deck-snapshot.ts` reads a
  deck's published state.
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
  recording), wired together from one module per job in `app/dj/deck-control/` (transport, cues, jog, loops, tempo and
  sync, mixer, graph lifecycle, loader, recorder, ticker), all built from a shared `DeckContext`. `EngineApi.deckHost()` (optional; `engine/api.ts`) hands out the running context, a node feeding the
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
- Repair (`core/schema/repair/variants.ts`): a variant whose source is missing, itself, part of a loop or whose steps are malformed
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

`sample-residency.ts` decides what to keep (needs from `residency-needs.ts`, the plan from `residency-plan.ts`, pins,
the launcher's passes); `residency-works.ts` (`BufferWorks`) does the work of making a buffer (decode, reverse, stretch
or read the stretched copy back from disk) and tracks what is running and what failed.

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

#### Your own table: "My table" (`wavetable/table-editor.tsx`, `sdk/dsp/wavetable-frames.ts`)

- **Model.** A user table is 1–32 key frames, evenly spaced from position 0 to 100 %; the oscillator morphs between
  neighbours exactly as it does between a factory table's frames. A frame is a Fourier series (`Frame`: `sin[k]`,
  `cos[k]` for k = 1…256, `cos[0]` the DC offset). The drawing buffer is 1024 points (all 256 harmonics fit). Every
  editing operation is a pure function in the SDK (`wavetable-frames.ts`, no DOM): `drawStroke`, `smoothFrame` (Gaussian
  low-pass on the harmonics), `normalizeFrame`, `removeDc`, `bandLimit` (brick wall or tapered, in the frequency
  domain), `setHarmonic` / `frameFromHarmonics` (additive bars), `invertFrame`, `reverseFrame`, `morphFrames` /
  `framesBetween` (fill between key frames), `frameFromWave` (an FFT for power-of-two cycles, a direct transform for any
  other length, so a 600-sample single cycle reads exactly), `framesFromCycles` (a single cycle or a table of cycles,
  `clm ` chunk honoured, thinned to 32), `framesFromSlices` (a sample cut into N parts, each Hann-windowed and read as one
  cycle), `decodeWav` / `encodeWav` (float32 with a `clm ` chunk: Serum and Vital load the export).
- **Stored compactly, versioned.** The plugin's state is `{ v: 2, user: { frames: string[] } | null }` and each frame a
  base64 string: highest harmonic (u16), a scale (f32), the DC and every harmonic's cos and sin as 16-bit integers of
  that scale (rounding error far below −60 dB of the peak). A smooth shape is a few dozen bytes, a full 256-harmonic one
  1 KB, a whole 32-frame table at most ~44 KB. `readUserTableState` makes any saved state valid (missing, older or
  damaged states become an empty table, undecodable frames are dropped); the plugin is at `version: 2` and its `migrate`
  turns version 1 (which had no state) into an empty table. Presets may carry a table in their `state`.
- **Mip levels off the audio thread.** `defineWorkletInstrument`'s new `onState(state, port, host)` hook runs on the main
  thread when the instance is made and on every state change (edit, undo, preset, load). `table-sync.ts` builds the
  band-limited bank (`buildFrameBank`: one table, one frame per key frame, nine mip levels each, peak-normalized per frame
  like the factory tables, about a millisecond a frame) and sends `{ type: 'userBank', data, frames }`; an unchanged
  table is not rebuilt, an empty one shares a single one-sine bank. The kernel treats table index 10 ('user', the option
  after the ten factory tables) as that bank: every oscillator keeps a reference to the data its frames are read from, and
  the frame cache key includes a counter that changes when a new table arrives. Factory tables take exactly the old code
  path (the golden test holds all 22 presets and the default patch to their recorded output, bit for bit on the machine
  that recorded it, `golden.test.ts`); an instance with no table plays a sine when an oscillator is set to "My table".
- **Editor.** A lazy section of the Wavetable's window: frame strip (thumbnails, oscillator position markers), wave pad
  (draw with the mouse, neighbouring frames faint behind it, a stroke is one undo step), 48 harmonic bars, tools (smooth,
  normalize, remove DC, invert, reverse, band-limit to N harmonics, replace with a shape, clear), add/delete/move frames and
  "Fill between" (exact in-between frames), import WAV (single cycle or a table), slice a sample into 4–32 frames, export
  WAV. It starts with a message and buttons when the table is empty. The oscillator's shape preview shows the table.
- **AI and MCP.** The `wavetable_shape` action (`app/ai/ops/wavetable.ts`) gives a Wavetable channel a table from lists
  of harmonic strengths per key frame (`{ channel, frames: [{ harmonics: [1, 0.5, …] }], oscillator: 1|2|both, position }`):
  it sets the plugin state through `setPluginState`, points the oscillator(s) at "My table" and turns an off oscillator on,
  in the answer's one undo step; empty, silent, over-long or over-many frames and non-Wavetable channels are refused
  with a message. The catalog lists the Granular and the Wavetable's new table option and presets like any plugin
  (`add_channel` / `edit_channel` with `preset` and `params`); over MCP the action is in `apply_actions` at once.
- **Tests.** `sdk/dsp/wavetable-frames.test.ts` (views, drawing, tools, imports, WAV, storage, bank levels),
  `table-edit.test.ts` (the key-frame list), `user-table.test.ts` (state → bank → kernel, morphing, replacing the table
  while a note sounds, aliasing at keys 84, 96 and 108 of a hand-drawn square: the energy that is not a harmonic stays
  below −60 dB where a naive read of the same table is above −45 dB, migration, presets with tables), `ai/ops/wavetable.test.ts`.

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

### Granular (`granular/`)

- **Idea.** Every note is a cloud of short grains read from a sample (the `main` slot, a drop on the editor like the
  Sampler's) or, while the slot is empty, from one of five built-in stereo textures (`textures.kernel.ts`: a sung "ah"
  chord, glass bells, strings, airy noise, a plucked arpeggio; additive, 4 s at 32 kHz, built once per page on the
  main thread, about 30 ms, and shared with the kernels through shared memory). A loaded sample wins over the texture.
- **Params** (`params.ts`): position, position spray, grain size 5–500 ms, density 1–200 grains/s, timing randomness,
  grain shape (Hann, Gaussian, triangle, flat top, percussive, reverse swell: tables in `shapes.kernel.ts`, every shape
  is 0 at both ends so grains never click), reverse probability, pitch / fine / pitch spray / key tracking (key 60 plays the
  sample at its own pitch), stereo spread, scan speed (−4…4×, 1× = the sample's own speed; or tempo-synced: one pass per
  1 beat…8 bars locked to the song, free-running while stopped), freeze (holds the scan where it is, automatable), a
  low-/high-pass filter, an amp ADSR, velocity, voices (1–8), a random seed, volume.
- **Kernel** (`kernel.ts`, `voice.kernel.ts`). 8 voices, each with a fixed pool of 64 grains in parallel typed arrays
  (a full pool takes over the grain that is furthest along). Grains start at exact frames (the gap to the next one is
  `sampleRate / density`, randomized by the timing knob), read the source in a loop (any position and speed is safe, a
  tiny sample at an extreme pitch just wraps) with linear interpolation, and are scaled by 1/√(grains sounding at once)
  so the level stays about the same whatever the density and size. Knobs are read once per render call (control rate),
  the envelope per sample. Stealing a voice fades it out over 256 frames. All randomness is a seeded mulberry32 per voice:
  seed knob and the number of notes so far choose the cloud, so renders repeat exactly. The audio-thread code sits
  between two marker comments and a test refuses `new`, literals, closures, spreads and array methods there.
- **Telemetry.** The kernel fills a `Readings` set 60 times a second (posted at 30 Hz): `grains`, `voices` and, for the 24
  newest grains, `gp<i>` (position 0–1, −1 for an empty slot), `gq<i>` (progress through the grain) and `gx<i>` (pan).
  No SDK change was needed: `Readings` takes any list of names and posts allocation-free. The editor reads them with
  `tap.reading(name)` on the frame loop and draws the grains as dots on the waveform, with the position line and the spray
  window (drag to edit them, one undo step per drag).
- **CPU** (`npm run bench:plugins -- --only granular`, % of one core at 48 kHz, 8-note chord, best of 5, a busy machine):
  default patch 0.8–0.9 %; the "Dense cloud" preset (64 grains/s per note × 8 notes, 90 ms grains: about 46 grains
  sounding) 0.8–1.2 %; the worst preset (Shimmer: 36 grains/s of 320 ms, pitched up) 1.7–2.0 %.
- **Tests** (`kernel.test.ts`): finite and bounded output for every preset, every grain shape fades without steps (the
  biggest step between samples is a small share of the level, a sine source stays clean), density and size (grains started
  ≈ density × time; sounding ≈ density × size), position / spray / scan / backwards scan / freeze / synced scan checked
  through the sample position of new grains on a ramp, key tracking by octave, spread, reverse, determinism with a seed,
  voices and stealing, the filter, the telemetry, and the no-allocation scan.

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
| Maximizer (`agstudio.maximizer`) | the Limiter's core (`LookaheadLimiter`, true peaks, stereo-linked) holds the peaks `clip` dB over the ceiling, then a 2× oversampled soft clip (identity under the knee, a smooth cubic to the ceiling) rounds those dB off; meters for the limiting and the clip. Goes before the master Limiter; see "Loudness stage" | 5 ms + 14 frames |
| Multiband (`agstudio.multiband`) | Linkwitz-Riley 3-way (low band through the upper allpass: sums flat), a compressor per band (evaluated every 4 frames on the peak, gain ramped), solo/bypass | 0 |
| Transient Shaper (`agstudio.transient`) | fast/slow attack and fast/slow release envelope pairs → attack and sustain gains in dB | 0 |
| Saturator (`agstudio.saturator`) | tape/tube/clip at 2× or 4× (SDK Oversampler); dry/wet mixed in the oversampled domain; tilt EQ | 0 |
| Chorus, Flanger, Phaser | modulated delay lines / allpass chains; `PhaseClock` follows the song when synced and free-runs when stopped; control-rate targets ramped, delay changes slew-limited so a jumping synced LFO glides | 0 |
| Stereo (`agstudio.stereo`) | M/S width, mono bass (LR4 high-pass on the side + matching allpass on the mid), Haas widener, balance, phase flips; defaults bit-exact | 0 |
| Lo-Fi (`agstudio.lofi`) | wow/flutter delay line, sample-and-hold, mid-tread bits, tone, seeded hiss and crackle | 8 ms |
| Stutter (`agstudio.stutter`) | gate patterns, beat repeat (slice from the grid line, the played part from an 8 s history), tape stop; acts only while the song plays | 0 |
| Vocoder (`agstudio.vocoder`, sidechain) | 16/24/32 two-stage SVF bands on modulator (the sidechain) and carrier (the input), state in flat arrays | 0 |
| Tune (`agstudio.tune`) | YIN → nearest scale note or guide-channel note (hysteresis) → glide (+ optional kept drift and added vibrato) → pitch-synchronous splicer (a second head a whole number of periods away, 4 ms crossfade) or, with Keep formants, pitch-synchronous grains; rests at its centre delay when nothing needs correcting (see Pitch correction) | 12 ms |
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
- While the plugin is parked by idle parking (see the Mixer section) the tap's analysers are disconnected from its node and
  `spectrum`/`waveform` return silence (`TapImpl.setParked`): an analyser pulls the node it listens to by itself.
- `getFloatFrequencyData` reads a full-scale sine at 20·log10(0.42 / 2) ≈ −13.6 dB (Blackman window, 1/N scaling);
  `TapImpl.spectrum` adds that back, so a full-scale sine reads 0 dBFS in its bin (`test/browser/taps.test.ts`).
- Editors: a 2-D drag (EQ Pro handles move frequency and gain) is one undo step: `usePluginEditing.setParam` joins the
  gesture in progress for a param without its own (`ui/plugin-hooks.ts`).

### Shared DSP and test helpers (`src/sdk/dsp`, `src/sdk/testing.ts`, whose parts live in `src/sdk/test-kit`)

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
  moves with the pitch unless Keep formants is on (which falls back to the plain shifter while no pitch period is known).
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

### Harmonizer (`plugins/builtin/harmonizer`)

`agstudio.harmonizer` adds up to three pitch-shifted copies of a sung voice, singing along in the key or on a held chord.
Files: `params.ts`, `kernel.ts` (the effect: pitch tracking, picking each voice's note, mix, dry delay),
`harmony.kernel.ts` (pure scale and held-note maths), `voice.kernel.ts` (one voice: glide, level, pan, fade),
`shifter.kernel.ts` (one voice's pitch shifter), `ring.kernel.ts` (the sample ring both read), `harmonizer.worklet.ts`, `index.ts`.

- **Following.** The SDK `Yin` (range Low/Middle/High as in Tune) gives the sung pitch every 256 frames; it is smoothed a little
  (a jump of over 0.7 semitone is taken whole). **Target = Key and scale**: the pitch is matched to the nearest note of the
  Key and Scale params (with hysteresis; the song's key is not given to effects, so they are explicit params like Tune's), and
  voice *n* moves **Interval** scale steps from that note (+2 = a third above, +4 a fifth, +5 a sixth, −7 an octave below; in a
  pentatonic scale a step is a pentatonic note) plus its fixed **Shift** in semitones (interval 0 + shift 7 = a plain fifth).
  The voice stays an interval away from the *live* pitch, so it keeps the singer's slides and vibrato; **Snap to key** (0–100 %)
  takes out that share of the singer's mistuning, so the voices land exactly on scale notes. **Target = Played notes** uses
  `notes: { param: 'notesFrom' }` (the Tune pattern, `noteOn`/`noteOff`/`allNotesOff` on the kernel): voice 1 sings the held note
  nearest the sung pitch (with hysteresis), voice 2 the next held note above it, voice 3 the next below; with no note above
  (below) the chord's lowest (highest) note moves up (down) whole octaves, and any note further than an octave from the singer is
  folded to within it, so a chord always gives a harmony. Those voices land exactly on the held notes. No note held = no harmony
  (the voices fade out over 5 ms and stop costing anything).
- **Voices.** **Voices** (1–3) and, per voice, Interval, Shift, Level (dB), Pan (equal power). A voice moves at most an octave
  either way. Each voice glides to a new interval in 12 ms. **Humanize** (0–30 ct, default 6) drifts each voice on two slow sine
  waves (0.35–0.85 Hz and 1.9× that) with phases and rates from the host's seeded `rand()`, so a run is repeatable. **Mix**:
  0 % = the original only, 50 % (default) = the original at full level with the voices at full level, 100 % = voices only
  (below 50 % the voices fade in, above it the original fades out).
- **The shifter.** All voices read one mono sum (the dry path keeps its stereo). Without Keep formants it is Tune's splicer: a
  read head moving at the pitch ratio, jumping a whole number of detected periods (4 ms crossfade) when it strays from its 12 ms
  resting delay. **Keep formants** (default on) is pitch-synchronous overlap-add on the same ring: grains of two periods under
  a Hann window are read at the voice's own speed and laid down one new period apart (period ÷ ratio), taken from the voice's
  own period grid (up to 8 grains). Unlike Tune, rises divide the overlap by the window sum but falls do not: dividing a sparse
  sum lifts the gap between two pulses back to full level and puts a pulse at every original period, so the pitch would not move
  (found while measuring an octave down). Grains read at a fixed delay, so their four cubic weights are worked out once
  per grain (`SampleRing.readWeighted`), and the splice reads are skipped while the grains supply all of the sound. With nothing
  voiced the splicer takes over (breaths and consonants are shifted, not dropped).
- **Latency.** 12 ms (`harmonizerLatencyFrames`, whole frames at every rate, reported through `latency` so the mixer's
  delay compensation uses it); the dry path is read at the same delay, so Mix 0 is the input delayed by exactly that
  (an impulse test) and a voice shifted by nothing adds in phase with the dry path.
- **Audio-thread rules.** `process()` (and every method it calls, audited in `kernel.test.ts`) has no `new`, literal, closure or
  iterator; `test/unit/process-allocation.test.ts` covers `process()`, a long-run heap test the rest.
- **Presets.** Thirds above (one voice, +2), Choir stack (+2 left, +4 right, −7 under, humanize 12, snap 30 %), Octave down,
  Fifth and octave up, Gospel 3-part (−2, +2, +4, humanize 8, snap 50 %). The default patch is two voices, a third and a fifth
  above, panned left and right, formants kept, in C major.
- **Measured** (Node, 48 kHz, sung A3 B3 C4 D4 in A minor, `kernel.test.ts` asserts ≤ 8 cents, ≤ 5 for the octave): every
  voice's pitch is within 1.5 cents of the diatonic interval (third above A→C B→D C→E D→F, fifth above A→E B→F C→G D→A, sixth
  above, octave up, octave down exactly half the frequency), plain shifter and Keep formants alike (guide-note voices are asserted within 8 cents); a sine reads through the plain shifter only (a pure sine has no vowel to keep). Keep formants lowers the level of a
  shifted voice with the voice's own spectral tilt (an octave down about −4 dB RMS, an octave up about −6 dB on a 1/k test
  voice); use the voice's Level. CPU (% of one core at 48 kHz, best of 7, a voiced sung line with vibrato, a machine on which Tune's
  default patch reads 0.56 % instead of its documented 0.38–0.40): default patch (2 voices, formants) 1.05, 3 voices with
  formants 1.07–1.26, 3 voices plain 0.89, 1 voice with formants 0.59, guide notes 3 voices 1.10; presets Thirds above 0.62, Choir
  stack 1.11, Octave down 0.58, Gospel 3-part 1.14. `npm run bench:plugins -- --only harmonizer` (its music-like input is
  barely voiced) reads 1.08 default, 1.19 worst (Choir stack). The first version (shifter on the SDK `DelayLine`, windows
  normalised and widened) took 2.5 % for three voices.
- **Limits.** One singer at a time (a chord or noise gives no notes: the voices go on with their last interval); a voice
  follows a pitch it measured about 20 ms ago, so a fast vibrato is followed a little late in Played notes mode; the shift is
  an octave at most; the voices come from the mono sum.

## Vocal cleanup (`core/audio/cleanup`, `core/audio/cleanup-edit.ts`, `core/ops/cleanup.ts`, `app/actions/cleanup*.ts`, `app/cleanup`, `ui/features/vocal-cleanup`, `plugins/builtin/denoise`)

Clean a recorded vocal clip: take out steady background noise, tone down or remove breaths, repair mouth clicks. Like the pitch
editor's correction it is **non-destructive**: the clip keeps settings, a render of them is a new sample the clip plays, the recording
stays, and Undo goes back. A real-time **Denoise** effect does the noise part for monitoring and live input.

**What a singer or producer does.** Record or drop a vocal on the playlist, right-click the clip, **Clean up vocal…** (also Playlist →
Clean up vocal for the selected audio clip, View → Clean up vocal, or Mod+K and "clean up"). In the window switch **Noise reduction** on
(12 dB, learned from the quietest half second), **Breaths** on (12 dB; the breaths found appear as orange boxes on the strip and on the
clip in the playlist) and **Mouth clicks** on. Change a slider and a moment later the cleaned sound is made in the background; press
Play and flip **Cleaned / Original** to compare, or **Hear what was removed** to check that no voice went with the noise. Drag on the
strip over a stretch with only the room sound to choose where the noise is learned from; untick a breath to keep it. Everything is one
undo step per change (a slider drag is one step), and **Remove cleanup** puts the recording back.

### The clip edit chain (`core/audio/playback.ts`)

A clip's sound goes through stages in a fixed order, each an optional field of the clip whose **render** (a whole new sample, on the
recording's own length and timeline, stored through the sample store) replaces the channel's sample as the next stage's input:

    channel sample → cleanup (`clip.cleanup`) → alignment (`clip.align`) → pitch edit (`clip.pitchEdit`) → the clip's gain and fades

`STAGES` in `playback.ts` lists them in order; `clipSourceSampleId(channel, clip, stage)` is the sample a stage reads (the render of
the last stage before it that has one, else the channel's sample) and `clipSampleId` the one the clip plays (the engine, the
residency planner and the playlist waveform all call it). A stage added later goes in `STAGES` at its place and nothing else changes.

**Decision: cleanup, then alignment, then pitch.** Alignment reads the cleaned vocal (`planAlignment` uses `clipSourceSampleId(…, 'align')`,
and that sample is part of its signature, so a new cleanup render re-makes the alignment); the pitch render's signature names the
sample its stage reads whenever an earlier stage made one (`pitchRenderSignature(channel, clip)`), so a new cleanup or alignment
render re-makes the correction. Note analysis reads the aligned (or recorded) sound: cleanup does not move notes in time, alignment does.

**Why cleanup before pitch.** A pitch shifter carries the noise, breaths and clicks along with the voice (a shifted hiss repeats
grains and gets a rhythm of its own), and PSOLA and YIN both work better on a clean voice. So:
- the Pitch editor's **render** reads the cleaned sample (`pitch-render.ts` uses `clipSourceSampleId(…, 'pitch')`, and a run is stale when
  its source changed as well as its edit);
- its **analysis** stays on the recording (cached by the recording's hash; cleanup keeps length and timeline, so the notes stay where
  they are, and a cleanup change does not start a new analysis);
- whenever the cleanup's render changes (a new one, or the cleanup removed) the ops clear `pitchEdit.renderedFor` (`core/ops/cleanup.ts`
  `pitchRenderIsStale`): the pitch renderer sees a render that is not current and makes it again from the new source after its usual
  pause, in the same undo step. The old pitch render plays until the new one is there;
- A/B: the cleanup's before/after (`editor.cleanupOriginal`, `uncleanedSound` in `core/query/hear.ts`, in `heardProject`) plays the
  clip as recorded, so it drops the cleanup render **and** the pitch render made from it; the Pitch editor's A/B (`pitchOriginal`) still
  switches only the pitch correction (the cleaned sound is then what it hears as "original"). Both are session state.

### Settings and what is stored (`AudioClip.cleanup`, `core/audio/cleanup-edit.ts`)

```ts
VocalCleanup {
  noise?:   { amountDb 0–30, sensitivity 0–1, from?, to? }   // from/to: the quiet stretch the noise is learned from (seconds in the sample)
  breaths?: { reduceDb 0–60, sensitivity 0–1, spans?: { from, to, off? }[] }   // 60 removes; off = the musician kept this one
  clicks?:  { sensitivity 0–1 }
  renderedSampleId?, renderedFor?                              // the render, and the cleanupSignature it was made from
}
```

The noise profile is **not stored**: only the stretch it is learned from, so the same settings always give the same profile
from the same sample and nothing big goes into the project. A section absent is off; settings that do nothing are removed. The
fields are one commented block in `types/playlist.ts` and `schema/repair/cleanup.ts` (called from `repair/playlist.ts`, also one
commented block): ranges clamped, spans sorted, overlapping or backwards ones dropped, a render that is not in `Project.samples`
forgotten. `cleanupSignature` (rounded numbers, switched-off spans ignored, "find" where the stretch or the breaths are not found yet)
tells a stale render; `applyCleanupRequest` is the one function the window, the commands and the AI use to turn "noise 14 dB, breaths
off" into new settings (a changed breath sensitivity forgets the breaths found so they are found again; a changed amount keeps them).

### The render (`app/actions/cleanup-render.ts`, `app/cleanup/cleanup.worker.ts`, `core/audio/cleanup/render.ts`)

- `startCleanupRenderer` (created once in the feature's `register`) watches the document like the pitch renderer: after an edit (origin
  `edit`) that leaves a clip's render out of date it waits 450 ms and renders the **whole sample** (cleanup never leaves unprocessed
  audio behind a trim edge) in a Worker (`renderCleanup`), encodes 24-bit FLAC off-thread, writes it through the sample store
  inside `whileBusy(…, { project })`, and `setCleanupRender` puts the new `SampleRef` into `Project.samples`, makes the clip name it,
  drops the previous render's entry when no clip plays it, and **writes what the render found** into the settings (the quiet stretch
  when none was given, the breaths when none were found yet) so the render is reproducible. The commit is `transact(…, { amend })`:
  the change and its render are one undo step, and undo restores the earlier settings with their render. A newer change cancels the job;
  a result for a stale signature is dropped. Samples over 15 minutes are refused ("cut the clip out first").
- **Storage**: the render's hash is in `Project.samples` (kept like any sample), the recording stays the channel's; undo's patches name
  the old render, so history keeps it too.
- **Order inside the render**: 1. clicks (sharp events are repaired before anything smears them), 2. noise reduction (profile learned from
  the click-repaired sound), 3. breaths (a gain envelope on the spans found in the original recording).
- **Determinism**: plain double arithmetic in a fixed order, no random, so two renders of the same settings are bit-identical (same FLAC,
  same hash in the store).
- "Hear what was removed" (`hearRemoved`): original minus cleaned over the clip's part, played on the preview bus (`previewAudio`).

### Noise reduction (`cleanup/noise-profile.ts`, `cleanup/spectral-denoise.ts`)

- **Profile**: the mean power per bin over the frames of a stretch of the sample (2048-sample frames at 48 kHz, quarter-frame hop,
  square-root Hann), smoothed over three bins. `findQuietStretch` finds the quietest 0.5 s that is not digital silence (a stretch
  under −100 dBFS is "nothing to learn", reported in plain words).
- **Gain**: a Wiener-style gate. The a priori signal-to-noise ratio ξ is estimated decision-directed (Ephraim and Malah): 93 % from what
  the previous frame kept, 7 % from this frame; gain ξ/(1 + ξ), never below −amount dB. Sensitivity raises the learned noise by 0–6 dB.
- **No musical noise**: a patch of gain that is narrow in both time and frequency is lowered to its surroundings (opening over three
  frames and over three bins, kept where either is wide: a consonant burst is wide in frequency, a partial is long in time), then the gain is
  smoothed across three bins and may fall no faster than 200 dB/s. The gains are found from the mix of the channels and applied to every
  channel, so the stereo image stays. It runs in chunks with two frames of look-ahead: memory is flat for any length.

### Breath control (`cleanup/breaths.ts`)

- **Finding** (`detectBreaths`, on the mono mix of the recording, 10 ms frames of 20 ms): a frame is breath-like when the YIN pitch
  tracker (the existing voice analysis, `core/voice/pitch.ts`) finds no voice in it, its spectral flatness over 300 Hz–8 kHz is at least 0.2
  (harmonic voices score under 0.05, white noise about 0.56), it is at least 6 dB above the quiet floor (the 10th-percentile level), and it is
  below the singing's median level by 22 dB (sensitivity 0) to 10 dB (sensitivity 1; 16 dB at the default). Runs of such frames
  (gaps up to 40 ms bridged) of 0.2 s (0.1 s at sensitivity 1) up to 1.8 s are breaths; a short noisy sound touching a vowel is a consonant
  and a loud one ("s", "f" at −8 dB under the vowels) fails the level test. No singing in the clip (fewer than five voiced frames), nothing to
  compare to: none found.
- **Lowering** (`lowerBreaths`): the span's samples are multiplied by the target gain with a raised-cosine fade of 20 ms *inside* each edge
  (a neighbour's voice is never touched; the singing between spans is bit-identical). 60 dB or more is "remove" (gain 0). A span the
  musician switched off (`off`) is left alone; the playlist clip draws solid markers for lowered breaths and outlined ones for kept ones
  (`ui/features/playlist/breath-markers.ts`), the window's strip and list do the same and click or tick toggles them (`setBreathOff`).

### Mouth clicks (`cleanup/clicks.ts`)

- **Finding**: the second difference of the sound (a high-pass that makes a click's edge stand out) against its own 30 ms average: a sample
  10× (sensitivity 0) to 5× (sensitivity 1) above it is a candidate; its extent is where the sharp sound stays above 3× the average (at most
  3 ms each way, 7 ms in all, else it is a consonant); three candidates evenly spaced 2.5–14 ms apart are a voice's glottal pulses and are
  dropped.
- **Repair** (`repairClicks`): the sound on each side continues through the gap and the two continuations are crossfaded. In a voiced
  stretch (normalized autocorrelation ≥ 0.6 at a lag of 2.5–12.5 ms) the continuation repeats the last pitch period; elsewhere it is
  linear prediction (order 24, Levinson-Durbin on 30 ms of tapered sound), so noise and breath stay smooth. Too little sound on a side
  (the start of the file): a straight line. Detection is on the mono mix, repair on every channel.

### Window, commands, AI and MCP (`ui/features/vocal-cleanup`, `app/ai/ops/cleanup.ts`, `app/cleanup/report.ts`)

- Window type `vocal-cleanup` ("Clean up vocal"): header with the clip name and a status line ("Making the cleaned sound 40 %…", "Cleaned
  sound ready: the clip plays it. Your recording is untouched", "Hearing your recording as recorded…"), the **strip** (the recording's
  outline from `engine.sampleData`; the played part lighter, the learned stretch blue, breaths orange; drag = learn the noise from there,
  click a box = keep that breath), three sections (a switch, a plain sentence, sliders with units, the breath list, the click count), a
  footer (Play from the clip start, **Cleaned / Original**, **Hear what was removed**, Make it now, Remove cleanup). Empty states say what
  to do (no clip chosen; no breaths found, raise the sensitivity; no clicks found; noise cannot be learned: choose a stretch). Every
  control has a `data-hint` with units; the window has a "?" help.
- Ways in: the clip ▾ menu and right-click ("Clean up vocal…"), Playlist → Clean up vocal for the selected audio clip, View → Clean up
  vocal, the action search (every command has a hint). Commands: `cleanup.openClip`, `.apply` (`noise_db`, `breaths_db`, `clicks`,
  sensitivities, `noise_from`/`noise_to`), `.toggleOriginal`, `.hearRemoved`, `.learnNoise` (`source: 'loop' | 'auto'`, or seconds),
  `.renderNow`, `.clear`, and `cleanup.open` (the window). Window `vocal-cleanup` is in `OPEN_WINDOWS`.
- **AI**: the `clean_vocal { clip | track + bar, noise_db, noise_sensitivity, noise_from, noise_to, breaths_db, breath_sensitivity, clicks,
  click_sensitivity, clear }` action (one undo step, a part left out stays as it is; plain-word failures for nothing asked, a half
  stretch, a stretch under 0.1 s, a clip that is not audio) and the read tool **`get_cleanup`**: sections on with their numbers, where
  the noise was learned (or "not looked for yet"), the breaths found (number, bar, seconds, lowered or kept), whether the cleaned sound is
  ready, which sound is heard, and the processing order in one sentence. Both are MCP tools through the same schema and read list. The
  characterization snapshot of the action schema moved by exactly the new `clean_vocal` entry, the `vocal-cleanup` window name and the
  `get_cleanup` read.

### Denoise (`plugins/builtin/denoise`, id `agstudio.denoise`, category Voice)

A worklet effect for monitoring and live input. The same gain as the offline gate at 1024 samples per frame (2048 above 50 kHz) and a
quarter-frame hop; one complex transform carries left and right (left in the real part, right in the imaginary part), the gain is real and
symmetric, so it multiplies the combined spectrum and one more transform (the conjugate trick) brings both channels back: two 1024-point FFTs
per 256 frames for stereo. Without a profile the noise is *tracked* (a smoothed power that falls at once and rises 3 dB/s, trusted 2.4×
above its minimum); **Learn noise** (a bool: on while only the room is heard, off after a second or two) averages the power and posts it
(the kernel's preallocated message, one level in dB per bin); `setup()` in `index.ts` puts it in the plugin's **state** (`{ profile, frames }`,
saved with the project, undoable, rescaled to the transform size when it differs) and the kernel takes it back through `setState`. Params:
Reduction 0–30 dB (12), Sensitivity (50 %), Learn noise, **Hear noise only** (input minus output). A meter shows the average reduction.
**Latency is one frame, 1024 frames (21.3 ms at 48 kHz)**, reported to the host (`latency: (sr) => frames / sr`), which delays the dry path
and compensates the mixer. Nothing allocates after construction (`test/unit/process-allocation.test.ts` audits `process()`, the kernel
test audits every method that runs per block or frame). Presets: Gentle (monitoring), Normal (12 dB), Strong (fan or hiss), Podcast.

### Measured (synthetic phrases from `core/audio/cleanup/test-signals.ts`: harmonic voice with vibrato and a formant, "s" sounds, breaths, pink room noise, clicks; Node 22, 48 kHz)

- **Noise reduction at 12 dB** (pink noise at −40 dBFS under vowels at −22 dBFS, gains found from the mix and applied to the voice and the noise
  separately): signal-to-noise (vowel level over the noise floor in the pauses) **+11.2 dB** (asserted ≥ 10 and < 14); the voice band within **0.5 dB**
  (vowels −0.5 dB, asserted < 1; an "s" 8 dB under the vowels, itself only 10 dB over the room noise, −1.6 dB, asserted < 2: the sensitivity's margin costs a noise-like sound a little); the noise inside the vowels falls 7.6 dB (only the gaps between harmonics can be reached) and the
  whole file's noise energy 8.9 dB, which is the honest overall figure: a 12 dB floor everywhere would be 12 dB, but noise under a voice
  partial passes with it. Noise alone: **12.0 dB** down (asserted 10–13), the spectral tilt kept to within 9–15 dB per bin region.
- **Musical noise** (share of 1024-sample time-frequency cells more than 10 dB above their frequency's mean power, noise alone):
  input 3.2e-5, this gate **1.4e-4**, plain per-frame spectral subtraction (the control, same noise down about as far) **1.1e-3**, 8× worse
  (asserted: ours under max(5× the input's, 3e-4) and the control above 5× ours). A 50 Hz hum and its harmonics fall by more than 15 dB at 24 dB.
- **Breaths** (14 per 40 s phrase, an "s" 8 dB under the vowels before each phrase): **14 of 14 found with no mark on a syllable** at noise −50 / breath
  −16 dB, noise −46 / −16 dB and −50 / −22 dB re the vowels (asserted ≥ 90 %, no syllable marked, no mark that is not a breath); an "s" at −3 dB
  is never marked; room noise alone and singing alone give none. Lowering by 12 dB: 11.5–12.5 dB in the middle of each breath, the singing
  bit-identical; removing: exact zero in the middle; the largest sample step stays within 1.5× the breath's own.
- **Clicks** (3.5 kHz bursts of 1.5 ms): **15 of 15 found** (6 in pauses, 9 over vowels, loud ones; quiet ones in the pauses at higher sensitivity),
  none in clean singing, noise or breaths; error against the clean sound **−23 dB in the pauses, −16 dB over the vowels** (asserted ≥ 15 / ≥ 10);
  samples outside the repaired spans unchanged; a held 220 Hz tone comes back within 1 %.
- **Speed** (Node, loaded machine): 60 s of 48 kHz mono or stereo noise reduction about 1.5–3 s (the 15-minute limit is about 40 s in a Worker), breath finding 0.3 s and
  click finding 0.06 s per minute. In Chrome a 14 s clip renders, encodes and is stored in about 1.2 s.
- **Denoise kernel**: latency exactly 1024 frames (a click comes out 1024 frames later, reconstruction with no reduction within 1e-4); after
  learning, pink noise at −40 dBFS is turned down 10–13 dB (12 asked); a voice within 1 dB over it and the gap noise down at least 8 dB; the
  tracker alone reaches 6 dB after a few seconds; allocation audit and heap check pass. **CPU** (`npm run bench:plugins -- --only denoise`, % of one core at
  48 kHz, 4 s, best of 7): **1.63 %** (1.64 % worst preset) on a machine at load average about 40, where Tune read 0.90 % (0.38–0.40 % quiet) and the
  De-esser 0.51 %, so roughly 0.7 % on a quiet machine; two 1024-point complex FFTs per 256 frames dominate it.

### Tests

Node: `cleanup/spectral-denoise.test.ts` (profile and quiet-stretch finder; the numbers above; hum; stereo; chunks; determinism),
`breaths.test.ts`, `clicks.test.ts`, `render.test.ts` (the whole chain, determinism, given findings kept, problems said in plain words,
removed sound = input − output), `cleanup-edit.test.ts` (settings, signature, requests, repair, wording), `core/ops/cleanup.test.ts` (undo
restores the earlier edit and render, replacement drops the old sample, the chain's sources, the pitch render marked stale, shared render
after a split), `schema/repair/cleanup.test.ts`, `app/actions/cleanup.test.ts` (each change one undo step, drags merge, render in the same
step, findings written, stored hash kept (`collectHashes`, `referencedHashes`), two renders bit-identical (same hash), the cleaned
sound is 12 dB lower in the quiet, failed render toast, no-quiet-stretch message, nothing rendered after undo or stop, and **cleanup then
pitch**: the pitch render reads the cleaned sound and is made again when the cleanup changes), `app/ai/ops/cleanup.test.ts`,
`ui/features/vocal-cleanup/ab.test.ts` (A/B, menu and command entries, AI catalog), `wave-peaks.test.ts`, the Denoise `kernel.test.ts`
and `test/unit/process-allocation.test.ts`, `ai-coverage.test.ts` (every command and the window have an AI path). Browser: `test/browser/vocal-cleanup.test.ts`
(offline renders: a clip plays its cleaned render, the recording without it and when the render is missing; the Denoise worklet turns a learned noise down
by the amount, two exports are bit-identical, and its latency is compensated by the mixer).

### Limits

- The finders are tuned on synthetic voices: a real breath that is as loud as a soft "s", a whispered line (no pitch, flat spectrum), or a
  very noisy room (a breath under 6 dB above the floor) are not found; raise the sensitivity or untick/keep markers by hand. A click inside a loud
  fricative or at the start of an "s" is not found. Clicks over a vowel are repaired by repeating the last pitch period: a very quick
  vibrato or a pitch glide through the click leaves a small discontinuity.
- Noise reduction learns a *steady* noise: a changing noise (traffic, keyboard taps) is not learned from one stretch. Noise under a
  voiced partial cannot be removed (it passes with the partial), so 12 dB asked is 12 dB between the words and about 8 dB overall.
- The whole sample is processed (up to 15 minutes); cleanup of a reversed clip works (the markers are not drawn while reversed).
- Denoise has one frame (21 ms) of latency and 1024-point resolution (47 Hz per bin): it is for monitoring and live input; the offline
  clip cleanup resolves the voice's harmonics better.
- Other stages that follow the cleanup (alignment of doubles, harmony voices) read `clipSourceSampleId` of their own stage; a stage
  that changes the timeline would need its own convention, since every stage today keeps the recording's length.

## Audio recording, editing and export (M15)

### Playing audio clips (`core/audio/playback.ts`, `envelope.ts`, `engine/clip-player.ts`)

- One mapping from song ticks to seconds into the (reversed, when reverse is on) sample, shared by the engine, the
  waveform, trims, splits, normalize and slicing. With P = 2^(pitch/1200) and B = the channel's `sourceBpm`:
  `off` plays at P × its own speed (a resample: pitch changes speed), `resample` at P · bpm(t)/B (locked to beats,
  pitch follows the tempo, like a turntable), `stretch` at bpm(t)/B with the pitch kept at P (time-stretched). Resample
  and stretch need a source BPM (without one a channel plays `off`). `offsetSec` (the trim) is a position in the played
  copy, so reversing mirrors every clip's trim (`mirroredOffset`) and it keeps playing the same audio.
- A clip with a pitch correction (`AudioClip.pitchEdit.renderedSampleId`) plays that render instead of its channel's sample
  (`clipSampleId`; same length and timeline, so everything below applies unchanged): see the Pitch correction section.
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
  not part of a group). `core/schema/repair/takes.ts` (`repairTakes`) drops damaged tags and releases a group with no comp track or no
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
- **Hand-made gain and fades survive a rebuild** (`findCompEdits` / `applyCompEdits`, `compEditsOf` in `core/ops/comp.ts`):
  nothing is stored on the segments. Before the comp lane is rebuilt, each old comp clip is compared with what the plan
  makes of the same segments (same takes, same crossfade); only the differences are edits (gain, a fade at an edge).
  They are laid over the new plan by position: a gain goes to the new clip of the same take that overlaps most, a fade
  only to a clip that still starts (or ends) at the same tick (a fade belongs to a border; where the border moved the
  plan's crossfade is used). Changing the crossfade measures the edits against the old value first, so the new length
  still takes effect.
- **Moving or resizing a take clip rebuilds the comp** (`editClips(d, edits, { tempo })` calls `snapshotComps` before and
  `refreshComps` after, in the caller's `transact`, so it is one undo step; the playlist's drags and the AI's clip edit
  pass the tempo): what the comp plays of a moved clip moves with it (same audio, same trim), a left trim keeps the audio
  where it is, a right trim cuts the comp to what is left, hand edits ride along. A vacated stretch is silent; where a
  moved piece lands on another take's, the later piece wins the overlap. A take clip (and a comp clip) keeps its track.
- **Recordings' own tracks hold only that recording.** `addClips` sends a clip meant for a comp or take track (paste,
  duplicate, file drop, placing a pattern) to the first ordinary track with room, adding one when none has
  (`ordinaryLaneFor`; `{ toTakeLanes: true }` is for the recorder and Flatten-and-merge); `editClips` will not move another
  clip onto one; `firstFreeLane` (automation), `laneNamed` (the arranger), the MIDI import's track order, consolidate's
  track and the AI's `place_pattern` skip them, and the AI's clip edit refuses `to_track` on or off them.
- **Listen to this take** (`comp.listenTake`, Alt+L on the playlist; the clip menus; the speaker on a take track's header,
  held = only while pressed): `editor.auditionTake` is session state. `connectEngine` passes every document change through
  `auditionProject(project, clip)` (`core/query/takes.ts`, memoized): a copy in which the group's other clips are muted and
  the take is on, its track un-muted (and soloed when another track is). The document, undo and exports never see it; it
  clears itself when the take is deleted or undone away. The listened take is outlined and labelled in the playlist; the
  `get_takes` read reports `listening_to_take`, and the command (with an `argsHint`) reaches the AI and MCP through the
  command catalog.
- **A comp of several recordings** (`addTakesToComp` in `core/ops/comp.ts`, `comp.addTakes` "Add these takes to the comp" in the
  clip and track menus and the Playlist menu, the `add_takes` comp action, `overlappingGroups` in `core/query/takes.ts`). When
  another recording of the same bars exists (its takes' time range overlaps this group's), its takes can join this group: only
  their tags change (`take.group` = this group, `take.index` continues after this group's last, the tracks' `takes.group`
  likewise, the tracks move under this comp track and the takes get the palette colour of their new number), and the other
  group's comp clips and comp track go (or the track becomes an ordinary one when it is the last). Nothing new is stored: a take
  clip already has its own channel (sample) and trim, and a comp clip is made with the `channelId` and trim of the take clip it
  plays (`setComp`), so each comp segment plays the audio it came from, whichever recording that is, and old projects (one
  recording per group) need no repair; `repairTakes` accepts a group whose takes sit on different channels. This comp is
  unchanged by the merge (hand-made gains and fades kept), and the parts of the other comp that fall where this one plays nothing
  are added in the gaps (`fillGaps`), so what is heard stays heard. One `transact`: undo returns the project exactly.
  `get_takes` lists `overlaps_groups`, and after a merge each take's `recording`.
- **A take clip's own gain or fade** that changes after the comp was made reaches the comp clips that play it:
  `setAudioClipEdits(d, id, edits, { tempo })` (the playlist's level handles, the clip menu's levels and Normalize, the AI's
  `edit_audio_clip` pass the tempo) does what `editClips` does for moves: `snapshotComps` before, `refreshComps` after, in the
  same undo step. The snapshot's hand edits are measured against the comp as it was before the change, so a comp clip whose gain
  or fade was set by hand keeps it (it wins, as in every rebuild) and every other comp clip of that take follows the take.
  A comp's outer edges inherit the take's fades (the crossfades at the borders stay the comp's own). A take that the comp does not
  play changes nothing in the comp (the clips and their ids stay).
- Not done: merged recordings are all-or-nothing (the takes of one group cannot be split back into two recordings except by undo);
  the other comp's own hand-made gains and fades are not carried over.

- Record mode records what the chip next to the record button says: recorders have a kind (`notes`, the default, or
  `audio`) and the prefs `recordNotes` / `recordAudio` choose. Browsers ask for microphone permission on the first
  getUserMedia, which needs a click: the commands that open the input are `gesture` commands.
- Measured with a loopback stream in the engine's own context: after calibrating the loopback, a hit played on a beat
  lands within 12 ms of it (the loopback's own delay moves by 3–6 ms between captures).

### Export (`app/export/audio-export.ts`, `encode.ts`, `core/io/flac.ts` (the door of `flac-encoder.ts`, `flac-decoder.ts`, `flac-subframes.ts`, `flac-rice.ts`, `flac-bits.ts`, `flac-format.ts`), `core/query/stems.ts`)

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

### Video export (`app/export/video/*`, `core/video/*`, `core/io/webm.ts`, `core/io/mp4.ts`)

File > Export as video… (the Video tab of the Export dialog; also the marker, ruler and clip right-click menus for a part
of the song, the action search, `file.exportVideo` / `file.exportVideoNow` for Studio and the MCP tool `export_video`)
makes a music video **offline**: nothing plays, so a 3-minute song takes a few seconds to tens of seconds.

- **Audio**: the same render as the audio export. `render-pass.ts` (`renderPass`) is the shared pass: the plan's range
  (`planExport`: song, pattern, loop, or a `{ from, to }` span), `renderStream` window by window, `StreamTrimmer` for the
  pre-roll, delay compensation and tail. Normalize renders once more first to find the peak (the same −0.3 dBFS gain as
  the audio export). Always 48 kHz stereo (Opus needs it; AAC and players are happiest there).
- **Pictures**: `video.worker.ts` receives the audio a piece (one second) at a time (`video-session.ts` awaits an `ack`
  per piece, so memory stays at a few seconds of audio, a few frames in the encoder and one muxer cluster). For picture
  `i` it reads a 4096-sample Hann window centred 1024 samples *behind* `i / fps` (the bars show what has just been
  heard; a picture that leads the sound looks wrong), `SpectrumAnalyzer` (`core/video/spectrum.ts`: FFT from
  `core/voice/fft`, log-spaced bands, a small tilt, dB to 0…1, instant attack, 0.14 s release) makes the bars and a
  level, `FrameRenderer` (`frames.ts`, the same drawing for the Worker's OffscreenCanvas and the dialog's preview canvas)
  draws one of four styles over the app theme's colors (`readTheme()` resolved on the main thread into `VideoTheme`,
  because Workers can't read CSS; `videoThemeOf` in `ui/features/export/video-preview.ts`), then
  `new VideoFrame(canvas, { timestamp })` goes to the `VideoEncoder`. Everything is laid out in units of
  (short side / 1080), so one design serves 1920×1080, 1080×1920 and 1080×1080, and the tests and the preview draw at
  a quarter size. The cover picture is decoded on the main thread (`createImageBitmap`), dimmed behind everything (and
  in the middle of the circle), and kept only for the export (not stored in the project).
- **Beat pulse**: `beatGrid(tempo, timeSig, fromTick, toTick)` (`core/video/beats.ts`) lists every beat of the range in
  seconds from its start through the project's `TempoMap`, so tempo automation is followed; `pulseAt` is 1 on a beat
  (bar starts a bit stronger), falling to ≈ 5 % by the next one, as a share of the beat so slow songs breathe slower. It
  drives a glow behind everything, the ring, the line width and the bars' lift.
- **Frame timing** (`core/video/timing.ts`): frame `i` is shown at `round(i · 10⁶ / fps)` µs (rounded from the exact
  time, so an hour of frames has no drift), lasts until the next frame's time, and there are
  `ceil(seconds · fps − 1e-6)` of them (at least 1), so the video is at most one frame longer than the audio.
  Key frames are forced every 2 s (`KEYFRAME_SECONDS`, every 60 or 120 frames).
- **Encoding** (`codec-config.ts`, shared with the dialog's support check): `VideoEncoder` (H.264 `avc1.640028` /
  `avc1.64002a` for 60 fps with `avc: { format: 'avc' }`, VP9 `vp09.00.40.08` / `41`, AV1 `av01.0.08M.08`;
  `latencyMode: 'quality'`, variable bit rate: 7 / 10 Mbit/s H.264, 5 / 7 VP9, 3.5 / 5 AV1 for 1080p at 30 / 60 fps,
  scaled by pixels) and `AudioEncoder` (Opus 160 kbit/s, or AAC-LC `mp4a.40.2` 192 kbit/s with `aac: { format: 'aac' }`).
  The dialog asks `isConfigSupported` for the chosen size and frame rate (`support.ts`) and greys out what this browser
  can't make, with the reason; with no WebCodecs at all the dialog and `runVideoExport` say so in plain words.
- **WebM muxer** (`core/io/webm.ts`, EBML): EBML header, Segment (size written as "unknown" and patched at the end, so a
  cut-short export still plays), SeekHead (fixed-width positions), Info (TimecodeScale 1 ms, Duration patched at the
  end), Tracks (V_VP9 / V_AV1 with av1C, A_OPUS with the encoder's OpusHead, CodecDelay = the pre-skip, SeekPreRoll
  80 ms), then Clusters of about two seconds that start at a video key frame (SimpleBlocks, relative time as int16, a
  cluster is also cut before 30 s whatever happens), and at the end the Cues (one per cluster, on the video track).
  Video and audio chunks wait in two queues and are written in time order (a queue is held only while it waits for the
  other, a few chunks). Unit-tested by reading its output back with an independent parser (`test/helpers/webm-parse.ts`).
- **MP4 muxer** (`core/io/mp4.ts`, ISO BMFF, H.264 + AAC-LC): `ftyp`, **`moov` before `mdat`** (faststart), `mdat`.
  The `moov` can only be written once the last sample is known, so its space is reserved up front from the longest the
  video can be (`maxSeconds` = the music + 90 s): the muxer builds the largest `moov` such a file could need (the worst
  sample, chunk and sync tables), writes a `free` box of that size (+ 16 bytes), streams the samples after it in groups
  of 0.5 s (one chunk per track per group, video then audio), and at the end writes the real `moov` and a `free` box
  over the reservation and the `mdat` size over its header (an hour at 60 fps reserves under 2 MB). AAC's priming (2112
  samples) and the encoder's padding are cut by an `elst` edit list (`mediaTime = 2112`, `duration` = the music's length
  from the samples the encoder was given), which is what lines the sound up with the picture. No B-frames: it refuses
  frames that arrive out of order and a file past 4 GB (32-bit offsets), telling the musician to use WebM. Unit-tested
  with `test/helpers/mp4-parse.ts` (box tree, every sample's bytes through the tables, the reservation).
- **The file**: the Worker posts `write` and `patch` messages; `video-session.ts` applies them in order to a `ByteSink`
  (`platform/sinks.ts`, the same sinks as the audio export: a File System Access handle written as it goes, with the
  save picker opened first from the click, or a memory sink for the download fallback and for `export_video`, which
  uploads it to the dev server). Progress is a tenth for the render and the rest for the pictures; Cancel (and Esc)
  aborts the render, terminates the Worker and aborts the sink, leaving no file.
- **Formats and what Chrome does here** (headless Chrome 14x on an M-series Mac): H.264 (hardware), VP9, AV1 and
  Opus/AAC all encode; `<video>` plays both containers and decodes the sound with `decodeAudioData`. The file with the
  best reach is MP4 (the default; the dialog falls back to the first format the browser can make).
- **Measured** (`test/browser/video-export.test.ts`, a 15 s song, one run, headless Chrome on an M-series Mac, render
  and encode included): 1080p30 H.264 7.8× real time, 12.7 MB (6.7 Mbit/s); VP9 6.9×, 9.8 MB (5.2 Mbit/s); AV1 6.0×,
  5.2 MB (2.8 Mbit/s); 1080p60 H.264 4.0×, 19.3 MB; VP9 4.3×, 13.6 MB; 1080×1920 H.264 circle 7.7×; 1080×1080 wave 9.8×.
  A three-minute song at a fifth of the size makes a correct MP4 and WebM (every cluster, the index, seeking to the end).
- **Sync** (same test, 128 BPM so beats fall between frames): the first frame whose glow rises at each beat is at most
  one frame (33 ms at 30 fps) from the first loud sample of the decoded sound, for WebM and MP4; the decoded duration is
  within one frame of the audio's. An MP4's audio starts 2 ms after the WebM's (the first sample of a kick).
- **Not done / limits**: no B-frame reordering (MP4); WebM leaves the last Opus packet's padding in (under 20 ms);
  the AAC priming is the usual 2112 samples (a browser whose encoder primes differently would be a few ms off); the
  picture is not stored in the project; fonts are the system's UI font (Workers can't load the page's fonts); `export_video`
  is limited to four minutes because the file is held in memory until uploaded (the dialog has no limit).

### Importing FL Studio projects

`core/io/flp.ts` (reader: the door of `flp-reader.ts`, `flp-format.ts`, `flp-records.ts`, `flp-bytes.ts`), `core/io/flp-import.ts` (mapper: the door of `flp-import-mixer.ts`, `-channels.ts`, `-song.ts`, `-plugins.ts` and the report text in `-report.ts`), `core/io/flp-package.ts` (zipped loop
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
- The kernel (`sdk/faust/`: `kernel.ts` registers it, `instance.ts` owns the wasm memory, `effect.ts` and `instrument.ts` are the two kernels):
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

### Big projects (`?perf=huge`, `app/fixtures/huge-song.ts`)

A project far past what the other fixtures hold, built to find what stops scaling: 200 sound channels (120 synths over six
built-in instruments, 20 samplers, 20 drum pads and 40 audio clip channels) plus 60 automation channels, so 260 rack
rows, 100 mixer tracks with 3 to 7 effects each (481 effect slots, 84 tracks feeding 16 buses), 500 patterns holding
37,102 notes (one of them 16 bars with 5,000 notes on a single synth), 2,000 playlist clips over 300 bars on 60 tracks
(1,424 pattern, 300 automation, 276 audio clips; six take groups with a comp, six clips with pitch or cleanup edits whose
"renders" are other built-in samples), 38 markers, a chord a bar and 864 lyric words. The project JSON is 3.9 MB, 823 KB
zipped. It is generated from a seeded `Rng` (`?perf=huge` also seeds the ids, so every load is the same project), and
`buildHugeSong(draft, size)` takes a `HugeSongSize` (`SMALL_HUGE_SIZE` is a tiny one for tests). Measured with
`scripts/perf-huge.mjs` (load, save, memory, idle, engine, AI context, a 30 s offline render), `scripts/perf-ui.mjs
--fixture huge` and `scripts/perf-follow.mjs --fixture huge` (it mutes the channels and fixes the audio buffer, see below),
on a shared M-series Mac in headless Chrome against the dev server (medians of three fresh pages; the interface rows of
five repetitions). Before = the code at the start of this work, run back to back with after.

| | before | after |
|---|---|---|
| open: page to painted project (cold) | 616 ms | 724 ms (noise: nothing changed) |
| open: read the .agproj (parse, migrate, repair) | 79 ms | 79 ms |
| open: replace the project, painted | 151 ms | 151 ms |
| save: build the .agproj (JSON + zip) | 87 ms | 88 ms (JSON text reused when the project is unchanged: 73 ms in this run) |
| autosave: serialize on the main thread / zip in the Worker | 9.6 / 88 ms | 3.4 / 92 ms |
| version save point (whole) / longest main-thread block | 108 ms / 42 ms | 100 ms / 28 ms |
| JS heap / page memory / decoded audio | 101 / 134 MB / 2 MB | 109 / 142 MB / 2 MB (+8 MB, probably the cached JSON text and context answers) |
| audio nodes (live) / gains / worklets | 9,555 / 6,754 / 453 | 6,690 / 4,760 / 453 |
| idle frame cost, React commits at idle | 0.03 ms, 0 | 0.02 ms, 0 |
| engine, idle: audio clock vs wall clock (1.0 keeps up) | 0.71 | 1.02 |
| engine, idle: audio thread load (CDP render capacity) | 100 % | 100 % (still at its limit) |
| engine, everything playing: audio clock rate, keep-up | 0.08, 0.39 | 0.09, 0.47 (more than one core of real DSP) |
| engine reboot | 992 ms | 700 ms |
| offline render of 30 s | 113 s (0.27x) | 93 s (0.32x) |
| AI context: first build / the same project again | 675 / 627 ms | 148 / 21 ms (110,447 characters, same text) |
| follow (playing, smooth follow, playlist and piano roll side by side): frame JS median, allocation | 0.32 ms, 2.0 MB/s | 0.27 ms, 0.8 MB/s |
| open the mixer (paint) | 129 ms, one 97 ms frame | 56 ms, longest frame 24 ms |
| mixer fader / knob drag, from the page's handler to paint | 9.6 / 9.3 ms | 4.2 / 4.0 ms |

A second round, **idle parking** (see "Idle parking" under Mixer routing), measured the same way (medians of three fresh pages
with `scripts/perf-huge.mjs`, `?nopark` and the code of the commit before it for "before", the machine shared with other work;
"typical" is the 4-bar stretch whose number of sounding channels is the median of all of them, 69 of the 200, played after
the project has idled; "light" the 10th percentile, 52):

| | before | after |
|---|---|---|
| engine, idle: audio thread load (CDP render capacity), once parking has settled (about 7.5 s after load) | 100 % | 4 % (all 200 channels and 100 tracks parked) |
| engine, idle: audio clock vs wall clock | 0.98 | 1.00 |
| audio nodes (live) / gains / worklets | 6,830 / 4,830 / 453 | 6,215 / 4,215 / 453 (mute gates, channel input and pitch signals made when needed) |
| everything playing: audio clock rate, keep-up | 0.09, 0.45 | 0.13, 0.64 |
| typical 4 bars (69 channels sound): clock rate, keep-up | 0.26, 0.44 | 0.42, 0.47 |
| light 4 bars (52 channels sound): clock rate, keep-up | 0.27, 0.48 | 0.47, 0.53 |
| live note, engine's part of key-to-sound (parked / awake channel; `test/browser/idle-parking-perf.test.ts`) | n/a | 1.29 / 1.29 ms |
| engine reboot | 693-828 ms | 772-839 ms (the same: building the graph, not running it; the runs were on a busy machine) |
| idle main-thread script per second | 2.4 ms | 4.7-7 ms (no parking work runs once settled and the frame rate is the same; every frame function reads 2-3x slower with the same code, the cores no longer being kept busy by the audio thread: 0.4 to 0.7 % of a core) |
| 30 s offline render, repeated in fresh pages | two hashes (about 2:1) | one hash (`test/browser/render-determinism.test.ts`; 10 of 10 renders of a tenth of a bar, three 16-bar renders in fresh pages) |

A project this size still cannot be played in real time while 50-70 channels sound: their own DSP (wavetables, convolution-free
reverbs, multiband…) needs more than one audio thread, which parking cannot change. What changed is that a gap costs nothing and the
rest costs what plays.

Normal songs (`?perf=mix30`, 30 channels and 20 effects, and `?perf=stacked-song`; idle load, playing load, nodes, offline render speed, from the same runs): mix30 22 -> 8 %,
28 -> 26 %, 769 -> 654 nodes, 3.7x -> 3.8x; stacked-song 20 -> 7 %, 12 -> 9 %, 537 -> 461 nodes, 13.5x -> 14.1x; key-to-sound
(`test/browser/latency.test.ts`, three buffers, idle and heavy song, 40 runs each) within a millisecond of before in every row
(small buffer, idle song, key: 28.9 -> 28.6 ms median; medium heavy 38.3 -> 39.8; large idle 48.7 -> 46.9). The offline renders of
`mix30` (ids seeded), `stacked-song` and the huge project (4 bars) hash exactly as before the lazy stages and parking; the huge
one differs from the hashes the old engine happened to produce only because of the determinism fix below (it equals one of the
two the old engine made, the less common one).

Interface rows that were already fine on this project and did not move (medians, paint to paint, dev build, the wheel
rows sit on the browser's own 19-20 ms wheel floor): piano roll with 5,000 notes (drag 50 notes 4.8 ms, resize 4.3,
undo of a 1,000-note delete 14.8), playlist (drag a clip 4.0, rubber band 4.1, zoom 21, scroll 20), undo and redo of
a 1,000-clip delete (14-18 ms), action search open 20 ms, channel-rack step click 15 ms, open a plugin window 16.

What was found and done, in the order of what it cost:

- **The mixer graph, 9,555 audio nodes** (the first thing that stops a project like this: the audio thread was at its limit
  with nothing playing, and a reboot or an offline render took seconds). Chrome charges about 0.7 us per node per
  render block, silent or not, so cost follows the node count. An effect slot was nine nodes plus the effect: input, output,
  bypass, wet gate, and a dry/wet stage of four gains and an always-running ConstantSource whose two AudioParam
  connections cost the most. Now a slot at mix 1 that no automation drives has no dry/wet stage (`engine/fx-mix-stage.ts`,
  made by `FxSlotStrip.ensureMixStage` the moment the mix moves off 1 or automation takes it over: the lane's
  `onFirstDrive` hook, and binding replays what the lane holds), a live effect takes its bypass gain out of the graph
  after the fade (a gain at 0 adds nothing), and an effect with latency keeps its dry delay line running from the start so a
  stage made later has the history it needs. A channel at pitch 0 that is not automated or bent has no pitch
  ConstantSources (`PitchSignal` makes them on demand). Renders are identical: the same hash at 4 and 8 bars on the huge
  project, and `test/browser/slot-mix-stage.test.ts` renders each case with and without the stage and compares every
  sample (a delay, and the limiter, which reports latency). Nodes 9,555 -> 6,690, constant sources 1,975 -> 1,184 (offline,
  `test/browser/big-project.test.ts`). The 453 worklets stay: an asleep kernel still costs a `process()` call per block
  (about 3 us each, the largest share left: 453 of them are half the audio thread's budget), and returning false does not
  let Chrome skip it unless its input is flagged silent, which needs the instruments upstream to be flagged too, and a
  worklet that returned false cannot be woken again. (Taken up by idle parking, below.)
- **Idle audio load** (second round): a sleeping kernel still cost its `process()` call and kept every gain behind it and every
  effect of its track being pulled. Sleep is now told to the host and what cannot sound is taken out of the graph (Idle parking,
  Mixer routing); an offline render of 100 tracks is unchanged by it. **Measured trap**: Chrome keeps processing an
  AudioWorkletNode that has no connected output, so the cuts are made downstream, where nothing is pulled at all.
- **The last nondeterminism** (a 30 s render ending in one of two hashes): not a fan-in of three or more at all. A connect counter
  by node in a render found only sums of at most two real signals; halving the project, one plugin type at a time and one half
  of the tracks at a time all rendered the same every time, and only the whole project did not, which pointed at the order effects
  finish loading in. Delay compensation changes a route's `PadLink` when an effect reports its latency, the old link built its
  replacement before leaving its `OrderedMix` slot, and so each route's place in the sum (`s0 + (s1 + (s2 + …))`) followed the load
  order. See "Render determinism". It showed up in any render length (a tenth of a bar in about a third of renders).
- **The AI context**, 675 ms for 110 kB of text: the text is built up to seven times (each pass shortens one more part
  when it is over its budget, which a project this size always is), and each pass worked out the arrangement
  (`inferSections`, 100 ms), the song check, the playlist runs and the pattern summaries again. These are now worked out once per
  project version (`app/ai/context/project-cache.ts`, a WeakMap on the immutable project; the core queries are not
  memoized because they also run on drafts), and `isPlainInsert` no longer scans every channel for every track. The text is
  byte for byte the same.
- **Smooth follow with a chord track and lyrics**: both lanes redrew every scroll frame from the first chord and word of the
  song and worked out the song's key (`channelRoles` over every channel) each time: 340 and 280 KB/s of garbage and most of
  the script time of a following playhead. They now start at the first span that ends on screen (`core/query/spans.ts`,
  binary search) and keep the key per project version.
- **The channel rack scrolling**: after every row that scrolled in, the roving-focus code (`ui/a11y/roving.ts`) looked at
  every control of the whole rack again (a thousand step buttons: `closest` and `getClientRects` on each), 1.3 s of 7.4 s of
  script in a scroll test. It now only looks at what was added, and moves the Tab stop by touching the two controls
  involved. Script time in that test fell to a quarter; the paint latency of a wheel notch did not move (it is mostly mounting
  the rows, 4 ms a row in a dev build).
- **The mixer window**: 100 strips are drawn whole. A mixer of more than 40 strips now draws the ones near the view with spacers
  (`useWindowedRows` with `horizontal`), the Master always. Opening it takes less than half as long.
- **The reload snapshot and autosave** serialized the whole project (800 KB, 20-90 ms in dev) every second after any change,
  including a window move. `core/io/project-json.ts` keeps the JSON text for a project object, so a change of view reuses it.

Things measured and found fine: one edit on this project costs 0.3 ms (an insert volume), 1.1 ms (a channel volume), 1.9 ms
(a clip move) of script including the engine's reconcile, 2-4 ms while playing; saving a version point 15 ms on the main thread;
opening a project 6 ms synchronously and one frame to paint; the idle frame loop 0.03 ms.

Guard rails: `test/unit/big-project.test.ts` (tag `perf`: writing and reading the file, the AI context cold and again; limits
300 / 450 / 700 / 120 ms under `npm run test:perf`, far looser in the regular run) and `test/browser/big-project.test.ts`
(node counts of the mixer, always checked; offline render speed at least a tenth of real time with everything sounding, a scroll
frame under 2 ms and an idle frame under 0.3 ms of script, `perf`-tagged), `test/browser/idle-parking-perf.test.ts` (`perf`, `realtime`: the huge
project idles under 15 % of the audio thread under `npm run test:perf`, 60 % in the regular run, read through the DevTools protocol; a
note into a parked channel adds under a millisecond, 4 ms in the regular run, to the engine's part of key-to-sound),
`test/browser/idle-parking.test.ts` (a live song is as loud parked as not, a note wakes its path on the call, barriers and taps),
`test/browser/render-mixer-golden.test.ts` (render hashes of the mixer graph that must not move) and the repeat renders of
`test/browser/render-determinism.test.ts`.

Left to do:

- **Idle audio load** is now 4 % (above). What is left is the nodes parking cannot cut: a parked track keeps its sidechain tap, mute gate,
  pan, fader, post tap and send gains running on silence (about 10 nodes each), and each route its level gain and padded path.
  Cutting at the tap would need every consumer (sends, keys, meters) to be cut with it; merging the persistent per-track unity gains
  (chIn, chLink path, routeIn) is the other way. A convolution Reverb and plugins that do not report `sleep` keep their track
  in the graph; every built-in worklet and the Sampler, 3xOsc, 808, audio clips and the algorithmic Reverb do report it.
- **Muted channels with no notes anywhere** (25 here) still get a strip and an instrument. They could wait until unmuted or
  given a note; it saves about 3 % of the nodes here and a first preview of an unmuted unused channel would have to wait for
  the instrument to load, so it was left.
- The numbers above are dev builds like every other number in this chapter, and a dev build makes mounting rows and strips
  look worse than production does (`jsxDEV` is a large share of the rack's 4 ms a row).

## Testing

- Unit (Vitest, Node): scheduler core, time/snap, queries, ops, history invariants (fast-check: random ops then undo-all
  = initial), params, migrations, zip, WAV, DSP kernels, generators.
- Audio (Vitest browser mode, headless installed Chrome via Playwright `channel: 'chrome'`): offline-render fixtures
  returning `{ rms, peak, onsets, hash }`; onsets ±1 frame for worklets, ±1–2 ms for graph plugins; mute → silence;
  gain math; limiter ceiling; determinism; export chunk-boundary matrix; WAV export (hash-identical renders,
  24-bit round trip, trimming, start tick, progress and cancel).
- App smoke test (`test/browser/app-smoke.test.ts`): the whole app with the real engine and React shell in headless
  Chrome: open a project file → play → seek → stop → save → reopen, with no errors logged and no late events.
- **Test stages** (`npm run check`, `scripts/check.mjs`, `scripts/lib/test-stages.mjs`). Many files at once (up to nine Chrome
  pages, as many Node workers) share the cores, which is fine for a test of what the code computes and wrong for a test of
  how fast, how cheaply or how live it runs. So four stages follow the static checks, one after the other:
  `unit` (Node) and `audio` (Chrome) run every test without a quiet-machine tag, files side by side; then `unit-timing` (Node)
  and `audio-realtime` (Chrome) run only the tests tagged `perf` (speed, CPU cost, memory) or `realtime` (a live audio clock that
  must keep up, a loopback recording, a long run with no late event), one file at a time (`fileParallelism: false`). A test
  opts in with `{ tags: ['realtime'] }` in the options of the `it` or of its `describe` (a describe whose tests share a
  rig is tagged as a whole); `tools/test/quiet-files.ts` reads the test files at config time and lists the ones that mention a
  tag, so there is no list to keep up to date. `npm test` and `npm run test:audio` still run every test of their project
  (handy for one file); `npm run test:perf` runs the `perf` tests alone with their real limits.
  Rules for the tests inside: speed and cost assertions use CPU time and the best of a few attempts (`cpuNow`/`settle`,
  `@agstudio/sdk/testing`; the browser has no CPU clock, so a browser test of speed takes the best of attempts of the
  wall clock); a UI test waits for a condition (`expect.poll`, `until`, a settled-state helper), never for a fixed number of
  frames or milliseconds; a test that must see the audio clock keep up wraps its measurement in `retryWhenOverloaded`
  (`test/helpers/overload.ts`): when it fails, a control (how late the page's 10 ms timer fired, how fast a fixed little
  offline render runs) says whether the machine was overloaded; if not, the failure stands, if so the attempt is repeated
  and, when every attempt was overloaded, the test is skipped with those numbers in the message. The cost of audio code is the
  cheapest of many short CPU-time runs (`cheapestRun`), because a busy machine interrupts a long run again and again and each
  interruption leaves the caches cold. Files are the unit of parallelism in the `audio` stage (one page each, a describe.concurrent
  inside a page only shares one thread), so a long chain of renders is split into files that run side by side
  (`loudness-stage-<style>`, `edm-pack-<style>`, `dj-long-analysis-*`, `reference-studio`; shared parts in `test/helpers`). Vitest runs
  the longest files first by their recorded time, so a file it has not seen yet runs last the first time.
- In the app: `window.__ag` (dev) exposes services (stores, history, commands, engine, files) and `__ag.perf`
  (piano roll draw times, React commit count; `?perf=notes10k` loads a 10k-note fixture, `?perf=huge` the very big project of "Big projects" above).
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
- **Beat writer** (`app/assistant/apply.ts`, `beat-writer/`): tracks reuse the conversation's or the named pattern's
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
  The Reverb and Delay returns it makes are solo-safe (a solo elsewhere keeps their tails playing).
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

### Auto-level (`app/mix/auto-level.ts`, `mix/leveling/`, `level-step.ts`)

- `levelMoves` (pure): every bus to its style offset from the kick (`LEVEL_TARGETS`; the first bus
  present stands in for a missing kick), moves clamped −12…+6 dB, then one trim so the buses sum to
  −16 LUFS (power sum); when a fader would pass +5.6 dB the trim stops for all of them and the master
  stage makes up the loudness. `limiterInput(style, sum)` = target − sum, 0…10 dB (`LIMITER_INPUT_MAX_DB`).
- `autoLevel`: the busiest section's first 8 bars (most channels playing; or `fromTick`/`bars`; the
  pattern on a loop with no song; at most 20 s), one stem per role bus (`planStems`/`stemProject`, the
  master chain bypassed; other stems' tracks muted, so the reverb returns count with their sources),
  measured with `analysis/measure.ts`; one edit for the faders and the Limiter input, amended into the
  answer's undo entry (or its own); then `tuneLoudness` listens to the master and corrects it until it is
  within 0.5 dB of the target (`LOUDNESS_TOLERANCE`): the Limiter's input first (secant estimate, at most 3
  corrections, never past +10 dB: past that the Limiter pumps), and when that falls short, the
  **Maximizer** (added before the Limiter, the Limiter back at 0 dB, its input corrected up to 4 times, at
  most +18 dB). A song whose target the Limiter reaches cleanly keeps the default chain. Progress per bus, Stop
  (AbortSignal). Measured (`test/browser/mix-level.test.ts`): trap buses exactly on target, master −10.23 LUFS
  (Limiter +9.9 dB), lo-fi −12.73, house −9.65 (Maximizer), all −1.05 dBTP.
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

`npm run test:perf` (or `VITE_PERF_STRICT=1 npx vitest run --project audio-realtime test/browser/latency.test.ts`) prints
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
  extra reverb send; a master the Limiter cannot reach cleanly (up to +10 dB of input) gets the Maximizer ("Loudness stage").
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
  none silent, true peak −1.05 dBTP in all eight, and each within 0.5 dB of its target (measured / target LUFS, with the
  loudness stage the leveling used, as measured on the merged state with the Vocals bus): big room −8.32 / −8.5 (Maximizer), progressive −10.42 / −10 (Limiter +8.2 dB), future bass
  −8.92 / −9 (Maximizer), dubstep −8.56 / −8.5 (Maximizer), melodic dubstep −9.63 / −9.5 (Limiter +8.8 dB), tech house −9.75 / −10,
  trance −8.84 / −9, drum & bass −9.27 / −9 (Maximizer +10 dB). Before the Maximizer these were 0.5 to 1.5 dB short (the Limiter
  alone reached −9.2 to −9.8 at +15 dB, dubstep −8.6 at +14).
- **Node**: every style's usual song applied through `arrange` flows (`src/app/edm-shapes.test.ts`); the generator,
  transition traits, mix tables, prompt and templates have unit tests (`core/beat/edm.test.ts`, `core/arrange/edm.test.ts`,
  `app/mix/edm-mix.test.ts`, `app/ai/edm-prompt.test.ts`); the v3 acceptance test runs over all 17 `STYLES`.

## Loudness stage (`plugins/builtin/maximizer`, `sdk/dsp/lookahead-limiter.ts`, `app/mix/auto-level.ts`, `mix/leveling/loudness-stage.ts`)

Why: the Limiter alone cannot make a dance mix as loud as a loud reference. The master is peak-limited: a kick peak 13 dB over the
mix's loudness makes it turn the whole mix down for 80 ms or more after every kick, so from about +10 dB of input a dB more gets
a fraction of a dB (big room reached −8.69 LUFS at +20 and at +24 dB, a house song −9.35, dubstep −8.07 at +24). A hard
clipper on the master (it did crush a user's song) is not an answer: the Studio prompt forbids it and `tameMasterClipper` turns it into tape.

### The design

- **`Maximizer`** (a plugin, goes just before the master Limiter; the Limiter stays last and stays at 0 dB input while it works).
  Input gain → a look-ahead limiter (the `LookaheadLimiter` extracted from the Limiter into the SDK, stereo-linked, true peaks)
  that holds the peaks at the ceiling + **2 dB** (`clip`) → a soft clip at 2× oversampling that takes those 2 dB off: untouched below
  the knee (3 dB under the ceiling, `knee`), a smooth cubic (slope 1 → 0, no corner) to the ceiling at the top. So the limiter
  does the slow work (release 80 ms) and the clip takes the top of the peaks, as a few harmonics on the transient. The clip's depth
  is bounded by `clip` (max 4 dB), so it can never flatten a mix: the first stage guarantees nothing arrives above ceiling + clip.
  The soft clip's output filter overshoots a little (up to 2.5 dB over the ceiling on dense material), which the Limiter after it takes off.
- **Why a plugin, not a Limiter mode**: a plugin's latency is fixed when it loads, and the default master chain must stay as it was.
  Adding the Maximizer only when needed keeps the normal targets on the chain they always had (the Limiter's code moved into the SDK
  unchanged: the old and new kernels are bit-exact against the existing Limiter tests).
- **When**: `tuneLoudness` (auto-level and every caller: `level_mix`, `match_reference`, `setup_mix` with level, "Balance the mix", the
  Reference window's Match loudness) corrects the Limiter first and adds the Maximizer only when the Limiter at +10 dB is still more than
  0.5 dB short (or clearly out of reach: the first reading plus half a dB per remaining dB of input is more than 1 dB short). It
  bypasses an existing Maximizer when a later leveling needs none. One undo step with the answer; the chat says "Master: Maximizer … before
  the Limiter" and the input it chose. The Studio prompt only gained one clause in "Mixing by role" (the AI must not add its own clipper or Maximizer).
- **Choices, measured** (`D` = clip depth, `K` = knee; bigroom and dubstep renders at −8.5 LUFS): D 1.5 / 2 / 2.5 dB gave
  distortion −27.8 / −27.7 / −27.2 dB (bigroom) and −26.2 / −26.0 / −25.6 (dubstep), the input needed 9.6 / 9.2 / 8.8 dB: flat, so 2 dB;
  K 2 produced runs of flat samples in dubstep, K 3 and 4 not, and K 3 had the least distortion in the highs; the first stage's release
  40 / 80 / 150 / 300 ms changed nothing but the input needed (80 default); the cubic, a quintic (C²) and a tanh knee were within 0.2 dB
  of each other in every measure (cubic kept, it ends exactly at the ceiling); oversampling 4× = 2× in distortion and highs on both
  songs, none (1×) was slightly better on big room and slightly worse on dubstep's highs: 2×, at half the cost; a low-band-only clip
  (below 150 Hz) gained no loudness at all, because the peaks are the sum of the low and the high bands.

### Objective limits (`test/helpers/loudness-quality.ts`; unit: `test/unit/loudness-stage.test.ts` on a synthetic mix, browser: `test/browser/loudness-stage.test.ts` on the engine's renders of big room, dubstep, drum & bass and house; the tables below were run with seven styles)

| Measure | Definition | Limit |
|---|---|---|
| True peak | `TruePeak` (4×) over the output | ≤ −1 dBTP (+0.01) at every loudness |
| Distortion | in each 1024-frame window the best gain from the stage's input to its output is taken out; the rest, in dB under the output (whole signal, 95th-percentile window, and the part above 3 kHz). Slow level changes do not count; harmonics, intermodulation and gain wobble faster than 20 ms do | total ≤ −18 dB, highs ≤ −17 dB (browser; synthetic −22 / −18), and no more than the Limiter alone's + 1 dB where it reaches the same loudness |
| Kick punch | peak in the 25 ms after a kick over the RMS of its 400 ms, dB | ≥ 4.3 dB, and ≥ the Limiter's − 1 dB |
| Kick weight | sub band (< 150 Hz) in the 10–120 ms after a kick, dB under the mix's LUFS | ≥ the Limiter's − 0.5 dB |
| Hard clipping | the hard-clipping Saturator driven into the Limiter, at the same loudness, is the control: the measures must see it | the new chain's distortion ≥ 6 dB lower |
| Loudness | auto-level on the real engine | within 0.5 dB of the target |

Justification: a sine through the clip gives −31 dB THD at the ceiling and −22 dB with 2 dB clipped (the unit test prints them); on
music it must do much better because only the top of the peaks are touched. −18 dB sits between the new chain's worst measured case
(−19.9, house at −8 LUFS) and the hard clipper's best (−17.1, dubstep at −8.5). A "flat top" count (runs of equal samples at the peak)
was tried and kept only on the synthetic mix: a soft crest on a sustained sub bass counts as flat (dubstep shows 6 to 58 such runs), and the
hard clipper's plateaus are rescaled by the final Limiter so they do not repeat exactly, so on real renders it separated nothing.
Intermodulation is inherent to any clip: a 60 Hz sine at the top with a 5 kHz tone 20 dB down gets sidebands at −8 dB re that tone
(a hard clip: −6 dB), which is why the depth is bounded and the stage is used only when needed.

### Measured: the Limiter alone against the Maximizer at equal loudness (browser, engine renders, 8 bars)

Distortion in dB (lower is cleaner), kick punch and weight in dB; "—" = the Limiter cannot reach it (its loudest result in brackets).

| Style @ −9.5 LUFS | Limiter alone: distortion / punch / weight | Maximizer: distortion / punch / weight | Highs: Limiter / Maximizer |
|---|---|---|---|
| dubstep | −28.6 / 5.6 / 2.0 (+10.1 dB) | −29.0 / 6.0 / 2.4 | −28.0 / −22.8 |
| drum & bass | −21.7 / 8.1 / −1.8 | −24.0 / 8.8 / −1.0 | −28.4 / −25.5 |
| future bass | −24.3 / 8.6 / −1.6 | −25.4 / 8.7 / −0.7 | −23.2 / −22.4 |
| big room | −29.0 / 9.7 / −2.7 | −29.9 / 9.4 / −2.7 | −28.2 / −25.5 |
| house 124 | −20.4 / 9.3 / −0.4 (needs +15.8 dB) | −22.9 / 8.6 / +0.7 | −22.8 / −22.3 |
| trance | — (−9.63) | −28.8 / 10.0 / −3.3 | — |
| tech house | — (−9.65) | −24.9 / 8.9 / −1.3 | — |

| Style @ −8.5 LUFS | Limiter alone | Maximizer: distortion / punch / weight | Hard clipper: distortion |
|---|---|---|---|
| dubstep | −8.52 at +15 dB: −24.2 | −26.4 / 5.1 / 2.2 | −17.1 |
| drum & bass | — (−8.84) | −21.5 / 7.8 / −1.4 | −10.6 |
| future bass | — (−8.90) | −23.4 / 7.7 / −1.1 | −7.3 |
| trance | — (−9.63) | −25.4 / 8.8 / −3.1 | −7.6 |
| big room | — (−8.69) | −27.7 / 8.5 / −2.6 | −7.4 |
| house 124 | — (−9.35) | −20.9 / 7.9 / +0.1 | −8.9 |
| tech house | — (−9.65) | −22.0 / 7.8 / −1.1 (at its +16 dB cap: −8.62) | −10.5 |

Reading: at −9.5 the Maximizer is as clean or cleaner overall and keeps the kick's weight (up to +1 dB better) and punch (within 0.7 dB
of the Limiter's); its cost is the highs: 0.5 to 5 dB more distortion above 3 kHz than a slow limiter. At −8.5 and louder only it gets
there, and the hard clipper at the same loudness is 6 to 20 dB more distorted. End to end (auto-level, real engine, measured / target):
big room −8.32 / −8.5, dubstep −8.56 / −8.5, drum & bass −9.26 / −9, future bass −8.92 / −9, trance −8.84 / −9, house −9.68 / −9.5, tech house
−9.75 / −10, the reference test −8.49 / −8.4, all at −1.05 dBTP.

### CPU (`npm run bench:plugins`, % of one core at 48 kHz; a busy machine, best of 5)

Limiter 1.5 % (unchanged by the refactor: the old and new kernel measured 1.4–1.9 % side by side), Maximizer 2.4–2.8 % with the clip on,
1.0–1.3 % with it off. The master chain (EQ Pro 0.4, tape Saturator about 1, Limiter 1.5) costs about 3 %; with the Maximizer about 5 %.
The benchmark script had been broken by the plugins' lazy editors (a dynamic import split its bundle); `codeSplitting: false` fixes it.

### Templates, bass bus name, automation names

- **Templates open at their style's loudness**: `app/template-levels.ts` bakes what `autoLevel` measured on each template's own song (bus faders, Limiter
  and Maximizer input); `templateProject` applies it (9–68 ms to build, no rendering). `test/browser/template-levels.test.ts` renders all 13 and fails past
  1 dB (measured −8.50 to −12.64, all within 0.39 dB of the style target, −1.05 dBTP; tech house now levels its voice on the Vocals bus, which `LeveledBus`
  has and the table can hold); `VITE_BAKE_TEMPLATE_LEVELS=1` prints the table again after the generator, arranger or mix recipes change (re-baked when the
  loudness stage was merged onto the vocal-chain main). The DJ analysis fixtures (`test/browser/dj-analysis.test.ts`) are these leveled templates: the house
  one reaches its −9.5 LUFS through the Maximizer at +16 dB, which is why the beat tracker trims beats off its line (see "Track analysis (DJ mode)"). Before, dance templates opened at −14 to −16 LUFS. The default project's empty "Pattern 1" is removed when
  nothing references it.
- The bass bus is "808" when a channel plays an 808, "Bass" otherwise (`bassBusName`); `findMixLayout` finds either name, so old projects keep working.
- Arranger automation clips are named after the channels that play through the swept bus ("Pad", "Arp + Lead"), else the bus.

### Not done

- The soft clip is memoryless: sustained bass at the limit gets harmonics for as long as it lasts (dubstep's sub shows flattened
  crests) and the highs ride on it as sidebands. A band-split clip would avoid the second but gained no loudness (peaks are composite).
  Tech house and house reach −8.5 only at +14 to +16 dB of input.
- The Maximizer has no custom editor (the generic controls and its two meters).

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
  made once into `.agstudio/mcp-token` (git-ignored, mode 0600 where the system has modes and nothing more on Windows, where the file is as
  private as the user-profile folder it sits in; `tools/mcp/token.ts`); Settings can replace it, which
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
- **`apply_actions`** goes through `BeatAssistant.applyExternal` (`app/assistant/beat-assistant/external-apply.ts`), which is `applyTurn`
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
  tool the Studio chat has (`ai/read/` `readTools`, built into the MCP tool list from the same objects:
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
  when it ends; the server writes into `<home>/Music/AGstudio/` (`os.homedir()`, so `C:\Users\<you>\Music\AGstudio` on Windows; stems into a
  sub-folder), cleans names (also Windows device names like `CON` and trailing dots), accepts only
  .wav/.flac/.mp3/.zip, never overwrites ("Song (2).wav"). Capped at 20 minutes of audio (it is held in memory).
  No screenshot tool: there is no cheap way to capture the page without a rendering dependency.
- **UI.** Settings → "Connect AI apps (MCP)" (`ui/features/mcp/McpSettings.tsx`, on top of `settings/parts.tsx`): the
  switch, a live status line ("Connected: Claude Code · 3 calls in the last minute", pushed by the server on change and
  refreshed while the window is open), the token (masked, Show, Copy, New token…), the Claude Code command, the Claude
  Desktop config (`bin/agstudio-mcp`, or `bin\agstudio-mcp.cmd` with backslashes on Windows, from the platform `/api/mcp/info` reports; the
  config file's usual place is in the row's hint), a JSON setup for URL clients, the exports folder. Commands (so the action search
  and Studio's `command` action find them): `options.mcp` (switch; "Let other apps control AGstudio (MCP)": the audited command wording avoids "AI"), `options.connectAi` (opens Settings),
  `options.copyClaudeCodeSetup` (clipboard and a toast only: the token never goes back to a chat or an app). A toast tells the musician the first time
  an app calls.
- **`bin/agstudio-mcp`** (a `sh` wrapper that finds Node; `bin/agstudio-mcp.cmd` on Windows) runs `bin/agstudio-mcp.mjs`: stdio ↔ HTTP for apps that start
  MCP servers as programs. Claude Desktop's config file takes only such servers (remote ones go through Settings →
  Connectors and must be reachable from the internet), so this is its path. One line in, one POST out, concurrent;
  keeps the session id and negotiated version; mirrors `Mcp-Method`/`Mcp-Name` for 2026 requests; reads the token from
  `.agstudio/mcp-token` for every request (or the file `AGSTUDIO_MCP_TOKEN_FILE` names; `AGSTUDIO_MCP_URL` replaces the endpoint, e.g.
  with `/mcp?scope=lookup`); says "AGstudio isn't running…" as a JSON-RPC error when nothing answers.
- **Studio's own look-ups** (`POST /mcp?scope=lookup`, `tools/mcp/lookup-scope.ts`). The same endpoint with only the read tools
  of the Studio chat (`LOOKUP_TOOL_NAMES` in `app/mcp/defs.ts`, including `get_plugin_details`, `get_commands`,
  `search_catalog`): the AI backends call them during a turn, through this helper (Claude Code, Codex) or directly (the API
  backend). Any other tool is "no such tool", and the calls are not listed as a connected app. See "AI context: cached prefix,
  index, lookups".
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
- `repairReference` (`core/schema/repair/reference.ts`): a reference that cannot be read as measurements is forgotten (the song
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
  The same listening loop as a style target: the Limiter up to +10 dB, then the Maximizer (see "Loudness stage"), within 0.5 dB;
  it warns when even the Maximizer cannot reach the target. Headless Chrome, a house song at 124 BPM with the role mix: the
  Limiter alone saturated at −9.3 LUFS against the −8.4 reference; with the Maximizer it lands at −8.49 / −8.50 (true peak
  −1.05 dBTP).
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

## Harmony and chord track (`core/harmony`, `core/ops/chords.ts`, `core/query/chords.ts`, `app/harmony`, `ui/features/chords`)

Chords, basslines and melodies are written against one song-wide **chord track** instead of each part guessing the key.

### What is stored (`Project.chords`, optional, added in v3 without a version bump)
- `Record<ChordId, ChordEvent>`: `{ id, tick, length, root (pitch class), quality (id from core/harmony/chord), bass?
  (slash chord), confidence? (0-1, set by detection, cleared by a hand edit) }`. Absent until the first chord.
- Chords never overlap: every placement (`setChord`, `placeChords`, move, resize) carves its span out of the others by
  trimming, splitting or removing them (`core/ops/chords.ts`). A gap means "no chord". `placeChords` skips the carving when a
  list lands on an empty stretch (a hundred-bar detection stays linear).
- `repairChords` in `core/schema/migrate.ts` (run by `repairProject`, so by migrate and load) drops chords with a bad id,
  tick, length, root or quality, clears a bad bass or confidence, trims overlaps, caps the track at 4096 chords and
  removes an empty track. Idempotent; tests in `core/ops/chords.test.ts`.
- Queries (`core/query/chords.ts`, memoized on the stored record): `chordsSorted`, `chordAt`, `chordsBetween`,
  `patternChords(project, patternId)` (the chords as a pattern plays them: its first clip's place in the song, cut to its
  length), `chordTrackLines` (the AI's text). The AI snapshot rule applies: planners get an Immer `current()` copy.

### Pure harmony (`core/harmony`, no DOM, unit tested)
- `chord.ts`: 21 qualities (triads, sus, 6ths, 7ths incl. m7b5 / dim7 / m(maj7), add9, 9ths, power), `parseChord` /
  `formatChord` (round trip for every quality on every root, with and without slash bass; `C°7`, `Cø`, `CM7`, `Bb`, `F#`),
  `parseChordLine` ("Am7 | F | C | G", a dot holds the chord), flats from the key (`keyUsesFlats`).
- `detect.ts`: a chord from twelve pitch-class weights. Every root x quality is scored by weight inside the chord's
  notes, weight outside, missing tones (the fifth matters least) and the bass; 6th chords are not candidates (C6 reads as
  Am7/C), confidence is the fit scaled by the lead over the next different reading. `detectSpans` reads notes a bar or
  half bar at a time (bass = the lowest note that sounds for a fair part of the window) and merges equal neighbours.
  `detectSpansFromChroma` reads audio chroma the same way.
- `scan.ts`: gathers the notes of the song, clips, patterns or a bar range; harmonic roles first (chords, pad, keys,
  bass, 808), melody parts only when nothing harmonic exists. `audio.ts`: the DJ chromagram of an audio clip summed per
  window of the clip (trim, pitch and tempo follow respected through `sourceSecondsAt`). The app reads audio clips of a
  selection, or of the song when there are no chord notes (`app/harmony/detect.ts`); the AI action reads notes only.
- `scale.ts` (key notes, diatonic chords, Roman numerals), `progressions.ts` (25 progressions by mood and genre written
  as Roman numerals: I-V-vi-IV, vi-IV-I-V, ii-V-I, 12-bar blues, i-VI-III-VII, Andalusian, trap loops...; a minor one in a
  major song moves to the relative minor, `key.ts`; `layoutProgression` repeats to fill bars and merges neighbours;
  `suggestNext` ranks diatonic chords by function (home / away / tension) from a transition table, plus two borrowed
  chords, with a plain reason each).
- `voicing.ts`: every inversion at every height near a centre key (close, open, drop 2), then a dynamic program over the
  progression picks the voicing sequence with the smallest total semitone movement (checked by brute force in the tests);
  a slash chord keeps its bass lowest; `bass: true` adds the root as a low note; `compNotes` plays the voicings held,
  every beat, off-beats or eighths.
- `bassline.ts`: roots (held, restruck at bar lines), root and fifth (quarter notes), walking (root, chord tones, then a
  half-step or scale-step approach to the next root; seeded), 808 (a note at each kick hit on the chord's root, held to
  the next hit, a note at every chord change; default trap steps 0, 6, 10 when there is no kick).
- `fit-melody.ts`: strong beats (beats 1 and 3 in 4/4, or any note a beat long) go to the nearest chord tone, others to the
  key's scale; strength fixes the smallest moves first, 100 % is idempotent, only keys change. `plan.ts` turns these into
  notes for a pattern (`planChordPart`, `planBassPart` with `findKickPattern`, `planMelodyFit`); `core/ops/part-notes.ts`
  writes them (`writePart` replaces the channel's notes in the pattern and sets a blank pattern's length).

### App and UI
- `app/harmony/*`: `chord-track.ts` (type, apply a progression, edit, clear, next ideas), `detect.ts` (song, selected
  clips, loop region, current pattern; notes, then audio), `parts.ts` (the selected channel in the current pattern). Each
  action is one undo step and answers `{ ok, message }` for a toast.
- The **chord lane** (`ui/features/chords/lane-controller.ts`, `ChordLane.tsx`) sits above the playlist ruler, lined up
  with the playlist's scroll and zoom (it reads `controller.vp` every frame and redraws only when the chords, the view
  or the theme changed). Click an empty spot to type a chord (Enter adds it, Tab adds it and moves on), drag across to
  draw one, drag a chord to move it, drag an edge to resize (the drag previews on the canvas and commits as one undo
  step), double-click to retype, right-click for Change to, Split, Chord ideas, Delete. Chords with confidence under 0.5
  are drawn faded and dashed. Shown while the project has chords, or as chosen (`editor.chordLane`).
- The **Chords window** (`ChordsWindow.tsx`, `view.chords`, Alt+Shift+H): the track as text lines, a type box, next chord
  ideas, detect (where and how finely), the palette by mood and genre with a preview in the song key, and "Write parts
  from the chords" (chords, bassline style, melody fit strength) for the selected channel and current pattern.
- **Piano roll**: "Chord tones" tints the rows of the chord track's notes behind the notes over each chord's stretch (the
  root stronger) and names the chord at the top of the grid (`drawChordBands`); "Scale lock" (the old "Snap to scale")
  keeps drawn, painted and dragged notes in the song key. Strum has a milliseconds setting (`ctx.bpm` is new in the
  note-script context) and a direction; Arpeggiate has pattern, rate and octaves; both are one undo step.
- Commands (`chords.*`, each with a hint and `argsHint`), menus (Playlist, Edit, piano-roll right-click) and the action
  search reach everything.

### AI and MCP
- Actions `chords` (set, progression, detect, clear), `voice_chords`, `bassline`, `fit_melody` (`app/ai/ops/harmony.ts`),
  the context's "Chord track" lines (eight bars a line, repeated lines merged), the `get_chords` read tool (the chords
  with Roman numerals, next-chord ideas for a bar, palette entries by mood or genre) and `chords` in the `open` windows. The
  prompt section stays short: set the key, put the harmony on the chord track first, then voice, bass and fit.
- Chord edits honour a part-of-the-song focus (`focus.span`); parts honour a notes focus.

### Limits
- Detection reads pitch classes and the lowest note, not timing: a passing note held for most of a bar can win; a 6th chord
  is named as the 7th chord on its relative root; a dim triad with a doubled root can read as dim7.
- Audio detection uses the DJ chromagram of the whole clip (cost grows with its length) and is a guess for dense mixes.
- The piano roll shows the chords of the pattern's first place in the song only.

## Harmony voices (`core/harmony/voices`, `core/ops/harmony-voices.ts`, `core/query/harmony-voices.ts`, `app/harmony/voice*`, `ui/features/harmony-voices`)

Backing voices from a sung lead: "Make harmonies…" on an audio clip makes 1–4 new audio clips on new tracks right under it,
each a TD-PSOLA render of the lead's own notes moved to a target pitch (so every voice has the singer's words, timing and
vowels). The real-time cousin is the Harmonizer effect (above, with the vocal chains).

### What is stored (`AudioClip.harmony`, optional, one commented block; types in `core/model/types/harmony.ts`)
- A voice is an ordinary audio clip on its own track (lanes inserted under the lead's, or under the whole take group when the
  lead is on a recording's comp/take tracks), played by its own `AudioClipChannel` (level and pan are the channel's volume and pan, on
  the lead's mixer track; pitch, tempo follow and source tempo are copied from the lead's channel, so the voice moves with it).
  Its sample has **the lead's sample's length and timeline** (silent outside the part the lead clip plays, which FLAC stores in
  almost nothing), so the clip takes the lead's `start`, `length`, `offsetSec`, gain and fades unchanged and later trims and splits
  keep working. The sample is stored through the sample store (24-bit FLAC, `importSampleBytes` inside `whileBusy(…, { project })`) and
  listed in `Project.samples`, so storage clean-up keeps it by hash like any sample.
- `HarmonyVoiceRecord { group, voice, source (the lead clip), rule, formantCents, humanize, seed, renderedFor }`: how the voice was
  made. `rule` is one of `interval` (diatonic scale steps in the song key: +2 a third above, −4 a fifth below, ±7 an octave),
  `semitones` (fixed, the lead's tuning kept), `chord` (side above/below, the chord track) or `midi` (a guide melody: `GuideNote`s).
  `repairProject` cleans it (`sanitizeHarmonyRecord`, `core/harmony/voices/rules.ts`) and drops an unusable record (the clip stays
  plain audio).
- `renderedFor` is `harmonySignature(...)`: a hash of the lead's played sound (the sample or its pitch-correction render, by
  content, plus pitch and follow mode), the part of it the lead clip plays, the rule and settings, and, for the rules that read them,
  the song key and the chords under the lead (and the tempo that places notes among them). `staleHarmonyVoices(project)` lists the
  voices whose current signature differs: that is "out of date".

### Planning (`core/harmony/voices/targets.ts`, pure)
- `planTargets(leadNotes, rules, { key, chordTonesAt })` gives, per voice and lead note, the pitch to sing (null = silent). Lead notes
  carry the pitch **as the song hears it** (the clip channel's pitch and tempo-follow speed added) and their song ticks; the app turns
  the pitch analysis' note times into ticks with `tickAtSourceSeconds`.
- Diatonic: the scale note `steps` steps from the lead's nearest scale note (ties down), exactly on the scale, so a lead 15 cents sharp
  gets a harmony in tune with the key. Fixed: lead + semitones. Guide melody: the guide note sounding at the lead note's start tick (the
  highest if several), moved by octaves to the one nearest the lead, silent where none sounds.
- Chord: the chord at the note's start tick (`chordAt`; its tones plus the slash bass). The voices of a side are placed from the
  lead outwards, each on a chord tone beyond the one before it (so they never cross or share a note), choosing the tone nearest to
  what that voice sang on the last note with a mild pull toward the lead, and leaving room for the voices still to place; a voice
  with no tone left in reach doubles the one before it. Where the chord track has no chord a chord voice sings a diatonic third (a
  plain 4/3 semitones without a key). Every interval stays within an octave of the lead (the shifter's range).
- A diatonic rule without a song key, or an empty guide melody, is a `HarmonyPlanError` in plain words.

### Humanize and the render (`humanize.ts`, `render.ts`, `arrange.ts`, pure and deterministic)
- Per voice a seeded stream (`mulberry32`, `voiceSeed(voice, seed)`; the same seed gives the same takes) gives each note a timing delay
  (uniform in ±`timingMs`, 0–40), a pitch drift (±`driftCents`, 0–40) and a vibrato scale (1 ± `vibrato`, 0–1) applied to the lead's own
  vibrato. Defaults 12 ms, 6 cents, 0.3.
- `renderHarmonyVoice` turns the plan into a `PitchEdit` (shift = target − sung + drift, vibrato scale; every note shifts at least
  0.05 cent so a unison also goes through the same path) and runs `renderPitchEdit` (the pitch editor's own tracker, octave repair,
  shift curve and PSOLA). **Formant offset**: `PsolaOptions.formantRatio` reads each grain faster or slower by that factor (the grain's
  spectral envelope scales, the pitch follows the track), within ±300 cents; 1 is the old code bit for bit (the PSOLA characterization
  tests are unchanged).
- `arrangeVoice` then keeps each note with 100 ms before (a consonant) and 150 ms after, moves it by its delay, mutes notes the voice
  does not sing, and leaves the stretches between notes (breaths, noise, the lead's other consonants) out, so four voices do not stack
  the lead's breaths. Notes that meet are crossfaded over 12 ms with a partition of unity (a held tone keeps its level), free edges
  fade over 20 ms. Unvoiced sound inside a note is shifted along with it; sound outside any note is dropped.

### The app (`app/harmony/voices.ts`, `voice-lead.ts`, `voice-render.ts`, `voice-jobs.ts` + `voice.worker.ts`)
- `makeHarmonies(services, clipId, spec)`: `prepareLead` reads the sound the clip plays (a pitch-correction render when it has one),
  analyses the part it plays plus 0.5 s each side in a Worker (`analyzeInWorker`, the pitch editor's analysis; reverse is refused),
  `planVoices` plans every voice together, each voice renders in its own Worker (inline in Node) and is stored; then **one**
  `history.transact` adds the lanes, samples, channels and clips (`addHarmonyVoices`): one undo step, and undo removes it all.
  Signatures are computed from the project as it was when the run started, so a change during the render shows up as out of date.
- `updateHarmonies(services, { clip?, force? })` remakes the stale voices (or all with `force`; of one lead when `clip` is a lead or a
  harmony clip) from the lead as it is now, planning a run's voices together so chord voices keep their order, and replaces each voice
  channel's sample (`setHarmonyRender`, which also drops the old `SampleRef` once nothing plays it) in one undo step. Tracks, clips,
  levels and pans are not touched; the seed is kept, so a voice whose inputs did not change comes out the same bits. Split clips of a
  voice share its channel and are updated together; a voice whose lead is gone is left alone. One run at a time.
- Preview (`voice-preview.ts`): the first 20 s of the lead's part, voices rendered as above, mixed with `previewMix` at the settings'
  level and equal-power pan, as two 24-bit WAV files (lead alone, lead with voices, both turned down by the same amount when the stack
  would pass 0.95), played on the audition bus (`engine.previewAudio`). Nothing in the project changes.
- Measured (Node, M-series Mac under other agents' load, 60 s mono lead at 48 kHz with 80 vibrato notes): analysis 343 ms, planning
  1.4 ms, one voice 0.69 s (0.67 s with a formant offset).

### UI, commands, AI and MCP
- Right-click an audio clip › **Make harmonies…** (and **Update harmonies**, with a count of voices out of date, on a lead or a voice),
  Playlist menu, the action search (Mod+K) and the commands `harmonies.make` / `harmonies.update` (both have `argsHint`s, so they are in the
  AI and MCP command catalog).
- The dialog (`ui/features/harmony-voices`, an overlay like the filters' dialog): starting sets (Thirds, Chord stack, Choir), up to four
  voices each with a rule menu (named intervals, chord tone above/below, fixed interval in semitones, guide melody = the notes of an
  instrument channel), level (dB), pan (−100…100), vowel (cents), humanize (timing ms, pitch drift cents, vibrato %), warnings written
  in plain words (no song key, empty chord track), **A · Lead alone / B · With harmonies / Stop** preview buttons and Make. One seed
  per dialog, so what is previewed is what is made. Every control has a `data-hint` with its units.
- AI and MCP: actions `make_harmonies { clip | track+bar, voices: [{ rule, interval?, level, pan, formant, channel? }], humanize?, seed? }`
  and `update_harmonies { clip?, force? }` (`app/ai/ops/harmony-voices.ts`) check the request (the key, the rules, the clip) and queue
  the app commands as after-steps, since rendering takes a few seconds. `rule` is a named interval (`third_above`…), `diatonic` +
  `interval` ("5th below"), `chord_above`, `chord_below`, `fixed` + semitones or `guide` + `channel`. The prompt section says to set the
  key first and that the AI cannot hear the result.

### Tests
Node: `core/harmony/voices/voices.test.ts` (a synthetic lead in A minor: a third above lands on the scale degree within 10 cents
note by note when its output is analysed; planned thirds, sixths, octaves; fixed intervals; guide melodies with silence and octave
folding; chord voices are chord tones, never cross, move smoothly, fall back to a third; humanize stays inside its bounds and moves
note starts within them; the render is bit-identical; breaths and silent notes are left out; the formant peak moves by the setting;
the crossfade keeps level; the signature follows chords, key, sound and settings), `app/harmony/voices.test.ts` (one undo step, lanes under
the lead, hashes kept, bit-identical samples from the same seed, no key, update only the stale voice and undo it, request parsing),
`voice-preview.test.ts`, `ui/features/harmony-voices/dialog-model.test.ts`, `app/ai/ops/harmony-voices.test.ts`; browser:
`test/browser/harmony-voices.test.ts` (the engine plays a voice clip a third above the lead).

### Limits
- One clear voice, like the pitch editor: chords and noisy takes give no notes. A note the analysis misses is dropped from the voice (it is
  not sung unison). TD-PSOLA is at its best within about ±5 semitones; a sixth or an octave sounds rougher.
- The voices follow the lead's notes: a lead moved in time does not move its voices (they are ordinary clips; move them together).
  Update remakes the sound, not the geometry.
- A lead on a resample-follow channel is planned at the pitch the tempo it was made at gives; changing the song tempo later is not read
  as a change by the signature of a diatonic rule.
- Voices of a run missing from the project (a deleted track) are not planned: the chord voices left take the nearer ranks.

## Audio to MIDI (`core/audio/transcribe`, `core/ops/transcribe.ts`, `app/transcribe`, `ui/features/audio-to-midi`)

"Convert to MIDI…" turns an audio clip (a sung line, a drum loop, chords, a bass) into notes in a new pattern. The audio is
not changed, and the whole result (the channel, the pattern, the notes, the playlist clip, the chords) is one undo step.

**What a producer does.** Right-click an audio clip (its ▾ menu is the same list), **Convert to MIDI…** (also Playlist → Convert
to MIDI…, or Mod+K and "convert"). The dialog opens with the mode the sound suggests (a voice → Melody, a loop with a kick and
hats → Drums, pads → Chords, one low line → Bassline), the number of notes found and a small piano roll of them. Pick a channel
(a new one with an instrument that fits, or an existing instrument channel), the grid to snap to, how strongly, whether to
straighten the swing or keep the recording's feel, and how sensitive the listening is; press **A · Audio**, **B · MIDI** or
**A + B** to hear the notes against the audio, then **Convert**. "Place it on the playlist" puts a pattern clip under the audio
clip at its place and length; "Mute the original audio" leaves only the notes playing.

### Two stages, so the dialog stays quick

- **Listening** (`listen(mode, mono, rate, { sensitivity, startSec })` in `core/audio/transcribe/listen.ts`, the slow part, run in a
  Worker by `app/transcribe/jobs.ts`; inline in Node tests) gives `Heard` in the recording's own seconds: notes (melody and bass),
  drum hits with kit examples, or the DJ chromagram (chords). It does not depend on the clip, the tempo or the grid, so it is
  remembered (`app/transcribe/listening.ts`: the last dozen, keyed by the sound's hash, the part listened to, the mode and the
  sensitivity in 5 % steps).
- **Planning** (`planTranscription(heard, timeline, settings)` in `plan.ts`, cheap) lands the heard sounds in the clip's own ticks
  and returns `Transcription { notes, chords, pads, lengthTicks, swingFound, summary }`. Moving a slider only plans again.

`ClipTimeline` (`timeline.ts`) is the clip's own playback maths (`sourceSecondsAt` / `tickAtSourceSeconds` of
`core/audio/playback.ts`: trim, tempo follow by resampling or stretching, the channel's pitch, tempo automation) plus the song's
beat and bar lengths and swing. So **the notes land where the audio plays**: a note at 1 s of a sound recorded at 120 BPM and
stretched into a 90 BPM song lands at 1920 ticks; what the trim cuts off is left out; a note that began before the trim and still
sounds is kept from the clip's start; the keys are the pitch the song hears (the channel's pitch, and the speed of a resampling
follow, move them). The audio listened to is the sound the clip plays (a vocal cleanup, an alignment or a pitch correction's
render when it has one: `playedSampleRef`) with 0.25 s of margin each side, so a note or hit at the edge is whole. A reversed
channel is refused in plain words.

### Melody (`melody.ts`, `notes-heard.ts`, `levels.ts`)

The pitch editor's sung-note analysis (`analyzePitch`: YIN, cleaning, octave repair, cut where the pitch settles on a new level),
plus: a note is split where its level dips 6 dB and comes back (a repeated note of the same pitch, which the pitch track sees as
one), each note gets a loudness (the 80th percentile of its 10 ms levels) and a velocity from it (the 95th percentile of all notes is
1, 24 dB under is 0.25: the sensitivity moves that floor from 24 to 48 dB and the shortest note from 120 to 40 ms). Planned notes
are whole semitones (`keepCents` writes the cents as the note's fine pitch). The ends: **natural** (as heard), **legato** (a gap
shorter than the threshold, 150 ms by default, is closed) or **staccato** (half the length). Notes of one voice never overlap.

### Drums (`drum-bands.ts`, `drum-views.ts`, `drum-rules.ts`, `drum-leak.ts`, `drum-cuts.ts`, `kit-clean.ts`, `plan-drums.ts`)

A hat over a kick is two hits, so each kind is looked for where it lives. Four views of the sound (Butterworth filters of
`core/voice/filters`): **sub** < 100 Hz (kicks, 808s), **low** 80–400 Hz (toms), **mid** > 330 Hz with an 8th-order filter so a kick's
harmonics are gone (snares, claps, rim shots; its starts are looked for in 330 Hz–5.5 kHz so a hat's top end is not one), **high** > 7 kHz
(hats, cymbals). Each view has a 2 ms peak-level curve whose peaks are held for about half a cycle of the view's lowest pitch (so a
kick's own ripple does not read as new hits) and a start is a rise of 5–10 dB over the quietest block before it (`findOnsets`: a
loop that starts on a hit starts with it; a start soon after one in the same view, such as a clap's four bursts, is part of it). The
rules:

- **kick**: a start in the sub view that holds (its level 24 ms later is within 9 dB: a snare's low tone leaks in and fades at once) and
  that the **sample browser's classifier** (`categoryScores(extractFeatures(slice))`, `core/samples/classify.ts`) calls a kick or an 808
  (a low tom reads as tom)
- **tom**: a start in the low view with the mid view at least 5 dB under it, classified as a tom; the toms are grouped by the pitch of
  their body (zero crossings, 15–90 ms) and get the General MIDI toms' keys from the lowest drum up (1 drum: 45; 2: 41, 48; 3: 41, 45,
  48 …)
- **snare, clap, perc**: a start in the mid view that lasts (22 dB within 12 ms: a click does not), is not a hat's top end (the mid
  peak is at most 8 dB under the high view's start beside it), is more than a kick *leaks* there (below), classified from the mid view
  between snare, clap and percussion (the classifier's burst count tells a clap)
- **hat, open hat, cymbal**: a start in the high view that rings on (within 14 dB 8 ms after the peak: a kick's or tom's click and a
  clap's first burst do not) and is not the tail of another hit (< 60 ms after it), told by how long it rings (the classifier on the
  whole ring when 0.45 s are free, else its level 80 ms later). A hat under a snare or clap counts only when the recording has hats of
  its own (≥ 3), this one is within 3 dB of them and one of them is within 0.45 s (a hat pattern is running there)

**What a kick leaks** (`drum-leak.ts`): a kick has a click and harmonics, so the mid view starts at every kick. The recording teaches
the model: for each kick, the level the mid view reached in its first 30 ms and in the 30–70 ms after, against the kick's own level;
the lowest quarter of those ratios is what a kick does alone. A mid start beside a kick counts as another hit when it is 6 dB over
that in its head or 8 dB in its tail (a clap's bursts go on when a kick's click is gone). A hit's level is its peak less what was still
sounding before it (a kick on the tail of the last one is not as loud as the sum), which also gives the velocity: the loudest hits
of a kind are 1, the quietest kept are 0.25.

**Keys** (`GM_KEY`): kick 36, side stick (percussion) 37, snare 38, clap 39, closed hat 42, open hat 46, cymbal 49, toms as above: the
General MIDI map Drum Pads' default kit plays. **Pads from the recording**: for every key that plays, the hit of its kind with the
most room around it is cut out (from 4 ms before it to where the next hit starts, at most 0.1–1.5 s by kind; `cutsFor`), and when a
kind is always sounding with another (a clap on every kick), the other kind's clean example is slid ±5 ms to line up, fitted by
least squares over its first 0.15 s and subtracted (`cleanCuts`: the clap pad comes out with the kick 15 dB or more down instead of
doubling the kick). The cuts are stored as 24-bit WAV through the sample store (`app/transcribe/slices.ts`) and go into the new Drum
Pads channel's slots (`pad<n>`, n = key − 35).

### Chords (`chords.ts`)

`chromagram` of the sound (the DJ analysis), then for every beat (or half bar, or bar) of the clip the chroma is summed
(`clipChromaWindows`: trim, tempo follow and pitch respected) and read by `detectSpansFromChroma`. A slash bass read from a mix is
mostly a passing bass note, so chords come out as plain chords; one window that disagrees with both neighbours (below 0.8
confidence) is taken as a flicker. The chords are voiced with the harmony code (`voiceChords`: smooth voice leading around middle C,
an optional root as a low note) and written with a rhythm (`compNotes`: held, on every beat, on the off-beats, every eighth).
"Fill the chord track" also puts them on the song's chord track, replacing what was there under their stretch.

### Bassline (`bass.ts`)

The recording is low-passed at 260 Hz and followed by the melody path's tracker and note cutting (YIN 30–260 Hz), then: a note is
also cut where the low band attacks again (a bass struck on the tail of a kick or of the note before: a rise of ≥ 4 dB, not within
100 ms of an end), a note starts at the strongest attack of the low band within 110 ms before the tracker heard it (it needs two
periods), and **a kick is not a bass note**: a kick is a sub start with a click (a sharp rise > 7 kHz that is gone 8 ms later
by 15 dB), the pitch kicks ring at is the median pitch of the notes struck with one, and a note struck with a kick at that pitch (±0.7
semitone) is the kick's tail and is left out; a bass note at another pitch struck with a kick is kept. Repeated bass notes need a
10 dB dip.

### Quantize, swing and the mode suggestion (`quantize.ts`, `suggest.ts`)

The grid is the song's (a clip that starts between grid lines still lands its notes on them). Strength 1 puts a time on its line, 0
leaves it where it was heard. **Swing**: `measureSwing` is how late the sounds on odd 16ths are against the even ones, in units of
half a step (needs 4 off-beat sounds). *Straighten* snaps to straight lines as they play with the song's own swing (`unswingTick` in
`core/time/swing.ts` is the inverse of `swingTick`, so written ticks play where the quantizer said); *Keep* snaps to the lines of the
recording's own swung grid whatever the song's swing is. The **suggestion** (`suggestMode`, the first 30 s) scores the four modes from
the share of sounding frames with one clear pitch, how low the energy sits, how many kinds of drum there are (a kick alone is a bass,
hats alone are not a voice) and how often they hit, and how many pitch classes sound at once with how sure the key is.

### Writing it (`core/ops/transcribe.ts`, `app/transcribe/convert.ts`)

`writeTranscription(draft, …)` is one call, so one `history.transact`: a new instrument channel (`instrumentChannelFor`) or an
existing one, the pad samples (`addSample`, `setPluginSample`), a pattern as long as the clip rounded up to whole bars (its step
grid as many 1/16 steps), the notes, a pattern clip on the first free track under the audio clip (a new track when none has room),
the audio clip muted if asked, the chords. A new pattern is made even when nothing is placed (it is in the channel rack). The
suggested instruments (`app/transcribe/instruments.ts`): Drum Pads, Pluck, FM, 3xOsc. Pad samples are written inside `whileBusy`, so
storage clean-up keeps them; the project mentions their hashes. `planClip` remembers its plan (`plan-cache.ts`, keyed by the clip's
place, trim, tempo follow, sound, the song's tempo and swing and the settings), which the AI's synchronous read answers from.

### The audition (`app/transcribe/audition.ts`)

The first 16 s of the clip rendered twice with the engine's own offline render: the notes written into a *copy* of the project with
only the new pattern clip playing (so it is the real instrument, the real pad samples), and the audio alone; "A + B" is the sum
(all three turned down together when the sum would pass 0.95). They play as WAV files on the audition bus, so nothing in the project
changes and the transport is left alone.

### UI, commands, AI and MCP

- The command `audioToMidi.convert` ("Convert to MIDI…", with an `argsHint`): with no mode it opens the dialog
  (`ui/features/audio-to-midi`: the four mode buttons with a "Suggested" tag, the channel and instrument menus, the options, the
  controls each mode uses, the notes found as a mini piano roll, A/B/A+B/Stop, a "How this works" panel, every control with a
  `data-hint` that gives its units); with a mode it converts without it. `dialog-model.ts` is the dialog as plain data.
- AI and MCP: the action `audio_to_midi { clip | track + bar, mode, quantize, strength, swing, sensitivity, articulation, target,
  instrument, place, mute_original, slice_pads, fill_chord_track, chord_resolution, chord_rhythm, chord_bass }`
  (`app/ai/ops/audio-to-midi.ts`) checks every field now (`specParts`) and queues the command as an after-step, since listening takes
  a moment; the read `get_midi_conversion` (`app/transcribe/report.ts`) lists the notes a conversion would write (bar, beat, key and
  note name or drum, velocity, length in beats, the summary, the chords, the pads from the recording), "analyzing" the first time it
  listens. Both are in the MCP tool list without further work (`apply_actions`' schema and the read tools).

### Tests

Node: `core/audio/transcribe/transcribe.accuracy.test.ts` (the numbers below, on synthetic recordings from
`test/helpers/transcribe-signals.ts`: a sung voice, the Drum Pads' own sounds in loops, chord pads, a bass under a kit),
`transcribe.plan.test.ts` (trim, tempo follow and pitch, quantize strength and the song's grid, cents, legato and staccato, swing
straightened and kept with and without the song's swing, GM keys, toms, pads, velocity, the suggestion, determinism),
`kit-clean.test.ts`, `core/time/swing.test.ts` (`unswingTick`), `app/transcribe/convert.test.ts` (one undo step, the pattern and the
clip, pad samples kept by hash, existing channel, chord track, tempo follow), `app/ai/ops/audio-to-midi.test.ts`,
`ui/features/audio-to-midi/dialog-model.test.ts` (settings, menus, command). Browser: `test/browser/convert-to-midi.test.ts` (the
audition of a loop through the engine hits the same drums at the same times; a melody written as notes and played by the FM synth is
heard at the sung pitches).

### Measured (synthetic recordings, Node 22, one thread; the machine was shared, so times are upper bounds)

| mode | test material | result |
|---|---|---|
| Melody | 3 sung lines (24 notes: steps, repeated notes with rests, wide leaps; vibrato) | 24 of 24 notes at the right pitch, onsets within 20 ms (median 2.5 ms, worst 9.4 ms), no extra notes (asserted ≥ 95 %) |
| Drums | 5 loops, 270 hits (house at 124, boom bap at 90, trap at 140 and 48 kHz, rock with a tom fill, swung rock with ±6 ms of jitter) | 269 of 270 hits found with the right kind within 15 ms (99.6 %), precision 100 % (269 of 269), onsets median 0.9 ms, worst 11.7 ms; per kind: kick 63/63, snare 27/27, clap 8/8, hat 163/164, open hat 4/4, tom 4/4 (asserted ≥ 90 % overall and per kind) |
| Chords | 8 chords (triads and sevenths, changes on beat 1 and beat 3), 24 beats | 24 of 24 beats (asserted ≥ 90 %) |
| Bass | a bass on the off-beats under a four-on-the-floor kit with claps and hats, 90–128 BPM, 80 notes | 77 of 80 root notes (96 %; the three misses start 40–55 ms late), 4 extra (asserted ≥ 85 %, extras ≤ 15 %) |
| Audition | the loop through Drum Pads with its own hits, in the engine | ≥ 90 % of the audio render's hits found at the same time and kind in the MIDI render |

Speed: melody 0.53 s for 13 s of audio, drums 0.48 s for 50 s (five loops), chords 0.12 s for 14 s, bass 0.28 s for 40 s, the mode
suggestion about 0.1 s.

### Limits

- Hits that sound together are separated by where they live: a snare with a hat over it is found only when the hat pattern is
  running around it (a recording with hats only under snares reads none of them); a kick on the tail of another can be found up
  to 17 ms late; a clap on every kick has its pad cleaned only if the kick has an example of its own.
- The listening is tuned on the Drum Pads' sounds and the synthetic voice, bass, pads: real recordings have noise, room and
  bleed. Bass at tempos over about 130 BPM with a long kick can lose a note start by 50 ms; a bass note at the kick's own pitch struck
  exactly with a kick is lost; a kick without a click (an 808 on its own) reads as a bass note.
- Melody reads one voice: chords give no notes, and a plucked or synthetic timbre can read an octave low for the first 100 ms of a
  note. Chords and basslines from a full mix are a good guess: slash chords are not read, a passing note held for a beat can win.
- The notes are whole semitones by default and fixed velocities for chords. Pitch bends, sustain and other controllers are not
  written. Clips longer than 10 minutes are refused.
- The audition uses the engine's offline render (a few seconds for 16 s); the first B of a drum conversion also stores the pad
  samples, which storage clean-up removes when nothing mentions them.

## Lyrics (`core/lyrics`, `core/ops/lyrics.ts`, `core/query/lyrics.ts`, `app/lyrics`, `ui/features/lyrics`)

The words of a song live on a song-wide **lyrics lane**, placed in song time like the chord track, so they can be seen above the
playlist, under the notes of the piano roll and the note blobs of the pitch editor, followed like karaoke while recording, and
exported.

### What is stored (`Project.lyrics`, optional, no version bump)
- `Record<LyricId, LyricWord>`: `{ id, tick, length, text, line, continues? }`. A word is one word or one syllable (1-80 characters,
  no spaces or edge hyphens); `continues: true` means the next word is the rest of the same word, so "beau-ti-ful" is three words, the
  first two with `continues`. Words of one line share `line` (a new line starts where the number differs from the word before in
  time order, so numbers only have to differ between neighbours). Absent until a word is added.
- Words never overlap: every placement (`placeLyricWords`, `moveLyricWords`, `resizeLyricWord`) carves its span out of the words under
  it (a word inside goes, one that starts before is cut short, one that starts inside begins where the new one ends). Retyping a word
  with hyphens or spaces (`retextLyricWord`) splits its time equally among the syllables; `breakLyricLine` / `joinLyricLine` change
  the `line` numbers. The track disappears with its last word. Every edit is one `history.transact`; a drag commits once.
- `repairLyrics` (`core/schema/repair/lyrics.ts`, run by `repairProject`) drops words with a bad id, tick, length or text, cuts long text,
  puts a bad line number or `continues` flag right, trims overlaps so each word ends where the next starts, caps the track at 4096
  words and removes an empty track. Idempotent; tests in `core/ops/lyrics.test.ts`.
- Queries (`core/query/lyrics.ts`, memoized on the stored record): `lyricsSorted`, `lyricLines`, `lyricsBetween`, `lyricsEnd`,
  `patternLyrics(project, patternId)` (the words as a pattern plays them: the same first-clip mapping as the chord track,
  `patternToSongShift`), `lyricTrackLines` (the AI's text).

### Pure lyrics code (`core/lyrics`, no DOM, unit tested)
- `parse.ts`: text to lines of syllables. A token with hyphens between letters ("beau-ti-ful"), a trailing hyphen ("beau- ti- ful"), a
  leading one ("beau -ti -ful") or a lone dash between tokens are all the same syllables; blank lines are skipped, a word never runs on
  past the end of its line, at most 4096 syllables and 80 characters each.
- `slots.ts`: a slot is a place for one syllable. `slotsFromNotes`: notes that start within a 1/64 note are one slot (the highest
  note sets the end: the melody over a chord) and a slot never runs into the next; `slotsFromSungNotes`: the notes a singer sang in an
  audio clip (the pitch analysis, seconds on the sample) become song ticks through the clip's place and playback mode
  (`tickAtSourceSeconds`), cut to what the clip plays.
- `spread.ts` and `plan.ts` (`planLyrics`, the one place that decides where syllables go): **notes / clip**: one syllable per slot in
  order across lines (a line break skips no note), slots before `from` (or after `to`) are not used, extra syllables are left out and
  counted, extra notes stay empty; **even**: all syllables evenly between `from` and `to`, or without `to` one line per bar
  (`bars_per_line`). Pasting replaces the span the new words cover (`placeLyricWords(..., { replaceSpan: true })`).
- `lines.ts` (lines, `wordLabel` with its hyphen), `lrc.ts` (`lyricsToText`; `lyricsToLrc`: `[mm:ss.xx]line` per lyric line through the
  tempo map, optionally with `<mm:ss.xx>` before every syllable (enhanced LRC); `lyricsToMidiEvents`), `karaoke.ts` (`lyricCursor`: binary
  search for the last word that has begun and the progress through it, filling a cursor object: no allocation per frame).
- MIDI export (`core/io/midi.ts` `writeMidi({ lyrics })`, `app/actions/midi.ts`): a track named "Lyrics" with one lyric meta event (FF 05)
  per syllable at its tick, "/" before the first syllable of every line but the first, a space after the last syllable of a word; a
  pattern export carries the words of the pattern's stretch in the pattern's ticks.

### App and UI
- `app/lyrics/slots.ts` gathers slots (the piano roll's selected notes, else the selected channel's notes in the current pattern, at the
  place the pattern first plays; a channel's notes as the song plays them; the sung notes of an audio clip from its pitch edit or the
  analysis at hand, `clipSungSlots` analyses first). `app/lyrics/actions.ts`: `pasteLyrics`, `addLyricAt`, `retypeLyric`, `moveLyrics`,
  `resizeLyric`, `deleteLyrics`, `startLineAt`, `joinLineAt`, `clearLyricTrack`, `lyricsExport` / `saveLyricsFile` (text, LRC, LRC with
  word times) and `copyLyrics`. Each edit is one undo step and answers `{ ok, message }` for a toast.
- The **lyrics lane** (`ui/features/lyrics/lane-controller.ts`, `LyricsLane.tsx`) sits under the chord lane above the playlist ruler and is
  built like it: a canvas lined up with the playlist's scroll and zoom, redrawn only when the lyrics, the view or the theme change. Click to
  type a word (Enter adds, Tab adds and moves on one beat; "beau-ti-ful" makes three), drag across to set its length, drag a word to
  move it, drag an edge to resize, double-click to retype, right-click for Retype, Start a new line here, Join this line, Delete, Paste
  lyrics, Hide. Shown while the project has lyrics, or as chosen (`editor.lyricsLane`).
- **Paste lyrics…** (`paste-dialog.ts`, `lyrics.paste`): the words, where to put them (the selected notes, the selected audio clip's sung
  notes, evenly), the first bar and bars per line; the Lyrics window, the lane's menu, the Playlist menu, the piano roll's right-click and
  the action search reach it.
- The **piano roll** writes each word under the note it starts on (`piano-roll/lyric-labels.ts`: a note that starts up to a 1/32 note after
  the word's start and, of notes starting together, the highest; one word per note), on the notes layer, redrawn when the lyrics or the
  playlist change. The **pitch editor** does the same under the note blobs (`lyricsUnderBlobs` in `pitch-editor/model.ts`, the words
  converted to seconds on the clip's sample through `sourceSecondsAt`).
- The **Lyrics window** (`LyricsWindow.tsx`, `view.lyrics`, Alt+Shift+Y): the lines as big text (A- and A+, remembered), Paste lyrics, Save text,
  Save LRC, Copy, Clear, and Follow. `karaoke-follow.ts` runs on `ui/frame-loop.ts`: it asks `lyricCursor` for the word at
  `songPosition`, and only when the word changes toggles `sung` / `now` classes on the spans React drew once (and scrolls the current line
  to the middle); the fill of the lit word is one CSS variable. Playing a song makes no React commits (`test/browser/lyrics.test.ts` counts
  them with a Profiler). While there are no lyrics it explains what to do and offers Paste lyrics.
- Commands (`lyrics.showLane`, `lyrics.paste`, `lyrics.clear`, `lyrics.exportText`, `lyrics.exportLrc`, `lyrics.copy`, `view.lyrics`), each with a
  hint and an `argsHint`.

### AI and MCP
- Actions `set_lyrics { text, from_bar, to_bar?, align: notes | clip | even, channel?, clip?, bars_per_line? }` and `clear_lyrics`
  (`app/ai/ops/lyrics.ts`, through `planLyrics` on a snapshot of the draft, so notes written earlier in the same answer carry words), the
  `get_lyrics` read (lines with their bar and text, and with `words: true` every syllable's place), `lyrics` in the `open` windows, and a
  context section "Lyrics (first bar of each line)" that lists at most 16 lines of 60 characters and a count: a few hundred characters,
  nothing at all without lyrics. The prompt section is one sentence. A clip that has not been analysed yet answers "analyse it first".

### Limits
- One voice: words do not overlap, so two simultaneous singers (harmony lines) need separate takes or a later lane per voice.
- LRC and the Lyrics window follow the song position, not an audio clip's own time: moving a clip does not move words with it.
- MIDI import does not read lyric events back.

## Sheet music (`core/notation`, `app/notation`, `ui/features/sheet-music`)

The current pattern as a score: to read, to print and to edit. Nothing is stored in the project (a score is always made from the notes,
the time signature, the song key, the chord track and the lyrics as they are now); the view settings live in `editor.sheet` (not
undoable). Pitches are named as sheet music names them: **middle C (MIDI 60) is C4** here, where the piano roll calls it C5 (FL's
numbering). The window's status line, its help and the keyboard help say so.

### Engraving (`core/notation`, pure, no DOM, deterministic)
- `engrave(input) -> Score` (`engrave.ts`): staves, bars, voices, chords and rests with no coordinates. The steps, each in its own file:
  `quantize.ts` rounds starts and ends to the chosen grid (1/8, 1/16, 1/32; `useEnds: false` for drums) and looks at each beat on its
  own: when its note starts sit on third or sixth places of the beat better than on the grid (and at least one is clearly off the
  grid) the beat is a triplet (eighth or sixteenth triplets; one window per beat, up to a quarter note). `voices.ts` stacks notes that
  start and end together into chords, shortens a note that runs less than one grid step into the next (a legato line stays one
  voice) and puts chords into at most two voices per staff (three at once cut the earlier voice short and count it in
  `Score.simplified`). A drum part uses the voices by limb: hands in voice 1 (stems up), kick and pedal hi-hat in voice 2 (stems
  down); a hit lasts until the next hit of its voice or the end of its beat, and the rest of the beat is rests.
- `meter.ts`: how a time signature divides a bar. Simple meters beat by the denominator's note (4/4: four groups, with the middle of
  the bar a stronger place), compound meters (6/8, 9/8, 12/8) group by three eighths, 5 and 7 are 3+2 and 2+2+3. `levelAt` gives the
  strength of any place: bar line 0, middle of a long bar 1, a beat group 2, a division 3, then each halving.
- `split.ts` + `measures.ts`: a span becomes one symbol when it is one note value and does not run over a stronger place than the one
  it starts on; otherwise it is cut at the strongest place inside it and each part is tried again (ties join the pieces). Notes may
  also run over one beat line when they start on an eighth in a simple meter (the "eighth, quarter, eighth" syncopation); rests
  never run over a place as strong as their start, so a half rest begins only on beat 1 or 3 of 4/4. A bar with nothing in it is one
  whole-bar rest in any meter. A triplet beat is cut in "written ticks" (a third longer than they sound), so three eighths in the
  time of two come out as ordinary eighths with a `TupletInfo`; a whole beat of one note stays a plain note.
- `spelling.ts`: the key signature from the song key (modes and their parents: A minor has none, D dorian none, a pentatonic uses its
  parent's), the letter and accidental of every key (diatonic notes as the signature says, notes of the key's own seven-note scale
  by scale letters so D harmonic minor has C sharp, a white key outside the key natural, other black keys leaning with the
  signature), staff position, and `stepInKey`. `accidentals.ts`: a sign when a note differs from what is in force for its letter and
  octave in the bar; natural signs; courtesy signs (in brackets) when the last bar left a letter altered and this one is back at the
  key's value; a tied note does not repeat its sign. `stems.ts`: stems (away from the middle line, voice 1 up and voice 2 down in two
  voices), beam groups (inside a beat group, a triplet or a rest-free run), seconds in chords on the other side of the stem.
- Clefs (`chooseClefs`, automatic): treble when the lowest note is A3 or higher, bass when the highest is E4 or lower, else a grand
  staff split at middle C; a drum part has the percussion clef. `drums.ts` is the General MIDI map (kick on the bottom space, snare on
  the third, hi-hat as a cross above the top line, open hi-hat with a small "o", toms, crash and ride crosses, others diamonds) and
  the names the text uses.
- `annotate.ts`: dynamics from velocities (pp to ff, a new mark only when the level moves for two chords in a row), lyric syllables
  under the voice-1 chord that starts within a 1/32 note, chord symbols per bar. `events.ts`: the score as a flat list of events (what
  the cursor steps through and what follows the playhead) and `describeEvent` / `describeBar` ("bar 3, beat 2, C sharp 5, quarter note").
- `text.ts`: the compact text, `| C4q E4q G4h |` (values w h q e s t, `.` dotted, `3` triplet, `~` tie, `[C4 E4 G4]h` chords, `rq` rests,
  `R` a whole-bar rest, `&` between voices, `kick:q` / `[kick hat]:e` drums, a header `4/4 key=Am tempo=120`). `formatNotation(score)` writes
  it from an engraved score and `parseNotation` reads it back (joining ties, warning about bars that do not add up).
- `musicxml.ts` / `musicxml-read.ts` / `xml.ts`: MusicXML 4.0 partwise out (divisions 960, key, meter, tempo, staves and clefs, voices with
  backups, chords, ties and tied marks, beams, tuplets with time-modification, accidentals, lyrics with syllabic, chord symbols as
  `harmony`, dynamics, percussion with `unpitched` and `midi-unpitched`) and a reader for the notes of the first part (durations in
  any divisions, backup and forward, chords, ties, percussion by instrument; not dynamics, lyrics or harmonies). A tiny XML reader
  does the parsing because core has no DOM.
- `edit.ts`: what editing means for notes: `movedKey` (scale step, semitone, octave), `entryTicks` (a dot is half again, a triplet two
  thirds), `keyForLetter` (a typed letter with the key signature, in the octave nearest the last note).

### Drawing (`core/notation/render`)
- `glyphs.ts`: noteheads (filled, half, whole, cross, diamond), clefs, accidentals, rests, flags and the brace as SVG paths in staff-space
  units (no music font to download); `layout.ts`: the width of each bar from its notes (spacing grows with the logarithm of the time to the
  next note; accidentals, dots and lyrics push neighbours apart), bars into systems that fill the page width (a short last system is not
  stretched), the vertical places of staves, chord symbols, dynamics and lyrics; `draw-voice.ts` and `draw.ts`: stems, beams (slant limited,
  stems never shorter than 2.75 spaces), ties, tuplet brackets, ledger lines, key and time signatures, bar lines, bar numbers. Each system
  is its own `<svg>` (a printed page can break between them). Everything is `currentColor`, so the theme colours it.
- Every chord and rest is a group with `data-t0` / `data-t1` (the pattern ticks it sounds between) and every notehead a group with
  `data-note` (the note id) and a hidden ring, so the window follows playback and shows the selection by changing one class.

### App and window (`app/notation`, `ui/features/sheet-music`)
- `app/notation/part.ts` chooses the part: the piano roll's channel (or the one named), or "All drums" (every drum channel on one staff,
  each written as the GM drum its role names). `sheet.ts` engraves it with `editor.sheet`; `actions.ts` are the edits (`moveSelectedNotes`,
  `setSelectedDuration`, `deleteSelectedNotes`, `insertNoteAt`) and MusicXML (`musicXmlOfSheet`, `importMusicXmlText`): each is one
  `history.transact` (repeated moves merge under one `mergeKey`), on the notes underneath, so the piano roll shows the same change. The
  selection is `editor.noteSelection`, shared with the piano roll in both directions.
- The window (`SheetMusicWindow.tsx`, `view.sheetMusic`, Alt+Shift+N; also in the piano roll's toolbar and right-click menu, File and the
  action search) is a React toolbar around a page that `sheet-controller.ts` draws imperatively: it engraves again (once per frame at most)
  when the pattern, the meter or key, the chords, the lyrics, the channels, the settings or the width change, and draws the systems with
  `innerHTML`; clicking a note selects it (Shift or Ctrl/Cmd adds), clicking empty space puts the cursor there and clears the selection,
  right-click opens the menu (raise, lower, duration, delete, print, save). `sheet-follow.ts` runs on the frame loop and toggles `ag-now` on
  the chords and rests whose ticks hold the playhead (a band behind them as well as a colour), turning the page when the lit system
  changes: playing makes no React commits.
- **Keyboard** (`sheet-keys.ts`, through `timeline/key-cursor`'s `KeyStack`, so it is one Tab stop with a name, a description and a visible
  frame): Left and Right step through the notes (rests are gaps: "nothing here"), Ctrl/Cmd a bar, Enter selects, Up and Down move the selected
  notes a scale step (Shift a semitone, Ctrl/Cmd an octave), A to G type a note at the cursor with the entry duration and move on (Shift
  sharp, Alt flat), 1 2 4 8 6 3 pick the duration (and change selected notes), `.` dots, T makes triplets, R rests, Delete removes. Every
  move and edit is spoken through the live region ("bar 3, beat 2, C sharp 5, quarter note, selected"); the svg is `aria-hidden` and a hidden
  text version (one paragraph a bar, up to 64 bars) is in the page.
- **Print** (`print.ts`, `sheet-music.css`): Print... builds a copy of the sheet laid out for 680 px (A4 or Letter inside 14 mm margins),
  appends it as `#ag-print-root`, marks `<html>` `ag-printing` and calls `window.print()`; the print stylesheet hides everything else,
  forces black on white and keeps each system whole; "Save as PDF" is the browser's own destination. The app renders no file itself.

### AI and MCP
- `get_notation { pattern?, channel? (an id, a name or "drums"), from_bar?, to_bar?, grid? }` reads a part as the compact text (up to 64 bars;
  `more` says where it goes on), with the header, the clefs and a note when overlapping notes had to be simplified; `write_notation { pattern,
  channel, text, from_bar?, replace? }` (`app/ai/ops/notation.ts`) writes a channel's notes from the same text (ties joined, chords, rests,
  triplets, two voices; drum names only into a drum kit channel; words it does not understand and bars that do not add up come back as
  warnings and the rest is written). What the read returns the action writes back unchanged (tested). The window is in the `open` action's
  list; the commands (`sheet.options`, `sheet.movePitch`, `sheet.setDuration`, `sheet.deleteNotes`, `sheet.print`, `sheet.exportMusicXml`,
  `sheet.importMusicXml`, `view.sheetMusic`) have hints and `argsHint`s.

### Tests
`core/notation/*.test.ts` (engraving in 4/4, 3/4 and 6/8; ties, rests and merging; grids and triplets; accidentals in sharp and flat keys,
courtesy signs and ties; clefs; two voices, beams, stems; drums; the compact text and its round trip; spoken descriptions; MusicXML out, the
reader, and the round trip of our own output including triplets, two voices, drums and ties; the SVG as a snapshot and its determinism; layout;
speed: 100 dense bars under 600 ms of CPU), `app/notation/actions.test.ts`, `app/ai/ops/notation.test.ts`, and
`test/browser/sheet-music.test.ts` (in Chrome: drawing, selection in both directions, pitch, length and delete from the keyboard through History,
typing notes and what is said, following with no React commits, the print copy and stylesheet, MusicXML out and in, and the accessibility checks).

### Limits
- Tuplets are the eighth and sixteenth triplets of one beat (no quarter-note triplets, quintuplets or nested tuplets); two voices per staff (a
  third overlapping chord shortens the earlier one); no grace notes, trills, slurs, articulations, clef changes or key and meter changes inside
  a pattern (the song has one of each); a pitched part is one channel (chords of several channels are not merged), and voice 2 chords are not
  moved aside when they meet voice 1's heads. A long pattern is drawn in full (hundreds of bars draw fine but print on many pages).
- MusicXML import reads the notes of one part only (no dynamics, lyrics or chord symbols), keeps the file's rhythm as it is (it is not
  re-quantized) and tells you when the meter differs from the song's.
- The selection is shared with the piano roll and belongs to one pattern: change the pattern and it is not translated.
- Spoken names use the sheet's octave numbers (middle C is C4), not the piano roll's (C5), so a screen reader user hears the names a score uses.

## Metering (`engine/meter`, `core/metering`, `app/metering`, `ui/features/meters`)

Loudness and stereo problems are seen while mixing: the **Meters** window (View → Meters, Alt+Shift+M, a click on the master
meter or on the master strip's readout, action search "Check loudness and stereo"), the mixer's master readout (short-term
LUFS and true peak), and an offline **Loudness report** (File → Loudness report…, or the window's button).

### The meter on the audio thread (`src/engine/meter`)

- `meter.worklet.ts` is a raw `AudioWorkletProcessor` (`agstudio.meter`) around `MeterKernel` (`suite.kernel.ts`, pure, no
  allocation in `process()`): the SDK's `LoudnessMeter` (K-weighting as BS.1770-4, 100 ms blocks: momentary 400 ms,
  short-term 3 s, integrated with the −70 LUFS and −10 LU gates, and **loudness range** after EBU Tech 3342: short-term values
  above −70 LUFS, 20 LU under their power mean, 10th to 95th percentile of a 0.05 LU histogram, new in `sdk/dsp/loudness.ts`),
  `TruePeak` per channel (4× oversampling; the maximum since the restart, and a current value that falls 20 dB/s), stereo
  correlation (0.3 s time constant), and, at **full detail** only, two Linkwitz–Riley splits (150 Hz and 2 kHz) giving the
  width (side / (mid + side)), correlation and mono loss of the low, mid and high band, an 8192-point stereo FFT every 2048 frames
  (`sdk/dsp/fft.ts` `StereoSpectrum`: one complex transform serves both channels, Hann window, power scaled so a full-scale sine
  reads 1 in its bin) and the goniometer ring (2048 frames of left/right). A loudness history (momentary and short-term every
  100 ms while there is sound, 20 minutes in a ring) lets the graph survive a hidden tab.
- **Shared memory, no messages**: the numbers are slots of one `Float64Array` on a `SharedArrayBuffer` (`layout.ts` `R`), plus
  history, spectrum and scope buffers; the main thread also writes the controls there (detail, a reset counter, closed). The
  frame loop reads them; nothing allocates per frame. After a restart the maximums wait for the windows to fill with new audio
  (momentary 0.4 s, short-term 3 s) and the true-peak hold skips the detector's 16-frame memory.
- **Only while somebody looks.** `MeterNode` (`meter-node.ts`) makes the worklet node, connects it to the node it listens to
  (through a silent sink so the graph pulls it) and, on `close()`, disconnects it and sets `closed` so the processor ends.
  `Engine.openMeter(source, { full })` listens after the fader of an insert (`MixerGraph.outputNode`; the master's is what
  leaves the mixer, before the safety limiter and the metronome and previews) and returns null offline or without
  cross-origin isolation. `EngineHost.openMeter` returns a `MeterLease` (`app/meter-lease.ts`) that reopens the meter on a
  rebooted engine on the next read, so meters survive worklet reloads.
- `services.meters` (`app/metering/service.ts`) counts **leases** per source: the Meters window (full detail) and the mixer's
  master readout (basic) share one meter, full detail lasts as long as a lease asks for it, and the meter is closed with its
  last lease. While any meter is open it restarts the measurement whenever the song starts playing (setting "Restart on play").
  A Studio read opens a basic master meter for 30 s so the next read has numbers.

### The window (`ui/features/meters`)

- `controller.ts` runs on the frame loop (no React per frame, idle when the song is stopped and the signal is silent, readouts
  rewritten at most every 100 ms and only when their text changes): `history-view.ts` (momentary thin, short-term bold, the
  target as a dashed line), `stereo-view.ts` (goniometer, correlation and width bars), `spectrum-view.ts` (the FFT power
  folded into 1/6-octave bands by `core/metering/octave.ts` `BandMap`, smoothed, peak hold 1.5 s, an optional tilt of 0, +3 or
  +4.5 dB per octave around 1 kHz, a reference curve), `spectrogram-view.ts` (one pixel column per spectrum the audio thread made;
  the canvas shifts itself). Text and warnings are pure in `meters-model.ts`.
- Band math: bins fold with fractional edge weights and a Hann power divisor of 1.5, so a sine reads 0 dB in whichever band
  holds it (tested). The **reference overlay** spreads each of the reference song's eight tonal bands (shares in dB under the
  total) evenly over the display bands it covers and places the whole at the live signal's total power.
- **Target line**: `app/metering/targets.ts`: a reference song's loudness when one is set, else the song style's master loudness
  from auto-level (`LEVEL_TARGETS[inferStyle(project)]`), or Streaming −14, Apple Music −16, Broadcast −23 LUFS, or none.
- **Mono compatibility**: the bass band (below 150 Hz) with correlation under 0 and a level above −50 dBFS shows "the bass is out
  of phase" with the dB it loses in mono; correlation under −0.2 overall warns that the channels cancel.

### The loudness report (`app/metering/report.ts`, `core/metering/report.ts`)

Renders the whole song (or the bars asked for, or the current pattern on a loop when there is no song yet) through `renderOffline`
with the master safety limiter, measures it with `LoudnessProbe` (`app/analysis/loudness-probe.ts`: the same `LoudnessMeter` and
`TruePeak` as the live meter, plus where the loudest moments are) and reports integrated LUFS, LRA, the highest true peak and sample
peak with their bar, the loudest momentary and short-term values with their bar, correlation and mono loss, and what Spotify,
YouTube, Apple Music, Tidal, Amazon Music and EBU R128 do (`core/metering/targets.ts`: turned down by X dB, or turned up as far
as the peaks allow, only by the services that do), with plain notes (true peak over −1 dBTP, very loud, almost no range, out of
phase). It changes nothing in the project and needs no undo step; copy it as text. A 15 s house song took 1.7 s in all (its integrated loudness, −17.54 LUFS, matches the live meter's −17.5).

### Studio and MCP

`get_loudness` (live readings, the target, the last report), the `loudness_report` action (optional `from_bar`, `to_bar`; an
after-step like the reference's tone check; the numbers come back as the step's lines), `meters` in `OPEN_WINDOWS`, the commands
`view.meters`, `meters.report` and `meters.reset` (in the command catalog). MCP lists the read tool and the action by itself.

### Measured (headless Chrome, M-series Mac)

- Pure kernel (`suite.kernel.test.ts`), EBU Tech 3341 cases synthesized: a −23 dBFS stereo 1 kHz sine reads −23.0 LUFS (momentary,
  short-term, integrated; also at 44.1 and 96 kHz), −33 reads −33.0, the relative gate (10 s at −36, 60 s at −23, 10 s at −36)
  reads −23.0, an absolute-gated part never counts; loudness range cases of Tech 3342 (10, 5, 20 and 15 LU) within 1 LU; true peak
  of fs/4 at 45° (the inter-sample peak case) within 0.2 dB at 0, −3, −6 and −12 dBTP, and of 997 Hz, 9 kHz and 11.025 kHz sines
  at any phase within 0.2 dB; correlation +1 / −1 / about 0 for the same signal / opposite polarity / unrelated noise; a bass out
  of phase under a mono mid is told apart (low correlation −1, 20+ dB lost in mono).
- Worklet in Chrome against the offline measurement of the same rendered house song (`test/browser/meters.test.ts`): integrated
  loudness identical to 0.001 LU (−17.607 both), range and true peak equal; a **live engine** playing the song reads −17.61 LUFS
  against −17.62 offline (limit 0.3 LU).
- Cost (offline render time of 30 s of noise and a sine, best of three, over the same render with no meter): basic detail
  0.50 % of a core, full detail 1.33 % (limits 2 % and 4 %). A closed meter: the node and the processor are gone (`blocks` stands
  still, `Engine.meterCount` 0).

### Limits

- The master meter listens before the safety limiter (−0.3 dBFS), so a mix that clips there reads a hair louder in true peak than
  an export. Previews and the metronome are not in it.
- The spectrum is the mean of the two channels' power; a signal that is out of phase still shows. The spectrogram's time scale is
  23 columns a second (a late frame paints up to 12 at once).
- Without cross-origin isolation (not the dev or preview server) there is no shared memory and the window says so.
- The report measures one render of the master chain: tempo changes inside the song are followed, a tail after the last bar is not.

## Clip launcher (Performance mode)

An FL-style Performance mode / Ableton-style session view: a grid of slots (tracks across, scenes down) that point at
patterns and audio clip channels and are launched live, in time with the transport. Files: `core/launcher/*`,
`core/ops/launcher.ts`, `engine/sched/launch.ts` (+ `transport.ts`, `engine.ts`), `app/launcher/*`, `app/ai/ops/launcher.ts`,
`ui/features/launcher`, pad presets in `core/midi-map/presets/pads.ts`.

- **Document** (`Project.launcher`, optional, no schema bump; `repairProject` validates it and drops slots whose pattern or
  channel is gone): `quantize` (grid default: none, beat, bar, 2 bars, 4 bars), `tracks`/`trackOrder`, `scenes`/`sceneOrder`.
  A track has a name, colour, optional `laneId` (the playlist track it takes over while it plays) and `slots` by scene id.
  A slot has `content` (a pattern id, or an audio clip channel + trim + length in ticks + gain/fades: the sample is never
  copied), name, colour, `mode` (trigger default, toggle, gate, retrigger), `loop` (default on), own `quantize`, and `follow`
  (next / random / stop after 1–64 bars). Edits are `core/ops/launcher.ts` mutators, so they are ordinary History steps; deleting
  a pattern, channel or playlist track prunes the grid in the same step (undo restores both).
- **Live state is not the document.** `LaunchRun`s (`core/launcher/run.ts`) are session state, never saved, never undoable, like the DJ
  decks. `app/launcher/session.ts` (`services.launcher`, created in `createServices`) owns the pure `LaunchSequencer`
  (`core/launcher/sequencer.ts`) and hands it to the engine (`EngineApi.setLauncher`).
- **The launcher axis `u`.** A continuous tick count that advances with the transport and never wraps: a looping song or pattern jumps
  its own tick back, `u` keeps counting, so a launched loop carries on across the song's loop wrap. A song played from tick `t0`
  starts at `u = t0` (so the quantize grid is the song's bar grid); a seek keeps `u` counting, lined up to the new position's bars;
  the launcher on its own starts at 0. `Transport` stamps every planned segment with `u0` (`USegment`) and converts exactly like song
  ticks (`time = seg.time0 + (u − u0) · spt`), so launches are as sample-accurate as the song: events for a segment come from
  `engine/sched/launch.ts` (`collectLaunchNotes` reuses `collectNotes` on virtual clips; `collectLaunchAudio` makes one clip per pass).
- **Quantized starts and stops.** `LaunchSequencer.boundary` = the first multiple of the quantize at or after the heard position and no
  earlier than `earliestU` (the time the first notes need to reach the audio thread past the audio clock, `Engine.launcherClock`), with one
  exception, the **grace rule for early presses**: a boundary that is not yet heard but already inside that margin is still taken when it is
  at most `LAUNCH_GRACE_SEC` (30 ms, `core/launcher/run.ts`) behind the audio clock (`LaunchClock.lateU`); further behind, it rolls to the next
  boundary. So a press 5 ms before the bar lands on that bar, its first notes up to 30 ms late (a flam against the rest of the music), not a
  whole bar later. The transport makes it work: a re-plan restarts at now + 10 ms, so `Transport.setModel` also plays, late, the notes of
  runs that start before its cursor and were never planned (`catchUp`: `launchDone` knows which runs the planner has passed; audio passes
  already start inside their sample through the usual ongoing scan), cancels notes of a run that was cut before they began, and releases cut
  runs' notes at the cut. Those late notes are not counted in `lateEvents`, so they do not raise the lookahead.
  One run per track: launching replaces a queued run and cuts the playing one at the boundary; a scene launches its row together at the
  coarsest quantize among its slots; stop-track/stop-all cut at the boundary (or now). Modes: trigger (a press while it plays does nothing;
  a press cancels a pending stop), toggle (second press stops it), gate (release stops it), retrigger (every press restarts). Follow actions are
  scheduled a bar ahead on each scheduler tick (`advance`), so a press in between wins. A change to the runs re-plans through the
  existing `Transport.setModel` (not-yet-started notes are cancelled and collected again; sounding launcher notes follow their run's new end).
- **On its own or over the song.** With the transport stopped, the first launch starts it for the launcher alone (`Engine.soloLauncher`:
  no playlist, constant tempo, runs from `u = 0`); it stops with the last run. While the song plays, launched slots play over it; a launcher
  track with a `laneId` silences that playlist track's notes and audio from the run's start tick (a note sounding then is released there) and
  gives it back when the run ends. Play while the launcher runs alone hands over to the song (the runs go on). Stopping ends every run;
  an engine reboot while playing ends them too (they do not carry to the new AudioContext). Launched audio uses the clip player with a
  synthesized clip per pass; its sample is decoded ahead and, on a 'stretch' channel, so is its stretched copy (`ChannelStrip.warm`).
- **Launched audio follows the song like a playlist clip.** Each pass gets the song's tempo along its way as the `AudioOn.tempo` map
  (`engine/sched/launch-tempo.ts`): the launcher axis is the song's tick shifted (song tick = start tick + (u − start u), wrapped at the loop
  end like the planner wraps it), so the map is the song's tempo steps (automation) laid on `u`, crossing loop wraps, and a plain constant
  map when the tempo does not change during the pass (always, for the launcher on its own: constant project tempo). The clip player then
  changes the playback rate at every step in 'resample' and 'stretch' mode exactly as for a playlist clip, and a tempo edit restarts the
  pass (as for playlist clips). 'Stretch' passes play the **same copies the playlist makes**: `SampleResidency.stretched` finds a launcher
  clip (`launch:<run>:<pass>`) by sample, scale and the part of the sample it plays (the playlist's key `…|st2:<scale>:<from>-<to>`, so a
  copy made for either is reused, and read back from disk), starts it when it does not exist, and keeps it pinned while a run that uses it
  lives (`endLaunch`). The first pass's copy is made at press time (`Engine.warmLaunchAudio`, under the tempo the pass will start at; a
  pass is still never late: until the copy is ready the plain sample plays, then swaps in with the usual crossfade). A later pass that starts
  under another tempo (automation, a song that changes tempo across a loop) makes its own copy when it comes up and plays the plain sample
  first; at a constant tempo there is one copy for all passes. The pitch of a 'stretch' pass is that of its start tempo and drifts with later
  tempo changes inside the pass, as for a playlist clip. `Engine.launchReady()` resolves when everything the runs need is made (tests).
- **Record performance.** `startRecording` keeps the runs from the next bar (from `u = 0` when nothing plays), `stopRecording` ends at the
  next bar, and when the music reaches it `onTake` gives the session what played; `core/launcher/perform.ts` writes it as one History step
  ("Record performance to playlist"): pattern runs become pattern clips (a loop is one clip with the pattern repeating, a run that was playing
  at the start keeps its place through `offset`), audio runs become one clip per pass, on the launcher track's playlist track when it is free
  there, else on a new "Jam · track" lane, at `u` as song ticks.
- **UI** (`ui/features/launcher`): the Clip launcher window (View menu, `Alt+Shift+L`, action search, the playlist clip menu's "Send to clip
  launcher"). Slots are painted off the React path: `LauncherView` (a frame-loop callback) writes `data-state` (empty/idle/queued/playing/
  stopping) and `--p` (a CSS ring) only when they change and does nothing while nothing runs, so idle launcher playback causes no React commits
  (`test/browser/launcher-ui.test.ts` counts them). Press launches on pointer down (gate: release stops); drag a pattern from the Browser onto a
  slot, the grip moves/copies slots; right-click for mode, loop, quantize, follow, name, colour, MIDI learn; keys: arrows, Enter, number keys
  (scenes), Period (stop track), Delete, Shift+arrows (pad page). The empty window says what to do next.
- **Filling slots from elsewhere.** *Playlist clips:* the playlist moves clips with pointer events, so it hands a clip drag over by the DOM
  (`ui/clip-drop.ts`: elements with `data-clip-drop` take clips; while the pointer of a move drag is over one the clips stop moving and the
  element gets `data-clip-drop-over`; on release it receives a bubbling `agstudio:clip-drop` event). The launcher's slots carry the
  attribute; `putClipsAt` puts the first clip (time order) in the slot and the rest in the slots below, one History step, playlist untouched,
  automation clips skipped. *Audio files* (from the desktop or out of the sample browser: `takeAudioFiles`): `putAudioFilesAt` imports each
  through `importAudioFile` (`importSampleBytes` into the default sample store), makes the audio-clip channel a playlist drop makes, and
  fills the slots down the track, all one History step.
- **Pad pages.** The controller pads are an 8 × 8 window on the grid (`LauncherSessionState.page`, view state): `padPress`/`padScene`/`padStop`/
  `padState`/`sceneState` take positions on the page, and the manager's `LauncherControl` uses only those. `launch.page:left|right|up|down`
  targets (Launchpad arrow buttons: control changes 104–107 on the original/S/Mini/MK2, 91–94 on the Mini MK3/X, in the presets), commands
  `launcher.pageLeft/Right/Up/Down` (Shift+arrows in the window) and the window's page buttons move it by 8 tracks or scenes and refresh the
  lights at once. A grid that shrinks counts as its last page. The window dims what is off the page, and a slot's MIDI-learn target is its pad
  on its page (`launch.slot:(t mod 8)+1:(s mod 8)+1`).
- **Controllers.** Launcher pads, scene buttons, stop buttons and page buttons are targets of the DJ controller layer (`launch.slot:T:S`, `launch.scene:S`,
  `launch.stop:T`, `launch.stopAll`, `launch.page:dir`, 1–8; `core/midi-map/targets.ts`), so MIDI learn, import/export and the Controllers window's "Clip launcher"
  section work; the window's slots carry `data-dj-target`, so learn mode picks them by click. `DjControllers` routes launcher events to
  `LauncherControl` without needing the decks and drives pad lights (`app/launcher/leds.ts`): each linked pad shows empty / loaded / queued /
  playing from `ControllerMapping.pads` (a palette of note velocities), compared every 80 ms and on every press. Presets
  (`presets/pads.ts`): Launchpad original/S/Mini (note = 16·row + column, scene buttons in column 8), Launchpad MK2/MK3/X in note layout (11–88,
  scene buttons 89 … 19), and a generic 8×8 grid (notes 36–99), from Novation's programmer's references.
- **AI and MCP.** `launcher_slot` (pattern/audio/clip into a slot, name, colour, mode, loop, quantize, follow, clear), `launcher_layout` (default
  quantize, grid size, scene and track names, track ↔ playlist track links), `launcher_play` (launch, launch_scene, stop_track, stop_all, stop_now,
  record, stop_recording: live, runs after the edits in `applyAnswer`, so chat and MCP share it); `get_launcher` read (also an MCP tool);
  `<launcher>` in the project context; `launcher` in `OPEN_WINDOWS`; commands `launcher.*` with `argsHint`.
- **Tests.** `core/launcher/*.test.ts` (sequencer, ops, repair, record to playlist), `engine/sched/launch.test.ts` (exact times through the transport
  with a fake clock, including early presses and passes under tempo automation), `engine/sched/launch-tempo.test.ts`,
  `test/browser/launcher.test.ts` (offline renders through the real engine: boundary error 0–3 frames at 97–174 BPM, an early press 5 ms
  before the bar, replace, scene, stop, follow, audio, over a song), `test/browser/launcher-audio.test.ts` (stretched pitch, tempo automation),
  `test/browser/launcher-ui.test.ts`, `test/browser/launcher-drops.test.ts` (playlist hand-off, file drops, pad page), `app/launcher/edit.test.ts`,
  `app/launcher/launcher-controllers.test.ts` (pads, page buttons), `app/ai/ops/launcher.test.ts`.


## Windows, macOS and Linux (`tools/platform`, `scripts`, `bin`)

AGstudio is developed on a Mac and must run the same on Windows 10/11 (Chrome or Edge, Node 22 from nodejs.org) and Linux. Nothing
below was run on Windows in development: it is written to Node's cross-platform APIs and checked by unit tests that pass the
platform in (`win32`, `darwin`, `linux`); a run on a real Windows machine is still the missing proof.

- **Launchers.** `bin/agstudio` (sh) and `bin/agstudio.cmd` only find Node and run `scripts/agstudio.mjs`, which holds the logic:
  the dev server on 5390 or, with `--app`, the production build on 5391; "already running" is a `fetch`; the build is made when `dist/sw.js`
  is older than any input (`isBuildStale`); `npm ci` and Vite run as `node npm-cli.js` / `node vite.js` (no shell, no `.cmd`); the browser
  or installed app is opened with `open` / `cmd /c start "" <url>` / `xdg-open` (`openCommand`; `AGSTUDIO_NO_OPEN=1` skips it). The pure,
  platform-taking parts are in `scripts/lib/launcher.mjs` (typed by `launcher.d.mts`); `bin/agstudio-mcp(.cmd)` does the same for the MCP helper.
  `.gitattributes` keeps text files LF in every checkout (`.cmd` files are CRLF) so snapshot tests and shell scripts keep their bytes.
- **npm scripts.** Nothing in `package.json` needs a Unix shell: `test:perf` is `scripts/test-perf.mjs` (sets `VITE_PERF_STRICT`), and
  `scripts/check.mjs` starts tsc, eslint and vitest (the tag filters of its stages are plain words in `scripts/lib/test-stages.mjs`) as `node <their JS file>` (`scripts/lib/tools.mjs`), because Node (18.20+) refuses to
  start a `.cmd` shim without a shell and a shell would re-parse every argument. The audio tests use the installed Chrome; set
  `AGSTUDIO_TEST_BROWSER=msedge` to use Edge instead.
- **Finding and starting the AI CLIs** (`tools/platform`): `find-cli.ts` lists where `claude` / `codex` may be (an override, then the PATH with
  `.exe`/`.cmd`/`.bat`/`.com` on Windows, `~/.local/bin`, `%APPDATA%\npm`, pnpm, WinGet and Scoop folders; the old Mac list unchanged).
  `spawn-plan.ts` turns "run this file with these arguments" into a spawn call: a `.exe` runs directly; an npm `.cmd` shim is read and its
  real target (`.js` through this server's own Node, or an `.exe`) runs directly; any other batch file goes through `cmd.exe /d /s /c` with
  every argument quoted by `quoteForCmd` (the qntm.org/cmd rules, as the `cross-spawn` package does). `tools/ai/cli.ts` uses it, kills the
  whole tree with `taskkill` when cmd.exe is in between, and starts everything with `windowsHide`. Environment names are matched
  case-insensitively on Windows (`envWithout`).
- **Long prompts.** Windows stops a command line at 32 767 characters (8 191 through cmd.exe) and the Claude turn carries up to 60 000
  characters of system prompt and about 76 KB of schema. `fitsCommandLine` decides per system (Windows 30 000 / 7 000 characters; Linux
  100 000 bytes per argument, 500 000 in all); a turn that does not fit takes the stdin transport. Codex always used files.
- **Paths.** `vite.config.ts` normalizes its root to forward slashes (Vite's aliases, globs and the watcher ignore list want them); Faust ids
  and the plugin builder's tsconfig paths are forward-slash too; a folder move in the plugin builder retries while Windows reports the folder
  busy (`renameFolder`). Everything else in `tools/` and `scripts/` uses `path.join`, `fileURLToPath` and `os.homedir()`.
- **UI.** The keymap formats chords per system (`Ctrl+Shift+Z`, not `⇧⌘Z`); sentences that name keys use `ui/shortcut-label.ts`; the install
  steps cover Edge; the font stacks include Segoe UI and Consolas; the MCP Settings lines follow the platform the server reports.
- **Tests that start fake CLIs** use `test/helpers/fake-cli.ts` (a script with a shebang on macOS and Linux, a `.cjs` plus `.cmd` pair on
  Windows).

## Installable app (PWA)

AGstudio installs from Chrome as an app (its own window, dock or Start-menu icon, starts without a server, opens `.agproj`
files). No Electron and no dependency: a manifest, a hand-written service worker and a small build step.

- **Which server, which origin.** An installed app belongs to one origin, port included, so the dev server (`agstudio`, port
  5390) is not what gets installed: `agstudio --app` builds when needed and serves the production build with `vite preview` on
  5391 (`$APP_PORT`; `preview.port` in `vite.config.ts`). The installed app opens from the service worker's cache, so it starts
  with that server stopped too. Nothing else changed for `npm run dev`.
- **Manifest** (`public/manifest.webmanifest`, linked from `index.html`): `id`/`start_url`/`scope` `/`, `display: standalone`
  with `display_override: [window-controls-overlay, standalone]`, `background_color` = `--ag-bg`, `theme_color` = `--ag-surface-1`
  (the page keeps `<meta name=theme-color>` on the toolbar color of the current theme, `ui/theme/apply.ts`), icons 192/512 plus a
  maskable one, `file_handlers` for `.agproj` (`application/x-agstudio-project`), `.agchain`, `.agpreset` and `.agrack`, and
  `launch_handler: focus-existing` (a file opened while the app runs goes to that window, no second one and no reload).
  Window controls overlay (`Shell.module.css`, only under `@media (display-mode: window-controls-overlay)`): the toolbar keeps
  clear of the controls (`env(titlebar-area-*)`) and its empty parts drag the window; everything with a button, role, tabindex or
  `data-hint` is `no-drag`. Not checked in a real overlay window (headless Chrome has none).
- **Icons** (`public/icons`): one design (obsidian tile, gold bars, the favicon's silhouette) written as an SVG and rasterized by
  `scripts/make-icons.mjs` with only Node built-ins (shape renderer with 4x4 supersampling, PNG encoder on `node:zlib`); the
  generated files are committed.
- **Build** (`tools/pwa/precache.ts`, a Vite plugin, build only): in `closeBundle` it lists every file in `dist/` (not `sw.js`,
  maps, dotfiles), derives a build id (SHA-256 over names and contents: any change makes a new id), and bundles `src/sw/sw.ts` into
  `dist/sw.js` (a nested `vite build`, IIFE) with `__AG_PRECACHE__` (the list) and `__AG_BUILD_ID__` defined. A new build is therefore
  a byte-different worker, and its cache is named `agstudio-shell-<id>`.
- **Worker** (`src/sw/sw.ts`, typed by `tsconfig.sw.json` with the WebWorker lib; the decisions are in `src/sw/routing.ts`, pure and
  unit tested). *install*: fetch every listed file (`cache: 'reload'`) into the new cache, all or nothing; no `skipWaiting`.
  *activate*: delete every other `agstudio-shell-*` cache, claim the clients. *fetch*, by `routeRequest`: only same-origin GETs;
  `/api/*`, `/mcp`, `/__*` and Vite's dev paths are never touched (the browser's own network path, so nothing of the server is cached
  and a POST never reaches the worker's logic); a navigation is **network first** with the cached `/index.html` as the fallback (a
  4 s limit when a cached copy exists, so a hung server does not hold the window); a precached file or anything under `/assets/` is
  **cache first** (a lazy chunk of a newer build that the list missed is kept when first fetched). The network never refreshes the
  cached `index.html`: it always matches the cached assets of its own version. **Isolation**: every response the worker serves is
  rebuilt with `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp` and
  `Cross-Origin-Resource-Policy: same-origin` (also worker and worklet scripts, which need the COEP header themselves), so the
  offline app stays `crossOriginIsolated`.
- **Page side** (`src/app/pwa/pwa.ts`, `services.pwa`): `start()` registers `/sw.js` (`scope: '/'`, `updateViaCache: 'none'`) in
  production builds only, after the first paint. **Development never registers it**; instead it unregisters a worker (and the
  `agstudio-*` caches) that an earlier production build left on the same address, so HMR and the dev workflow see the real files.
  A new version that finishes installing under a running one, or one already waiting from an earlier visit, sets `updateReady`; the
  page checks for a new version hourly and when the window becomes visible. **Updates never reload by themselves**: the "Update
  ready" prompt (`ui/features/install-app`, and Help → "Update ready — reload") has Reload (disabled while a song plays) and Later;
  Reload posts `agstudio:skip-waiting`, and the reload happens on the new worker's `controllerchange`, only after that click.
- **Install UX** (`ui/features/install-app`): command `app.install` ("Install AGstudio as an app", Help menu and the action search
  through a dynamic menu entry, the welcome screen), hidden when the display mode says it is already an app. `index.html` keeps
  Chrome's `beforeinstallprompt` (it fires once, maybe before the app's code runs) for the entry to open; without one the dialog
  gives the steps for Chrome's own install icon. Not for the AI studio (`NOT_FOR_AI` in `test/unit/ai-coverage.test.ts`): the prompt
  needs the musician's own click and changes the computer, not the project.
- **Files** (`src/app/pwa/launch.ts`): `launchQueue.setConsumer` receives the handles: the first `.agproj` opens through the normal
  open path (`ProjectFiles.openFile`, with the handle, so Save writes back and "unsaved changes" is asked first); `.agchain`,
  `.agpreset` and `.agrack` files are added to the chains, presets and racks (`importChainText`, `importPresetText`, `importRackText`, the same code as the file pickers);
  anything else says what it cannot open.
- **What needs a server** (`src/app/local-server.ts` has the words; each feature says them instead of failing obscurely). Offline,
  with no server: the whole editor, the engine, projects (File System Access, OPFS, IndexedDB), export, the offline beat generator,
  built-in and (build-time bundled) user plugins. `agstudio --app` (production server): additionally `/api/ai` (the AI studio's
  backends: Claude subscription, Codex, API key). Only `agstudio` (dev server): MCP for AI apps (`/mcp`, tokens), the plugin builder
  and "New plugin…", sharing, installing and managing plugins (`/api/plugins`), "Edit code" (`/__open-in-editor`), hot reload of code and of `plugins/`. User plugins are part of the
  production build (`import.meta.glob` at build time): add or edit one, rebuild (`agstudio --app` does when the code is newer).
- **Tests.** `src/sw/routing.test.ts` (routes, caches, headers), `test/unit/pwa-precache.test.ts` (the list and the build id),
  `test/unit/pwa.test.ts` (installability by hand, since Lighthouse is not installed: manifest fields, icon files and sizes, colors from
  the tokens, file handlers, the page links, the worker's fetch handler and its no-`skipWaiting`), `src/app/pwa/*.test.ts` (install
  prompt, registration, update flow, launched files), `src/app/local-server.test.ts` (messages without a server), and
  `test/unit/pwa-offline.test.ts`: the real production build in a temporary folder, the real `vite preview` on a free port and
  headless Chrome (like `mcp-e2e.test.ts`): the worker registers and controls the page, `crossOriginIsolated`, one versioned cache with
  every file, then with the server **stopped** the page reloads from the cache, still isolated, every file is served, `/api`, POST and
  `/mcp` fail like any request to a stopped server (and are not cached), then a new build waits as "Update ready" with nothing
  reloading until Reload, after which the old cache is gone. It lives in the Node project (not the browser one) because the browser
  tests' pages come from the test runner's dev server, which has no production build or worker.
- **Limits.** Chrome's install and file-handling UI is Chrome's (there is no way to install from a script); the installed app's
  files and settings are the browser profile's (the same IndexedDB and OPFS as the tab on that origin, a different origin than
  `agstudio`'s dev server, so projects kept only in the browser are separate per origin); window controls overlay is untested here.

## Sharing and managing plugins (`core/plugin-bundle`, `tools/plugins`, `app/plugins`, `ui/features/plugin-manager`)

The owner's own instruments and effects are code in `plugins/<folder>/`. This part makes them easy to share, install and keep
tidy. Everything that touches the `plugins/` folder goes through the dev server (`agstudio`); the installed app has no
server behind `/api/plugins`, says so in plain words (`devServerMissing`) and can still show what a bundle is.

### The `.agplugin` bundle (`core/plugin-bundle`, pure, no DOM, unit tested)
- **Layout** (`bundle.ts`): a zip with `agplugin.json` (the manifest), `files/<name>` (the flat source files) and optional
  `presets.json`. Writing is deterministic (fixed timestamps), so exporting twice gives the same bytes.
- **Manifest** (`manifest.ts`): `format: "agstudio-plugin"`, `formatVersion`, `id` (`user.<name>`), `name`, `version` (the
  plugin's own `version`, a whole number), `kind` (`instrument`, `effect`, `note-script`), `author`, `description`, `sdk` (a
  version range), `files` (path, SHA-256, bytes), `presets` (count and SHA-256 of `presets.json`) and `createdWith`.
- **SDK version** (`sdk-range.ts`): `PLUGIN_SDK_VERSION` is 1.0.0 (its major goes up only for a change that breaks existing
  plugins). The range language is `^1.0.0`, `~1.2.0`, `>=1.0.0 <2.0.0`, `1.x`, an exact version or `*`.
- **Reading** (`readBundle`) refuses the whole bundle when anything is wrong: not a zip, over 1 MB, an entry that is not
  `agplugin.json`, `presets.json` or `files/<flat name>` (nested folders, `..`), a file or the total over the limits, a bad
  manifest, a newer format, an SDK range that does not contain this SDK, a file missing from or not listed in the manifest, a
  hash or size that does not match, then the rules below, then "the code never spells the manifest's id" and bad presets.
  Sizes are read from the zip directory before anything is unpacked.
- **The rules** (`rules.ts`) are the plugin builder's, moved here so the dev server, the builder and the importer share one
  copy: flat names ending in `.ts`, `.tsx`, `.dsp`, `.md` (at most 8 files, 64 KB each, 256 KB in all, an `index.ts`), imports
  only from `@agstudio/sdk*`, `react` and the plugin's own files (audio-thread files: the worklet SDK only), and no network,
  storage, eval, dynamic import or opening pages (the scan ignores strings and comments). `tools/ai/drafts.ts` re-exports
  `checkFiles`/`scanSource`. They stop mistakes and obvious misuse; they are **not a sandbox** (a user plugin is trusted code in the
  page), and `capabilities.ts` says exactly that in the install dialog together with what the files show the plugin can do.
- `replaceQuoted`/`withPluginId` rewrite a quoted id or name in code (copies, duplicates, renames); an id the code never spells whole is
  refused, so nothing is renamed halfway.

### The dev server (`tools/ai/drafts.ts`, `tools/plugins/*`)
Same-origin POSTs with the `x-agstudio` header only. `pluginHandlers(paths, { typeCheck, openFolder })` builds the endpoints on a
`PluginPaths` (`plugins/`, `_drafts`, `_backup`, `_trash`, `_disabled`; tests pass a temporary folder and a stand-in type check):
`draft` (checks and writes `plugins/_drafts/<name>`, runs `tsc`), `install` (moves it into `plugins/`; an existing folder goes to
`_backup`, or with `keepExisting` the install is refused with 409), `discard`, `new`, `list` (folders by place, with the id their code
declares), `files`, `check`, `trash`, `restore`, `disable`, `enable` and `open-folder`. Folder names from requests are checked so they
can never leave the plugin folders (`safeFolderName`). Nothing deletes for good: delete moves to `_trash/<folder>-<time>`, disable to
`_disabled/<folder>`, both ignored by discovery because they start with `_`.

### The app (`app/plugins`, `services.userPlugins`)
- `UserPlugins` (`user-plugins.ts`) is the list: the registry's loaded plugins and load errors plus the server's folder listing, the
  state (`loaded`, `error`, `disabled`), where the open project uses each (`core/query/plugin-usage.ts`), the last "Check code" result, and
  the actions disable, enable, trash, restore, check, open folder. Author and origin are kept in IndexedDB (`meta.ts`).
- `bundle-export.ts` reads the files from the server, packs them with your presets for the plugin and reads the result back with the
  importer's checks, so what comes out always imports. `bundle-install.ts` is `inspectBundle` (checks, collision with a plugin of the same
  id: identical, or different with its version relation, presets that are new, no server) and `installBundle` with three modes: `new`
  (refuses when the id exists), `replace` (the old folder goes to `_backup`; a switched-off one is switched on first; projects keep their
  settings and `migrate` upgrades them) and `copy` (a free id like `user.x-2`, the code's id and name rewritten). The server checks the files
  again, so a page that skips the importer is still refused.
- `plugin-edit.ts`: `duplicatePlugin` and `renamePlugin`. A rename copies the code to the new folder (id rewritten), waits until it loads,
  then in one `history.transact` points channels, effect slots and mixer snapshots at the new id (`core/ops/plugin-rename.ts`), moves the
  user's presets and chain steps (`PresetLibrary.renamePlugin`) and only then trashes the old folder, so nothing the song plays is ever
  without its plugin. Undo restores the document exactly; the old folder is in `_trash`.
- `gallery.ts`: the example plugins live in `templates/gallery/<name>/` (type checked and linted like the templates; the folder
  name is the id) with a `gallery.json`; they are packed into bundles on demand and installed through the same dialog as any bundle.
- `project-plugins.ts` and `ProjectFiles`: opening a project that uses `user.*` plugins that are not installed calls `FileUi.pluginsMissing`
  (the UI says which, where they are used, and offers the bundles the file carries or a bundle file). Save As asks
  (`FileUi.chooseEmbeddedPlugins`, off by default, only when the project uses loaded user plugins and the dev server answers) and the
  `.agproj` then holds `plugins/<id>.agplugin` entries (`core/io/project-file.ts`: at most 32, 1 MB each, older versions skip them). Save keeps
  what the open file carried.

### UI, AI and MCP
- The "My plugins" window (`view.pluginManager`, `Alt+Shift+U`): your plugins with name, kind, version, author, id, where the song uses
  them and any load or check error; Edit code, Share…, and a ⋯ menu (duplicate, change id, update from a newer bundle, check, open folder,
  switch off, delete); the gallery; the trash; the built-ins (read only). "Share…" is also in the plugin window's header, the browser's
  right-click menu and the plugin builder's result card (it packs the draft's files in memory, no server). A `.agplugin` file dropped
  anywhere on AGstudio and Add → Import a plugin… both open the install dialog (`flows.ts`, texts in `describe.ts`).
- **Nothing installs without the dialog being answered**, whoever started it. Commands: `plugins.import` (a gallery name, or a file
  chooser: `gesture: true`), `plugins.share`, `plugins.duplicate`, `plugins.changeId`, `plugins.disable`, `plugins.enable`,
  `plugins.delete`, `plugins.restore`, `plugins.check`, `plugins.openFolder`, all with an `argsHint` so Studio and MCP clients drive
  them; the read tool `get_user_plugins` lists them (state, errors, where used, trash, gallery ids; over MCP it reads the folder first).
- The installed app (PWA) does not register `.agplugin` as a file type: installing needs `agstudio`, so there is nothing for it to open
  the file with.

### Tests
`core/plugin-bundle/bundle.test.ts` (round trip, every refusal case, ranges, id rewriting), `core/io/project-file-plugins.test.ts`,
`core/ops/plugin-rename.test.ts`, `test/unit/plugin-server.test.ts` (the real handlers on a temporary folder and over HTTP, guards),
`app/plugins/user-plugins.test.ts` and `project-plugins.test.ts` (export → import into a second folder gives identical files and presets,
collisions, rename with exact undo, trash and restore, the missing-plugin flow), `test/unit/plugin-gallery*.test.ts` (kernels in Node, Faust
compiles, real `tsc` on three gallery plugins) and `test/browser/plugin-manager-ui.test.ts` (the window, the dialogs, with an in-memory
server). No test touches the repository's own `plugins/` folder.

### Limits
The checks are text scans plus the compiler, not isolation. A bundle holds one plugin (no dependencies between plugins). Open folder uses
the system's `open`/`explorer`/`xdg-open` (not tried here on Windows or Linux). The trash is emptied by hand.
