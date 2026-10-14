# Writing AGstudio plugins

AGstudio's instruments and effects are plugins: TypeScript modules written against `@agstudio/sdk`.
The built-ins (Sampler, 3xOsc, Pluck and the mixer effects) use exactly the same API you do,
so anything they can do, your plugins can do.

## Quick start

```bash
npm run new:plugin -- --kind instrument --style graph --id user.my-synth
```

That creates `plugins/my-synth/`. With `npm run dev` running it appears in the browser panel
(Plugins → click to add a channel). Edit it and save: it hot-reloads and keeps its knob settings.

- `--kind instrument|effect`. Effects go in mixer insert slots (see [Effects](#effects)).
- `--style graph` builds the sound from native Web Audio nodes (oscillators, filters, gains). This is
  the easiest style, it's cheap on CPU, and every built-in except Pluck uses it.
- `--style worklet` writes your own per-sample DSP in an AudioWorklet kernel (Karplus-Strong,
  custom filters, granular, anything). See `src/plugins/builtin/pluck` for a full example.

Plugins live in `plugins/<folder>/index.ts` (or `.tsx`). Folders starting with `_` are ignored, so
rename a folder to `_my-synth` to disable it. A plugin that fails to load shows up in red in the
browser panel with the error; the rest of the app keeps working.

Plugins are trusted code: they run in the app's JavaScript context, just like the built-ins.

## Anatomy of a plugin (graph style)

```ts
import { dbToGain, defineInstrument, GraphVoices, mtof, p } from '@agstudio/sdk';

export default defineInstrument({
  id: 'user.sub-bass',          // never change once projects use it
  name: 'Sub Bass',
  version: 1,                   // bump on breaking param/state changes (see migrate)
  category: 'Synths',
  params: {
    wave: p.enum(['sine', 'triangle'], 'sine'),
    release: p.float(0.005, 2, 0.15, { scale: 'log', unit: 's' }),
    level: p.float(-60, 6, -6, { scale: 'db', unit: 'dB' }),
  },
  create({ audioContext: ac, params }) {
    const out = new GainNode(ac);
    params.level.bind(out.gain, dbToGain);           // the knob drives the AudioParam, smoothed
    const voices = new GraphVoices(ac, out, { max: 8 });
    return {
      output: out,
      noteOn({ time, key, velocity, noteId }) {
        const t = Math.max(time, ac.currentTime);
        const osc = new OscillatorNode(ac, { type: params.wave.value, frequency: mtof(key) });
        const vca = new GainNode(ac, { gain: 0 });
        osc.connect(vca);
        vca.gain.setValueAtTime(0, t);
        vca.gain.linearRampToValueAtTime(velocity, t + 0.004);
        osc.start(t);
        voices.add(noteId, {
          start: t, sources: [osc], out: vca,
          release: (rt) => {
            vca.gain.cancelAndHoldAtTime(rt);
            vca.gain.setTargetAtTime(0, rt, params.release.value / 5);
            return rt + params.release.value;
          },
        });
      },
      noteOff: ({ noteId, time }) => voices.release(noteId, time),
      allNotesOff: (time, hard) => voices.releaseAll(time, hard),
      dispose: () => { voices.disposeAll(); out.disconnect(); },
    };
  },
});
```

### Params

Declare them with `p.float(min, max, default, opts)`, `p.int`, `p.enum(options, default)` and `p.bool`.
Options: `label`, `unit` (`'Hz' | 'dB' | 'ms' | 's' | '%' | 'st' | 'ct' | 'x' | 'beats'`), `scale`
(`'linear' | 'log' | 'db'`, which controls how knob travel maps to values), `group` (a section in the
generated editor), `hint` (hint bar text) and `smoothing` (seconds).

The **host owns the values**. They live in the project, so undo, presets, saving and hot reload
come for free. Your plugin only reads them:

| API | Use |
|---|---|
| `params.x.valueAt(time)` | the value at an AudioContext time, **automation included**: read once-per-note settings (envelope times, wave shapes) with `valueAt(e.time)` in `noteOn` |
| `params.x.value` | the document value right now (what the knob shows when nothing automates it) |
| `params.x.bind(audioParam, map?)` | drive an AudioParam, smoothed (no zipper noise) |
| `params.x.signal(map?)` | one shared smoothed source; `.connect(audioParam)` it to every voice so sounding notes follow the knob. Set the target's own value to 0. `.node` lets you route it through your own nodes |
| `params.x.onChange((v, time) => …)` | anything else (switching modes, rebuilding curves) |

Unit `%` means the value is 0–1 and displayed as a percentage.

Floats and ints can be automated (automation clips, MIDI controller links) unless you pass
`automatable: false`, which you should for params whose change is expensive (rebuilding an impulse
response, a wavetable). Enums and bools are not automatable unless you pass `automatable: true`.
Never schedule your own events on an AudioParam you `bind()`: the host is its only writer (it
models what it scheduled to cut and rewind automation without jumps). For your own per-voice
curves, `ParamLane` (exported by the SDK) gives the same rewindable scheduling.

### Notes and timing

`noteOn` and `noteOff` arrive **ahead of time** (the engine schedules ~120 ms ahead). Always
schedule at `e.time` and never "now". `NoteOn.fine` is the note's fine pitch in cents (add it to the
voice's detune) and `NoteOff.release` its release velocity (0–1). A note-off whose time is at or before its note-on means the
note was cancelled (for example, the user deleted it before it played). `GraphVoices.release()`
handles that for you. `GraphVoices` also limits polyphony, steals voices without clicks and cleans
up finished voices.

`allNotesOff(time, hard)` happens on stop (release) and on panic or plugin swap (`hard`: silence quickly).
An instrument may also implement `controlChange(cc, value, time)` (MIDI mod wheel and other
controllers, value 0–1).

### The host

`create(host)` receives:

| Member | |
|---|---|
| `audioContext` | realtime **or offline** (export): never create your own context |
| `params` | the handles above |
| `state` / `updateState(next)` | small JSON state for non-param data; `updateState` becomes an undoable edit and comes back through `setState()` |
| `samples` | named sample slots: `get(slot)`, `load(slot)`, `onChange(slot, cb)`, `name(slot)`. Declare `sampleSlots: ['main']` and the editor shows a sample picker |
| `channel.rootKey` | the channel's root note (steps play at it; samplers play original pitch there) |
| `channel.pitch` | the channel's pitch in cents (pitch knob, automation, MIDI pitch bend) as a signal: `channel.pitch.connect(voice.detune)` for every voice. `channel.pitchAt(time)` gives its value |
| `transport.tempoAt(time)`, `transport.onTempo((bpm, time) => …)` | for tempo-synced effects (the tempo can change during the song); `transport.bpm` is the tempo now |
| `sidechain` | effects declared with `sidechain: true`: the mixer track chosen as the slot's sidechain source, or the effect's own input when none is chosen (see [Sidechain effects](#sidechain-effects)). Worklet effects receive it as the fifth argument of `process()` |
| `offline` | true while exporting |
| `signal` | an AbortSignal aborted on dispose |
| `worklet(opts)` | create your processor node (see below) |

## Worklet plugins (custom DSP)

Three files:

```
plugins/my-synth/
  params.ts        // shared: params + id (imported by both threads)
  index.ts         // main thread: defineWorkletInstrument({ ..., processor })
  dsp.worklet.ts   // audio thread: kernel class + registerKernel(ID, params, Kernel)
```

```ts
// index.ts
import { defineWorkletInstrument } from '@agstudio/sdk';
import processor from './dsp.worklet.ts?worker&url';   // exactly this import form
import { ID, params } from './params';
export default defineWorkletInstrument({ id: ID, name: 'My Synth', version: 1, params, processor });
```

```ts
// dsp.worklet.ts
import { InstrumentKernel, registerKernel, VoicePool, at, type ParamBlock } from '@agstudio/sdk/worklet';
import { ID, params } from './params';

class MySynth extends InstrumentKernel<typeof params> {
  noteOn(key: number, velocity: number, noteId: number, pan: number, fine: number) { /* start a voice */ }
  noteOff(noteId: number, key: number, release: number) { /* release it */ }
  render(out: Float32Array[], from: number, to: number, p: ParamBlock<typeof params>) {
    // ADD into out[0]/out[1] for frames [from, to). at(p.level, i) reads a param at frame i.
  }
}
registerKernel(ID, params, MySynth);
```

The SDK owns the actual `AudioWorkletProcessor`. It splits each block at note events, so
`render(from, to)` runs between events and notes start on their exact sample. It also:
- catches exceptions: a faulted instrument goes silent and a faulted effect is bypassed, and you get a toast;
- silences NaN/Infinity output and calls your `reset()`;
- handles block sizes other than 128.

Effects extend `EffectKernel` and implement `process(input, output, n, params, sidechain?)` (the
sidechain arrives for effects defined with `sidechain: true`). In param blocks, enums arrive as the
option index and booleans as 0/1.

`@agstudio/sdk/worklet` also has DSP building blocks (allocation-free, and plain classes, so they
work on the main thread and in Node tests too): `Biquad` (RBJ cookbook), `Svf` (state-variable filter
that stays stable while you sweep it every sample: low/high/band-pass, notch, peak, all-pass, bell,
shelves), `OnePole` (6 dB/oct filter or smoother, by cutoff or time constant), `EnvelopeFollower`
(peak or RMS level with attack/release), `Adsr` (envelope; retriggers from its current value),
`BlepOscillator` (sine, saw, square, pulse and triangle with little aliasing; `polyBlep` for your
own), `DelayLine` (fractional reads, linear or cubic), `Lfo` (seven shapes, free-running or locked to
the song with `atBeat`), `Rng`, `mtof`, `dbToGain`, `flush`.

Every kernel can see the song: `this.transport.playing`, `this.transport.bpm` and
`this.transport.beatAt(i)` (the song position in quarter-note beats at frame `i` of the block; it
holds while stopped). The SDK updates it at the exact frame the song starts, stops, jumps, loops or
changes tempo, and calls the optional `transportChanged()` hook then. A tempo-synced LFO is
`lfo.atBeat(this.transport.beatAt(i), 1 / 4)` for sixteenths; a synced delay reads
`60 / this.transport.bpm` seconds per beat. Offline exports see the same values, so they repeat exactly.

Instrument kernels read the channel pitch in cents from `this.pitch` (a param block: `at(this.pitch, i)`),
and `fine` is the note's own fine pitch.

Optional kernel hooks: `setState(state)`, `onMessage(msg)` (from `port.send`), `onSample(slot, channels, sampleRate)`
(sample slots are copied to the audio thread for you), `reset()`, `allNotesOff(hard)`, `controlChange(cc, value)`.
Use `this.host.rand()` for randomness (seeded, so exports repeat exactly) and `this.host.post(msg)`
to talk back to the main thread (rarely: at most ~30 times a second).

### Rules for audio-thread code

- No DOM, `fetch`, timers, dynamic `import()`, `import.meta.hot` or npm packages. `@agstudio/sdk/worklet`
  and your own files are fine.
- Don't allocate inside `render()`/`process()`. Create arrays and voices in the constructor, use index
  loops, and keep voice objects monomorphic (initialize every field in the class body).
- Flush tiny feedback values (`flush(x)` from the SDK) so silence never turns into denormals.
- Keep pure DSP in a separate `kernel.ts` (or `*.kernel.ts`) if you want to unit-test it in Node,
  like `src/plugins/builtin/pluck/kernel.ts`. Don't put React components in kernel or params files.

## Faust plugins

Write the DSP in [Faust](https://faustdoc.grame.fr) and let AGstudio do the rest. Two files:

```
plugins/my-filter/
  index.ts       // defineFaustEffect({ ..., dsp }) or defineFaustInstrument({ ..., dsp })
  effect.dsp     // the Faust code
```

```ts
// index.ts
import { defineFaustEffect } from '@agstudio/sdk/faust';
import dsp from './effect.dsp';
export default defineFaustEffect({ id: 'user.my-filter', name: 'My Filter', version: 1, dsp });
```

`npm run new:plugin -- --kind effect --style faust --id user.my-filter` scaffolds this (`--kind instrument`
for a synth voice). The dev server compiles the `.dsp` to WebAssembly when the plugin loads, and every edit
recompiles and hot-reloads. A compile error shows as a broken plugin with the Faust message and its line.

How Faust controls become knobs:
- Each `hslider`, `vslider` and `nentry` is a knob, and each `checkbox` and `button` is a switch. The knob takes
  its label, range, default and step from the control.
- `[1]`, `[2]`… in a label set the order of the knobs; Faust sorts them by label otherwise.
- `[unit:Hz]` (also dB, ms, s, st, ct), `[scale:log]` and `[tooltip:…]` give the knob a unit, a log scale and a
  hint.
- Controls inside `hgroup`/`vgroup` boxes are grouped under the box's label.
- A number entry, or a slider with whole-number steps over a short range, makes a whole-number knob.
- Param ids are the label in camelCase ("Filter Q" → `filterQ`). Presets and automation use them.

Effects: a DSP with one input hears both sides mixed, and one with two gets left and right. One output feeds both
sides.

Instruments: a DSP with a `gate` control is a voice.
- Notes set its `freq` (Hz, with the channel's pitch and the note's fine tune), `gain` (velocity 0–1) and `gate`;
  `key` and `vel` work too.
- AGstudio runs 8 voices and steals the oldest one when they are all busy. A released voice is freed once it falls
  silent.
- A mono voice is panned per note.

It all runs in the same audio-thread kernel as other plugins: notes land on their exact sample, knobs are
automatable, and exports are bit-exact. The standard Faust libraries (`import("stdfaust.lib");`) are available. Not
yet supported: your own `.lib` files, `soundfile`, and sidechain inputs.

## Effects

An effect is `defineEffect({ ..., create(host) })` (native nodes) or `defineWorkletEffect({ ..., processor })`
(an `EffectKernel`). `create` returns `{ input, output, dispose, latency?, tailTime?, reset?, setState? }`.

```ts
import { dbToGain, defineEffect, p } from '@agstudio/sdk';

export default defineEffect({
  id: 'user.warm-filter',
  name: 'Warm Filter',
  version: 1,
  category: 'Filters',
  params: {
    cutoff: p.float(40, 18000, 2000, { label: 'Cutoff', unit: 'Hz', scale: 'log' }),
    output: p.float(-24, 12, 0, { label: 'Output', unit: 'dB', scale: 'db' }),
  },
  create({ audioContext: ac, params }) {
    const filter = new BiquadFilterNode(ac, { type: 'lowpass' });
    const gain = new GainNode(ac);
    filter.connect(gain);
    params.cutoff.bind(filter.frequency);
    params.output.bind(gain.gain, dbToGain);
    return { input: filter, output: gain, dispose: () => { filter.disconnect(); gain.disconnect(); } };
  },
});
```

**Where effects appear.** In the browser panel (marked `fx`) and in the mixer (F9): the master and every insert have
ten effect slots. Click an empty slot to pick an effect (or click an effect in the browser to add it to the insert
selected in the mixer), double-click a slot to open its editor, right-click it to replace, move or remove it. Slots run
top to bottom, then the insert's mute/solo, pan and fader, then its sends to other tracks.

**Input and output.** The insert's audio arrives at your `input` node: stereo, with every channel and every track routed to the insert
already summed and the previous slots applied. Send your result (stereo) out of `output`; never connect to
`audioContext.destination`. With `defineWorkletEffect` the kernel's `process(input, output, n, params)` gets two
input channels (zeros when nothing plays) and must fill both outputs.

**Bypass and dry/wet belong to the host.** Each slot has an on/off LED and a mix knob (linear dry/wet). Bypassing
crossfades to the dry signal in about 10 ms and then disconnects your input to save CPU; the instance stays alive. A
missing or failing effect passes audio through and keeps its settings. Your own `mix` param is still useful when the
blend belongs inside the effect (an equal-power reverb mix, parallel distortion).

**Latency.** If your effect delays the signal (a look-ahead, oversampling filters), set `latency` in seconds (it is
rounded to whole frames): the host delays the slot's dry path by the same amount so the slot mix stays in phase, and
the mixer compensates it across tracks (delay compensation: every other path, sends and sidechains included, is held
back by the same amount, and the playhead follows). The value is read once, when `create()` resolves; it only counts
while the slot is on. Measured in Chrome: DynamicsCompressorNode delays by `floor(0.006 · sampleRate)` frames and adds
its own makeup gain; WaveShaperNode oversampling adds 128 (`'2x'`) or 192 (`'4x'`) frames; every trip around a feedback
loop through a DelayNode takes one render quantum (128 frames) longer than its `delayTime`; a DelayNode set to
`n / sampleRate` delays by exactly n frames. The built-in Distortion and Delay (`src/plugins/builtin/`) show how to
compensate.

**Tails.** `tailTime` (seconds, can be a getter) is how long the effect keeps sounding after its input stops (reverb,
delay feedback); exports add it to the render length. `reset()` clears internal buffers.

**Tempo and export.** `host.transport.bpm` and `host.transport.onTempo(cb)` (it returns an unsubscribe: call it in
`dispose`) drive tempo-synced effects. Exports run the same code in an OfflineAudioContext (`host.offline` is true and
the whole project is applied before rendering starts), so don't rely on timers for correctness: debounce expensive work
while playing, but do it right away when `host.offline`. Use seeded randomness (`Rng` from `@agstudio/sdk/dsp/random`,
or `this.host.rand()` in kernels) so two exports are identical.

`plugins/example-bitcrusher` is a complete worklet effect (bits, downsample, mix), and
`npm run new:plugin -- --kind effect --style graph|worklet --id user.my-effect` scaffolds a new one.

### Sidechain effects

Declare `sidechain: true` and the effect gets a second input: the audio of another mixer track that the user
chooses (the slot's right-click menu, "Sidechain from ▸", or "Sidechain to this track" on that track's strip). Use it
to duck a bass under the kick, gate a pad with a hi-hat, or key a compressor.

- What arrives: the chosen track after its own effects, before its mute/solo, pan and fader (a muted or solo-silenced
  kick still keys). Delay compensation lines it up with your input.
- With no source chosen, the host feeds your **own input** there, so a sidechain compressor or gate just works on its
  own. Changing the source only rewires; your instance is never recreated for it.
- Graph effects: connect `host.sidechain` (an AudioNode) to whatever detects the level. Worklet effects: the kernel's
  fifth `process()` argument has as many channels as the output (zeros while the source plays nothing).
- Choices that would make audio loop back are refused by the mixer.

```ts
// dsp.worklet.ts: a ducker in a few lines (see src/plugins/builtin/ducker for a full one)
import { at, EffectKernel, EnvelopeFollower, registerKernel, type ParamBlock } from '@agstudio/sdk/worklet';
import { ID, params } from './params'; // params = { depth: p.float(0, 1, 0.8, { unit: '%' }) }

class Duck extends EffectKernel<typeof params> {
  private readonly env = new EnvelopeFollower(this.sampleRate, 1, 120);
  process(input: Float32Array[], output: Float32Array[], n: number, p: ParamBlock<typeof params>, key?: Float32Array[]) {
    for (let i = 0; i < n; i++) {
      const level = this.env.process(key ? (key[0] as Float32Array)[i] as number : 0);
      const g = 1 - at(p.depth, i) * Math.min(1, level * 4);
      for (let c = 0; c < output.length; c++) (output[c] as Float32Array)[i] = ((input[c] as Float32Array)[i] as number) * g;
    }
  }
}
registerKernel(ID, params, Duck);

// index.ts
export default defineWorkletEffect({ id: ID, name: 'Duck', version: 1, params, processor, sidechain: true });
```

The built-in Compressor (with a sidechain high-pass and "Listen to sidechain"), Ducker and Gate are complete examples.

## Hot reload

| You edit | What happens |
|---|---|
| `index.ts`, or a custom UI | the plugin's instances are rebuilt in place (~10 ms); settings are kept |
| `dsp.worklet.ts`, or files only it imports | audio restarts with a fresh AudioContext (~0.2 s gap); settings are kept |
| `params.ts` (shared by both threads) | the page reloads; your project is restored automatically (click once to re-enable audio) |
| add or delete a plugin folder | it appears in or disappears from the browser; channels using a deleted plugin keep their settings and show "missing" |

## Custom editors

Without `ui`, the host generates a knob panel from your params (grouped by `group`). To draw your
own, pass a React component:

```tsx
import { Knob } from '@agstudio/sdk/ui';
function MyUI({ specs, values, beginEdit, setParam, endEdit }: PluginUIProps<typeof params>) {
  return <Knob spec={specs.cutoff} value={values.cutoff}
    onBegin={() => beginEdit('cutoff')} onChange={(v) => setParam('cutoff', v)} onEnd={() => endEdit('cutoff')} />;
}
export default defineInstrument({ ..., ui: MyUI });
```

`beginEdit` → `setParam`… → `endEdit` makes one undo step. Give SDK controls the param id
(`<Knob param="cutoff" …/>`) and right-clicking them opens the host's param menu (create an
automation clip, link a MIDI controller, reset); `openParamMenu(param, event)` does the same for your
own elements. Knobs with a `param` also follow automation while playing and mark themselves when an
automation clip drives them (a blue dot, explained in the hint bar); for your own controls,
`useParamStatus(param)` from `@agstudio/sdk/ui` returns that status (`{ kind, hint }` or null). A UI that throws shows an error card
with the generated panel underneath. `plugins/example-supersaw` is a complete example. `Knob` also takes
`format(value)` to show your own text in the hint bar (it defaults to the param's unit formatting).

## Note scripts

Piano-roll tools are plugins too. Every built-in tool (Quantize, Strum, Arpeggiate, Make chords…,
`src/plugins/builtin/note-tools`) is a note script, so yours sit right next to them.

```bash
npm run new:plugin -- --kind note-script --id user.my-tool
```

That creates `plugins/my-tool/index.ts` (an "Echo" tool to start from). Scripts show up in the piano
roll's **Tools ▾** menu (grouped by `category`), in its right-click menu under **More tools** and in
**Edit > Piano roll tools**; menus are rebuilt each time they open, so saving your file is enough.
Running a script opens a dialog generated from its `params` (the `description` is its first line, so
write it as one plain sentence) with a **live preview**: the notes change while you turn the knobs,
**Apply** keeps the result as one undo step and **Cancel** puts the notes back. A script without
params runs straight away. A module may export one definition or an array of them.

### The contract

```ts
defineNoteScript({ id, name, version, category?, description?, params, run(ctx) => notes })
```

| `ctx.` | |
|---|---|
| `notes` | the notes to work on: the selected notes, or every note of the channel's pattern when none are selected. Frozen: don't modify them |
| `values` | the dialog's values, typed from `params` |
| `ppq` | ticks per beat (960); a 1/16 step is 240 ticks |
| `grid` | the piano roll's snap in ticks (1 when snapping is off) |
| `bar`, `length` | ticks per bar, and the pattern's length |
| `key` | the song key `{ root, scale }` (root 0 = C, scale ids from `SCALES`), or null |
| `rand()` | seeded random numbers in [0, 1): the same notes give the same result. It is seeded from the script id, the notes and your `seed` param (if you declare one), not from other params, so turning a knob doesn't reshuffle everything; give users a `seed` param to re-roll |

`run` returns the notes that replace `ctx.notes`, each a `ScriptNote`
`{ id?, tick, length, key, velocity (0–1), pan? (−1…1), release? (0–1), fine? (cents), muted? }`:

- a note that keeps the `id` of an input note **edits** that note;
- a note without an `id` (or with one you already used) is **added**;
- input notes you don't return are **deleted**;
- on edited notes, optional fields you leave out keep their value; set `pan: 0`, `fine: 0`,
  `release: 0.5` or `muted: false` to reset them.

The host rounds and clamps what you return (ticks ≥ 0, lengths ≥ 1, keys 0–127). If `run` throws or
returns something malformed, nothing changes and the message is shown as a toast.

### A complete example

```ts
import { defineNoteScript, p } from '@agstudio/sdk';
import { chordGroups, clampNote, quantize } from '@agstudio/sdk/notes';

/** Adds a bass note under every chord: its lowest note, one or two octaves down. */
export default defineNoteScript({
  id: 'user.octave-bass',
  name: 'Add bass notes',
  version: 1,
  category: 'My tools',
  description: 'Adds a bass note under each chord: the chord’s lowest note, an octave or two lower.',
  params: {
    octaves: p.int(1, 2, 1, { label: 'Octaves down' }),
    velocity: p.float(0.1, 1, 0.9, { label: 'Velocity', unit: '%' }),
    tight: p.bool(true, { label: 'Snap the bass to the grid' }),
  },
  run(ctx) {
    const { octaves, velocity, tight } = ctx.values;
    const bass = chordGroups(ctx.notes, 20).map((chord) => {
      const low = chord[0]!; // chordGroups sorts each chord by key
      return clampNote({ tick: low.tick, length: low.length, key: low.key - 12 * octaves, velocity });
    });
    // Keep every input note (their ids say "unchanged") and add the new ones (no ids).
    return [...ctx.notes, ...(tight ? quantize(bass, { grid: ctx.grid }) : bass)];
  },
});
```

### `@agstudio/sdk/notes`

Music theory and note transforms, pure TypeScript (no DOM), usable from note scripts, plugins and the
host alike. Transforms take `ScriptNote[]`, return new notes and never modify their input; notes that
keep an `id` are edits of the input note with that id.

- **Scales and keys**: `SCALES` (major, minor, harmonic/melodic minor, the modes, pentatonics, blues,
  phrygian dominant, whole tone, diminished, chromatic, …), `getScale(id)`, `scaleMask(root, scale)`,
  `inScale(key, root, scale)`, `scaleNotes(root, scale, low?, high?)`,
  `snapToScale(key, root, scale, 'nearest' | 'up' | 'down')`, scale-step math (`scaleStep`,
  `keyAtStep`, `scaleDegree`, `transposeInScale(key, steps, root, scale)`), `noteName(60)` = "C5"
  (FL's octave numbering), `keyLabel(9, 'minor')` = "A minor", `PITCH_NAMES`.
- **Chords**: `CHORDS` (major, minor, dim, aug, sus2, sus4, 5, 6, m6, 7, maj7, m7, m(maj7), m7b5,
  dim7, aug7, 7sus4, add9, madd9, 6/9, 9, maj9, m9, 11, m11, maj11, 13, maj13, m13),
  `chordNotes(root, id, { inversion, voicing })`, `invert(keys, n)`, `voice(keys, 'close' | 'open' |
  'drop2' | 'drop3' | 'bass' | 'spread')`, `diatonicChord(key, root, scale, size)` (the key's own
  triads, 7ths, 9ths), `diatonicQuality(degree, root, scale)`, `detectChord(keys)` → `{ name: 'Am7', … }`,
  `chordName(root, id)`.
- **Timing**: `quantize(notes, { grid, strength, starts, ends, lengths, swing, window })`,
  `humanize(notes, { rand, timing, velocity, length })`, `legato(notes, { gap, until })`,
  `strum(notes, { time, direction, curve, tolerance, keepEnds, velocity, rand })`,
  `stretch(notes, { factor, anchor })`, `nearestGridLine(tick, grid, swing)`.
- **Editing**: `chop(notes, { grid } | { parts }, gate?)`, `glue(notes, { gap })`,
  `flip(notes, 'time' | 'pitch')`, `limit(notes, { low, high })`.
- **Pitch**: `transpose(notes, semitones)`, `transposeDegrees(notes, steps, key)` (both shrink the
  shift rather than push a note out of range), `snapNotesToScale(notes, key, direction?)`,
  `chordify(notes, { chord, size, inversion, voicing, key })`.
- **Velocity**: `scaleVelocities(notes, { factor, offset })`, `fitVelocities(notes, { min, max })`,
  `rampVelocities(notes, { from, to, curve, multiply })`.
- **Generating**: `arpeggiate(notes, { rate, gate, pattern, octaves, range, rand })` (patterns
  `ARP_PATTERNS`: up, down, up-down, down-up, converge, diverge, as-played, random),
  `randomize(notes, { rand, pitch, velocity, key })`, `generate({ rand, start, end, grid, density,
  low, high, minLength, maxLength, key, polyphony, smoothness })`.
- **Helpers**: `clampNote`, `withoutId` (turn a copy into a new note), `noteEnd`, `byTime`, `span`,
  `chordGroups(notes, tolerance)` (notes starting together), `overlapGroups` (notes that overlap),
  `bend(x, curve)`, `seeded(seed)` (your own seeded random source).

## Presets and versions

`presets: [{ name, params: { … } }]` are your plugin's factory presets: they show in the preset bar at
the top of its window (◀ name ▶) and in the browser's preset search. Params a preset leaves out go
back to their defaults; give a preset `state` to set the plugin's state too (otherwise it keeps it).
Musicians save their own presets next to yours (kept in the browser, or exported as `.agpreset`
files). A user preset stores every param, the state and your plugin's `version`.

When you change params or state incompatibly, bump `version` and add
`migrate({ version, params, state }) => ({ params, state })`. Projects and user presets saved with
older versions are upgraded when they load.

## Testing

- Pure kernels: plain Vitest in Node (`src/plugins/builtin/pluck/kernel.test.ts` checks tuning by
  autocorrelation).
- Whole plugins: browser tests render offline in headless Chrome (`test/browser/worklet.test.ts`).
  `npm run test:audio` runs them; `npm run check` runs everything.
