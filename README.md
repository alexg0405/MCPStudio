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

- **Channel rack** with step sequencer, mini piano-roll previews, volume/pan, mute/solo, insert routing.
- **Piano roll**: draw, paint, select, slice, delete tools; snap (incl. triplets); velocity lane; ghost notes;
  copy/paste/duplicate; quantize; typing-keyboard and MIDI keyboard input.
- **Playlist**: pattern and audio clips, move/resize/slice, loop region and song position on the ruler, PAT/SONG
  modes, track mute/solo, clip menus (make unique, colors) and track menus.
- **Mixer**: master + 16 inserts with dB faders, pan, mute/solo and meters; 10 effect slots per insert with
  bypass and dry/wet.
- **Built-in sounds**: Sampler, 3xOsc, Pluck (worklet Karplus-Strong), a procedurally generated drum kit;
  EQ, Filter, Delay, Reverb, Compressor, Distortion.
- **Samples**: add folders from your disk to the browser, preview, drag onto the rack or playlist (or drop files
  from Finder). Samples are embedded in saved projects.
- **Files**: `.agproj` save/open (File System Access, so Cmd+S overwrites), recent files, reload restore, autosave
  with crash recovery, WAV export (16-bit dithered, 24-bit, 32-bit float).

Shortcuts: press F1 in the app, or see [docs/shortcuts.md](docs/shortcuts.md). On a Mac, F-keys may need Fn;
every window also has an Alt+number shortcut and a toolbar button.

## Write your own instrument or effect

```bash
export PATH="$HOME/.local/node/bin:$PATH"; npm run new:plugin -- --kind instrument --style graph --id user.my-synth
```

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
- Not yet: automation clips, audio recording, sends/sidechain, tempo changes, MIDI file import/export.
- Chrome's ConvolverNode (the Reverb) differs by about one float ULP between renders, so exports of projects with
  reverb aren't byte-identical (they are otherwise).
