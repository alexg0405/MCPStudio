# AGstudio

An FL Studio-style DAW that runs in Chrome, built to be extended: your own instruments and effects are
TypeScript plugins you drop into `plugins/`, and they hot-reload while you play.

## Run it

One command, from any folder:

```bash
agstudio
```

It starts the dev server on http://localhost:5390 and opens it in your browser (if it is already running, it just
opens it); Ctrl+C stops it. Click anywhere once to enable audio. `bin/agstudio` is the script; link it onto your PATH
once with `ln -sf "$PWD/bin/agstudio" ~/.local/bin/agstudio` (it installs the dependencies on the first run).

By hand: Node 22 lives in `~/.local/node/bin` on this machine (not on PATH):

```bash
export PATH="$HOME/.local/node/bin:$PATH"; npm run dev
```

Other scripts: `npm run check` (types, lint, all tests), `npm test` (unit), `npm run test:audio` (headless Chrome),
`npm run test:perf` (speed assertions with their real limits; run it on a quiet machine),
`npm run build` (production build in `dist/`).

## What's in it

- **Help everywhere**: point at anything for a tooltip and the hint bar; a **?** on every window explains it;
  **⌘K / Ctrl+K** finds any action by typing what you want (or hands the words to the AI); a welcome screen,
  a guided tour (Help → Take the tour) and project templates (Trap, Boom bap, House, Lo-fi, Drill, and the dance pack: Big room, Progressive house,
  Future bass, Dubstep, Melodic dubstep, Tech house, Trance, Drum & bass).
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
  FL's score log: everything you play is kept for 5 minutes, so Patterns → Dump what I played… turns a riff you
  played without recording into a pattern. Tap tempo (Shift+T or Options → Tap tempo).
- **Samples**: add folders from your disk to the browser, preview, drag onto the rack or playlist (or drop files
  from Finder). Samples are embedded in saved projects.
- **DJ auto-mix** (View → DJ mix, ⌥J, or the browser's Music section): add your own songs (MP3, AAC/M4A, WAV,
  FLAC, OGG; streaming services like Spotify can't be mixed, their audio is locked), press **Make the mix** and
  Studio orders them (Camelot keys, tempos, an energy shape: party, build, peak time, chill), beat-matches them
  and builds every transition on the playlist: phrase-aligned 8/16/32-bar blends with a bass swap, filter or
  echo outs, cuts, risers, tempo glides, a marker per song. Tweak one transition, then export the mix. The
  Studio chat does it too ("make a 30-minute party mix", "smoother transition into song 4").
- **Files**: `.agproj` save/open (File System Access, so Cmd+S overwrites), recent files, reload restore, autosave
  with crash recovery, WAV export (16-bit dithered, 24-bit, 32-bit float), undo history (⌥H) with click-to-jump,
  and shortcuts you can change (Help → Keyboard shortcuts).
- **FL Studio import** (File → Import FL Studio project…, or drop an `.flp` / zipped loop package): channels,
  patterns and notes, the arrangement (clips, track names, markers), mixer names, levels, routing and matching
  effects. Samples come along from a zipped loop package; VST and other plugins get a built-in stand-in that keeps
  their notes, and a report says what didn't come across (File → Find missing samples… fills in samples later).
- **Visualizer**: a scope in the toolbar (click it for the spectrum) and a Visualizer window (⌥V) with the
  spectrum, left/right waveforms and peaks of what you hear; live gain-reduction and pitch meters in plugin windows.
- **Presets**: every plugin window has a preset bar (◀ name ▶): load factory presets, save your own, rename,
  delete, reset, randomize ("vary a little" to "everything"), export and import `.agpreset` files. The browser's
  Presets section lists yours and searches every preset; click one to add it.
- **Settings** (Options → Settings…, F10): which speakers or headphones to play through (with a left/right test
  sound), MIDI devices, the typing piano, recording options, tooltips, and the look: four themes (Dark, Midnight,
  Graphite, Light) and seven accent colors (also in Options → Theme and Accent color).

## AI studio (✦ in the toolbar, or ⌥6)

Ask for anything in your own words, and the AI does it in your project as **one undoable step**: write a beat
("dark trap at 140, 808s that slide"), change the mix ("put the snare on its own track with a plate reverb, duck
the 808 with the kick"), swap or tweak instruments and effects, write melodies and chords, run note tools, draw
automation ("filter sweep over the last 4 bars", "speed up to 150 BPM by the drop"), drop markers, arrange the
playlist, or use the app itself ("save it", "export a WAV", "undo that", "open the mixer"). It can run every
command in the app; file dialogs just ask you for one click.

**Songs that flow.** Ask for a song and the AI writes a beat per section and lays them out with the arranger, which
does the producer's craft for you: a change every 4 bars and a fill every 8 (fills replace the groove, they don't
pile on top), a gap before each drop, risers, reverse crashes, impacts and downlifters, filter sweeps, crashes
where sections start, and a real ending. Recipes cover trap, drill, boom bap, lo-fi, house, EDM, reggaeton,
afrobeats and pop, each with its own swing, accents, drum kit and sounds. New songs get their **mix set up**:
buses for kick, drums, 808, chords, lead and FX, the 808 ducking under the kick, reverb and delay sends, a master
chain ending in a Limiter, and then **auto-leveling**: it renders the busiest part and sets every bus and the
master to the style's balance and loudness. All of this is also in the Playlist menu without the AI ("Develop this
part", "Add a fill here", "Add a transition here", "Clean up the song…").

**Ask AI about a part.** Highlight bars (drag on the ruler) or select clips and click **✦ Ask AI**, or click the ✦ on a
section's marker, or right-click a clip, a marker or selected notes. Type what should change ("smooth the transition
into the drop", "more bounce", "add a fill at the end") or pick an idea. The AI changes only that part (plus a bar
around it for transitions): patterns that also play elsewhere are copied for the part, so the rest of the song stays
exactly as it was. One undo step, as always.

It **listens before it mixes**: ask it to mix or master (or press **✦ Check my mix**) and it renders the mix and
every mixer track, measures loudness (LUFS), peaks and true peak, tone per band, stereo width and clashes in the low
end, tells you what it hears, then fixes it with those numbers in front of it (faders, EQ, sidechain, the master's
loudness).

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
2. **Your ChatGPT plan, through Codex** (no API key, nothing billed separately; it counts toward your plan's Codex
   usage). The ChatGPT app for Mac already includes the Codex command; otherwise install it with
   `npm i -g @openai/codex`. Sign in once with your ChatGPT account, in Terminal (use `codex` on its own if it is on
   your PATH, otherwise the full path):

   ```bash
   /Applications/ChatGPT.app/Contents/Resources/codex login
   ```

   AGstudio's dev server then runs `codex exec` for each request (read-only, in an empty temporary folder, with
   Codex's tools turned off and your Codex config ignored), so the page never sees your login. Every AI feature
   works through it: the Studio chat, "Check my mix", the follow-up looks and the plugin builder. An API-key login
   of Codex is not used (it would bill the API, not your plan); if `codex` lives somewhere unusual, set
   `AGSTUDIO_CODEX_BIN=/path/to/codex` in `.env.local`. Same rule as above: for your own use on your machine.
3. **An API key**: copy `.env.example` to `.env.local` and put your key after `ANTHROPIC_API_KEY=` (from
   https://console.anthropic.com/). The dev server adds it to requests; changes apply without a restart.
4. **The offline generator**: built in, always available, no account needed.

"Auto" tries them in this order: your Claude subscription, your ChatGPT plan, the API key, then offline. You can pick
the Claude model (Opus 5.5 by default; Sonnet and Haiku are faster) or the ChatGPT model ("Codex default", or type
the id of another one under "Other model…") in the assistant's header.

Shortcuts: press F1 in the app, or see [docs/shortcuts.md](docs/shortcuts.md). On a Mac, F-keys may need Fn;
every window also has an Alt+number shortcut and a toolbar button.

## Control AGstudio from AI apps (MCP)

Any AI app that speaks the [Model Context Protocol](https://modelcontextprotocol.io) (Claude Code, Claude Desktop,
Cursor…) can read and change the project you have open, play it, listen to the mix and export it, with the same tools
Studio uses. Everything it changes appears in Studio's chat as "Claude Code changed: …" with an **Undo** button, one
undo step per call.

**Claude Code**, one line in a terminal (copy it with its token from Options → Connect Claude Code or other apps (MCP)…, or from
the action search: "Copy the Claude Code setup command"):

```bash
claude mcp add --transport http agstudio http://localhost:5390/mcp --header "Authorization: Bearer <token>"
```

**Claude Desktop** starts MCP servers as programs, so it runs `bin/agstudio-mcp` (a tiny stdio-to-HTTP helper that
needs only Node and reads the token from `.agstudio/mcp-token` itself). Add this to `claude_desktop_config.json`
(Claude → Settings → Developer → Edit Config) and restart it; Settings shows the exact text with your path:

```json
{ "mcpServers": { "agstudio": { "command": "/path/to/AGstudio/bin/agstudio-mcp", "env": { "AGSTUDIO_URL": "http://localhost:5390" } } } }
```

Apps that take a URL and headers (Cursor, VS Code, `.mcp.json`) use `{"type":"http","url":"http://localhost:5390/mcp",
"headers":{"Authorization":"Bearer <token>"}}`; the Settings section has a copy button for it.

It works while AGstudio runs from its dev server (the `agstudio` command) and is open in a browser tab: the project
lives in that tab, so the dev server relays each call to it. With several tabs the one you used last answers; with
none, the AI app is told "Open AGstudio in the browser first". Sound stays locked until you click once in the tab.

**Tools**: `get_guide` (the rules and music know-how Studio itself uses; read first), `get_project` (the text Studio
sends Claude, optionally with the detail of some bars), `list_plugins`, and the read tools Studio has (`get_pattern_notes`,
`get_channel`, `get_mixer`, `get_clips`, `get_automation`, `get_selection`, `get_transport`, `get_settings`,
`get_windows`, `get_plugins`, `get_project_summary`),
`apply_actions` (the Studio action list: one undo step; with a `focus` of bars only that part may change, and edits
reaching outside it come back as a question until `approve_outside: true`), `list_commands` / `run_command` (every
menu item; file dialogs become a button for you to click: "Claude Code wants to export…"), `play`, `stop`, `seek`,
`set_loop`, `transport_state`, `undo`, `redo`, `history`, `analyze_mix` (loudness, balance and findings),
`render_preview` (a short WAV as audio content) and `export_audio` (writes WAV, FLAC or MP3, or stems, into
`~/Music/AGstudio/`, no file dialog). The project, the commands, the plugins and the guide are also MCP resources.

**Safety**: the endpoint only answers connections from this computer, only for the `localhost`, `127.0.0.1` or `[::1]`
Host and Origin (against DNS rebinding), and only with the access token (`Authorization: Bearer …` or `?token=`),
which is made once into the git-ignored `.agstudio/mcp-token` (mode 0600) and can be replaced in Settings (apps with
the old one are locked out). The switch "Let AI apps control AGstudio" in Settings (Options → Let other apps control AGstudio) turns every app away at once.

**Try it by hand** with curl (from the AGstudio folder, with the dev server running and a tab open):

```bash
T=$(cat .agstudio/mcp-token); H=(-H "Authorization: Bearer $T" -H 'content-type: application/json' -H 'MCP-Protocol-Version: 2025-06-18')
curl -s localhost:5390/mcp "${H[@]}" -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","clientInfo":{"name":"curl"}}}'
curl -s localhost:5390/mcp "${H[@]}" -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
curl -s localhost:5390/mcp "${H[@]}" -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_project","arguments":{}}}'
curl -s localhost:5390/mcp "${H[@]}" -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"apply_actions","arguments":{"summary":"Set the tempo","actions":[{"op":"song","bpm":96}]}}}'
```

Details (protocol subset, bridge, tools): `docs/architecture.md`, "MCP: AI apps control AGstudio".

## Write your own instrument, effect or note tool

In the app: **Add → New plugin…**. Name it, pick what it is (instrument, effect or piano-roll tool) and how it's
written (Faust, Web Audio nodes or your own worklet DSP); AGstudio writes it into `plugins/`, puts it in your project
and opens it in your code editor. Any of your plugins' windows has **Edit code**. From a terminal:

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
