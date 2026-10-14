# AGstudio

An FL Studio-style DAW that runs in Chrome, built to be extended: your own instruments and effects are
TypeScript plugins you drop into `plugins/`, and they hot-reload while you play.

## Run it

Node 22 lives in `~/.local/node/bin` on this machine (not on PATH):

```bash
export PATH="$HOME/.local/node/bin:$PATH"; npm run dev
```

Then open http://localhost:5390 in Chrome (or Edge). Click anywhere once to enable audio.

Other scripts: `npm run check` (types, lint, all tests), `npm test` (unit), `npm run test:audio` (headless Chrome),
`npm run build` (production build in `dist/`).

## What's in it

- **Help everywhere**: point at anything for a tooltip and the hint bar; a **?** on every window explains it;
  **⌘K / Ctrl+K** finds any action by typing what you want (or hands the words to the AI); a welcome screen,
  a guided tour (Help → Take the tour) and project templates (Trap, Boom bap, House, Lo-fi, Drill).
- **Channel rack**: step sequencer with fill/rotate/shift/reverse/randomize tools and a per-step graph editor
  (velocity, pan, release, pitch), mini piano-roll previews, volume/pan, mute/solo, mixer routing, automation rows.
- **Piano roll**: draw, paint, select, slice, mute and delete tools; snap (incl. triplets); song key with scale
  highlight and snap; chord stamps; velocity, pan, release and fine-pitch lanes; 20 note tools (quantize, humanize,
  strum, arpeggiate, legato, chop, chords, transpose in key, generate…) with live previews; your own note scripts.
- **Playlist**: pattern, audio and automation clips; automation with curve/hold/stairs/smooth points, LFO
  generation and recording; tempo automation; loop region and song position; PAT/SONG modes.
- **Mixer**: master + inserts with dB faders, pan, mute/solo (FL's solo rule) and meters; sends between tracks
  (pre or post fader), sidechains, automatic delay compensation; 10 effect slots per track.
- **Built-in instruments**: Sampler, 3xOsc, 808 Bass, Pluck, Wavetable (two morphing oscillators, unison, a
  6-slot mod matrix), FM (4 operators, 8 algorithms), Drum Pads (16 pads with choke groups; drop your samples on
  them), Slicer (chops a loop across the keys), Drum Synth, and a generated drum kit.
- **Built-in effects**: EQ, EQ Pro (8 bands on a draggable curve over a live spectrum), Filter, Delay, Reverb,
  Compressor (with sidechain), Limiter (true peak), Multiband, Transient Shaper, Saturator, Distortion, Ducker
  (sidechain or tempo pump), Gate, Chorus, Flanger, Phaser, Stereo, Lo-Fi, Stutter, Vocoder, Tune and Analyzer
  (spectrum, LUFS, true peak).
- **Recording and MIDI**: metronome and count-in, note recording from MIDI or the computer keyboard (quantize,
  overdub or replace), an on-screen keyboard, MIDI learn for any knob, MIDI file import and export, hum to notes.
- **Samples**: add folders from your disk to the browser, preview, drag onto the rack or playlist (or drop files
  from Finder). Samples are embedded in saved projects.
- **Files**: `.agproj` save/open (File System Access, so Cmd+S overwrites), recent files, reload restore, autosave
  with crash recovery, WAV export (16-bit dithered, 24-bit, 32-bit float), undo history (⌥H) with click-to-jump,
  and shortcuts you can change (Help → Keyboard shortcuts).
- **Presets**: every plugin window has a preset bar (◀ name ▶): load factory presets, save your own, rename,
  delete, reset, randomize ("vary a little" to "everything"), export and import `.agpreset` files. The browser's
  Presets section lists yours and searches every preset; click one to add it.
- **Settings** (Options → Settings…, F10): which speakers or headphones to play through (with a left/right test
  sound), MIDI devices, the typing piano, recording options and tooltips, in one window.

## AI studio (✦ in the toolbar, or ⌥6)

Ask for anything in your own words, and the AI does it in your project as **one undoable step**: write a beat
("dark trap at 140, 808s that slide"), change the mix ("put the snare on its own track with a plate reverb, duck
the 808 with the kick"), swap or tweak instruments and effects, write melodies and chords, run note tools, draw
automation ("filter sweep over the last 4 bars", "speed up to 150 BPM by the drop"), drop markers, arrange the
playlist, or use the app itself ("save it", "export a WAV", "undo that", "open the mixer"). It can run every
command in the app; file dialogs just ask you for one click.

It can even **write a new plugin**: ask for an instrument or effect nothing in the browser can make, and the AI
codes it on the plugin SDK, AGstudio checks it (TypeScript, safe imports) and test-renders it in a sandbox, sends
any problems back for fixes, then shows you the code with an **Install** button.

### Performing a beat

You can also **perform** part of it: press Record, count in with the click, and beatbox the drums or hum the 808
line or a melody. Pick what your noises stand for ("Noises are…"), or leave it on "Figure it out". The take shows
up on a little grid (kicks, snares, hats, hummed notes); then say what it should become, e.g. "808s like this, dark
trap", and the beat follows your rhythm and contour, in a sensible register and key. "Use a recording…" (or dropping
an audio file on the panel) works with a voice memo you made elsewhere. Turn on "Play my beat along" to perform over
the current pattern (headphones help).

**Who answers** (the picker in the AI studio's header; "Auto" uses the first one that's set up):

1. **Your Claude subscription** (no API key, nothing billed separately; it counts toward your plan's usage like any
   Claude Code use). Install Claude Code and sign in once, in Terminal:

   ```bash
   curl -fsSL https://claude.ai/install.sh | bash
   ```

   ```bash
   ~/.local/bin/claude auth login
   ```

   AGstudio's dev server then runs `claude -p` for each request (isolated with `--safe-mode`, no tools), so the
   page never sees your login. This is for your own use on your machine: don't share the app with others using
   your login.
2. **An API key**: copy `.env.example` to `.env.local` and put your key after `ANTHROPIC_API_KEY=` (from
   https://console.anthropic.com/). The dev server adds it to requests; changes apply without a restart.
3. **The offline generator**: built in, always available, no account needed.

You can pick the Claude model (Opus 5.5 by default; Sonnet and Haiku are faster) in the assistant's header.

Shortcuts: press F1 in the app, or see [docs/shortcuts.md](docs/shortcuts.md). On a Mac, F-keys may need Fn;
every window also has an Alt+number shortcut and a toolbar button.

## Write your own instrument, effect or note tool

```bash
export PATH="$HOME/.local/node/bin:$PATH"; npm run new:plugin -- --kind instrument --style graph --id user.my-synth
```

(`--kind note-script` makes a piano-roll tool. Or ask the AI studio to write the plugin for you.)

It appears in the browser's Plugins list right away; edit `plugins/my-synth/index.ts` and it hot-reloads, keeping
its settings. Use `--style worklet` for per-sample DSP in an AudioWorklet, and `--kind effect` for effects. The guide
is [docs/plugin-sdk.md](docs/plugin-sdk.md); `plugins/example-supersaw` and `plugins/example-bitcrusher` are worked
examples.

## Docs

- [docs/architecture.md](docs/architecture.md): layers, data model, engine, persistence, and what was verified in
  Chrome.
- [docs/plugin-sdk.md](docs/plugin-sdk.md): the plugin API.
- [CLAUDE.md](CLAUDE.md): conventions for working on the code.

## Known limits

- Chrome/Edge only (Web Audio, AudioWorklet, File System Access). No VST/AU hosting.
- Not yet: audio recording into the playlist and audio clip editing (in progress), MP3 export, Faust plugins.
- Chrome's ConvolverNode (the Reverb) differs by about one float ULP between renders, so exports of projects with
  reverb aren't byte-identical (they are otherwise).
