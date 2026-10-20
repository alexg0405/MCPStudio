# AGstudio

An FL Studio-style DAW that runs in Chrome, built to be extended: your own instruments and effects are
TypeScript plugins you drop into `plugins/`, and they hot-reload while you play.

## Run it

AGstudio runs on **macOS, Linux and Windows 10/11**, in Chrome or Edge, with Node 22 or newer. (On Windows, see
[Windows](#windows) below for the step-by-step.) On macOS and Linux, one command from any folder:

```bash
agstudio
```

It starts the dev server on http://localhost:5390 and opens it in your browser (if it is already running, it just
opens it); Ctrl+C stops it. Click anywhere once to enable audio. `bin/agstudio` is the script (a small wrapper that finds Node and
runs `scripts/agstudio.mjs`); link it onto your PATH once with `ln -sf "$PWD/bin/agstudio" ~/.local/bin/agstudio` (it installs the
dependencies on the first run). `AGSTUDIO_NO_OPEN=1 agstudio` starts it without opening a window.

By hand, with Node on your PATH: `npm ci` once, then `npm run dev`. (The owner's Mac keeps Node 22 in `~/.local/node/bin`, which is
not on PATH there: `export PATH="$HOME/.local/node/bin:$PATH"; npm run dev`.)

## Windows

Needs Windows 10 or 11, Google Chrome or Microsoft Edge, and Node 22 or newer. Nothing else: no WSL, no Visual Studio.

1. **Install Node.** Download the Windows installer (LTS, version 22 or newer) from https://nodejs.org and run it with the
   defaults (keep "Add to PATH" ticked). Open a **new** PowerShell or Command Prompt window and check `node --version`.
2. **Get AGstudio.** With Git: `git clone <the AGstudio repository address> AGstudio`, or copy the AGstudio folder to your computer,
   for example to `C:\Users\you\AGstudio` (a folder inside your user folder is best: see the access token note below).
3. **Install its parts once**, inside that folder: `cd AGstudio`, then `npm ci`.
4. **Start it:** `.\bin\agstudio.cmd` in PowerShell (`bin\agstudio.cmd` in Command Prompt), or double-click `bin\agstudio.cmd`
   in File Explorer. It starts the dev server on http://localhost:5390 and opens it in your browser; Ctrl+C stops it (Command Prompt
   then asks "Terminate batch job (Y/N)?": answer Y). Windows may ask whether Node.js may use the network: AGstudio only needs
   this computer, so you can choose "Cancel" or allow it on private networks.
5. **Click once in the page** to enable audio.

To start it from any folder, put `bin` on your PATH once (then open a new terminal and type `agstudio`; `agstudio --app` works too):

```powershell
[Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path', 'User') + ';' + (Resolve-Path .\bin), 'User')
```

(Run it inside the AGstudio folder. Or add the folder by hand: Start → "Edit environment variables for your account" → Path → New.)

For a desktop or Start-menu icon: right-click `bin\agstudio.cmd` → Show more options → Send to → Desktop (create shortcut). To start the app
version, add ` --app` after the path in the shortcut's Target. Move the shortcut into the Start menu with Win+R → `shell:programs`.
The best everyday way is the installed app below: run `agstudio --app` once, install it from Chrome or Edge, and pin it to the taskbar.

On Windows, Edge's install is "⋯ → Apps → Install this site as an app". Windows lists the installed app under "Open with" for
`.agproj`, `.agchain` and `.agpreset` files; choose "Always" to open projects by double-click. Where something on Windows works
differently, the section it belongs to says so (AI, MCP, exports). Keys are Ctrl and Alt instead of ⌘ and ⌥ everywhere in the app.
This setup is written for Windows and checked on a Mac with the platform simulated; if something fails on a real Windows
computer, the first thing to send is the text the terminal prints.

Other scripts (the same in cmd.exe and PowerShell): `npm run check` (types, lint, all tests), `npm test` (unit), `npm run test:audio` (headless Chrome;
it uses the installed Chrome, or Edge with `AGSTUDIO_TEST_BROWSER=msedge`),
`npm run test:perf` (speed assertions with their real limits; run it on a quiet machine; `npm run check` runs the speed and live-audio tests last, one file at a time),
`npm run build` (production build in `dist/`).

## Install as an app

AGstudio installs from Chrome or Edge as an app: its own window and dock or taskbar icon, no browser tab, a start that works without any server
running, and a double-click on a project (`.agproj`, also `.agchain` and `.agpreset`) opens it.

```bash
agstudio --app
```

builds the production version when it is missing or older than the code, serves it on http://localhost:5391 (`$APP_PORT`) and
opens it. Then **Help → Install AGstudio as an app** (also in the action search, and on the welcome screen), or the install icon at
the right end of the address bar. From then on open AGstudio from the dock, Launchpad, Start menu or taskbar; `agstudio --app` opens the
installed app once it exists (on macOS and Windows; on Linux it opens the browser tab). (An installed app belongs to its address, so keep using port 5391 for it. `agstudio` without `--app` is still
the development server on 5390, with hot reload, and has nothing to do with the installed app.)

- **Works offline, with no server:** the whole editor, audio, saving and opening projects, export, the offline beat generator,
  your plugins (they are part of the build).
- **Needs `agstudio --app` running** (a terminal is enough): the AI studio (Claude, ChatGPT, API key).
- **Needs the dev server, `agstudio`, in a browser tab:** AI apps connecting over MCP, the AI plugin builder, New plugin…, Edit
  code, and hot reload while you write plugins. These say so when they cannot be reached. Plugins you add or change reach the
  installed app the next time `agstudio --app` builds (it rebuilds by itself when the code is newer).
- **Updates:** a new build downloads in the background and a small "Update ready" note offers Reload; nothing reloads by itself, and
  Reload waits while a song plays.
- **Window controls in the toolbar:** the installed window's title bar has Chrome's toggle for "Window Controls Overlay"; with it on,
  the toolbar takes the title bar's place and its empty parts drag the window (not verified in a real window yet).

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
  6-slot mod matrix, and a table editor: draw your own wavetable, set its harmonics, import a WAV or slice a sample
  into frames), Granular (clouds of grains from a sample with position, spray, scan and freeze), FM (4 operators, 8 algorithms), Drum Pads (16 pads with choke groups; drop your samples on
  them), Slicer (chops a loop across the keys), Drum Synth, and a generated drum kit.
- **Built-in effects**: EQ, EQ Pro (8 bands on a draggable curve over a live spectrum), Filter, Delay, Reverb,
  Compressor (with sidechain), Limiter (true peak), Multiband, Transient Shaper, Saturator, Distortion, Ducker
  (sidechain or tempo pump), Gate, Chorus, Flanger, Phaser, Stereo, Lo-Fi, Stutter, Vocoder, Tune, De-esser,
  Doubler, Harmonizer (live harmony voices that follow the song key or the notes of a guide channel), Denoise (live noise
  reduction that learns your room) and Analyzer (spectrum, LUFS, true peak). Vocal chains: six ready-made effect chains (clean pop, rap, airy
  ballad, lo-fi, trap auto-tune, podcast) that go on a mixer track in one click (Chains in the browser, or
  right-click a track), save your own track's effects as a chain and share it as a .agchain file; voices get a Vocals bus.
- **Harmonies from a vocal**: right-click a sung audio clip › Make harmonies… turns it into 1–4 backing voices on new
  tracks under it: a third above, a fifth below, tones of the chord track, a fixed interval or the notes of a guide
  channel, each with its own level, pan, vowel colour and a little human timing and pitch drift; hear them first (A/B),
  one undo removes them all, and Update harmonies makes them again when the vocal, the chords or the key change.
- **Vocal cleanup**: right-click a recorded clip → Clean up vocal… takes out background noise (learned from a quiet part), tones
  down or removes breaths (shown as markers on the clip) and repairs mouth clicks, with a before/after listen; it is made
  in the background as a new sound (your recording stays, Undo goes back) and the Pitch editor then works on the cleaned sound.
- **Recording and MIDI**: metronome and count-in, note recording from MIDI or the computer keyboard (quantize,
  overdub or replace), an on-screen keyboard, MIDI learn for any knob, MIDI file import and export, hum to notes.
  FL's score log: everything you play is kept for 5 minutes, so Patterns → Dump what I played… turns a riff you
  played without recording into a pattern. Tap tempo (Shift+T or Options → Tap tempo).
- **Vocal alignment** (right-click an audio clip → Align to guide…, or Playlist → Align vocals…): make doubles, backing
  vocals and ad-libs follow a lead like VocAlign: their syllables move onto the lead's timing (consonants stay sharp, pitch
  is kept), with a Tightness from "only big offsets" to "syllable by syllable", and optionally their pitch follows the lead's
  contour (a harmony keeps its interval). Tighten timing to the grid snaps a vocal's syllables to the beat. A/B against your
  original recording, a subtle line on the clip shows where it was moved, undo restores it, and the Studio chat does it too.
- **Samples**: add folders from your disk to the browser, preview, drag onto the rack or playlist (or drop files
  from Finder or File Explorer). Samples are embedded in saved projects.
- **DJ auto-mix** (View → DJ mix, ⌥J, or the browser's Music section): add your own songs (MP3, AAC/M4A, WAV,
  FLAC, OGG; streaming services like Spotify can't be mixed, their audio is locked), press **Make the mix** and
  Studio orders them (Camelot keys, tempos, an energy shape: party, build, peak time, chill), beat-matches them
  and builds every transition on the playlist: phrase-aligned 8/16/32-bar blends with a bass swap, filter or
  echo outs, cuts, risers, tempo glides, a marker per song. Tweak one transition, then export the mix. The
  Studio chat does it too ("make a 30-minute party mix", "smoother transition into song 4").
- **Files**: `.agproj` save/open (File System Access, so Ctrl+S / Cmd+S overwrites), recent files, reload restore, autosave
  with crash recovery, WAV export (16-bit dithered, 24-bit, 32-bit float), undo history (⌥H) with click-to-jump,
  and shortcuts you can change (Help → Keyboard shortcuts).
- **Music videos** (File → Export as video…, or right-click a marker, the loop or a clip): the song or a part of it
  as an MP4 (H.264 + AAC) or WebM (VP9 or AV1 + Opus) file, rendered offline, several times faster than real time.
  Four looks (spectrum bars, waveform, circular spectrum, minimal with a progress bar) with your title and artist, an
  optional cover picture, a pulse on every beat, in the app's colors; widescreen 1920×1080, vertical 1080×1920
  (shorts, reels, TikTok) or square, at 30 or 60 fps. The Studio chat and MCP (`export_video`) make them too.
- **FL Studio import** (File → Import FL Studio project…, or drop an `.flp` / zipped loop package): channels,
  patterns and notes, the arrangement (clips, track names, markers), mixer names, levels, routing and matching
  effects. Samples come along from a zipped loop package; VST and other plugins get a built-in stand-in that keeps
  their notes, and a report says what didn't come across (File → Find missing samples… fills in samples later).
- **Visualizer**: a scope in the toolbar (click it for the spectrum) and a Visualizer window (⌥V) with the
  spectrum, left/right waveforms and peaks of what you hear; live gain-reduction and pitch meters in plugin windows.
- **Meters** (View → Meters, ⌥⇧M, or click the master meter): the master or any insert, measured live the way streaming
  services and broadcasters do: momentary, short-term and integrated loudness (LUFS, BS.1770-4 / EBU R128), loudness
  range, 4× true peak with hold, a target line (your style's, your reference song's, or −14 / −16 / −23 LUFS) and a
  loudness history; stereo correlation, a goniometer, width per band and an out-of-phase bass warning; a 1/6-octave
  spectrum with peak hold and a spectrogram (with your reference song's tone drawn over it). **Loudness report…**
  renders the song offline and tells you the LUFS, range, true peak and bar of the loudest moments, and what Spotify,
  YouTube and Apple Music will do to it. The mixer's master strip shows the short-term loudness and true peak. The meter
  only exists on the audio thread while a Meters window or the mixer is open. Studio can read it (`get_loudness`) and run
  the report (`loudness_report`).
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

AGstudio sends the prompt to Claude Code through its standard input (not on the command line) whenever the command line would be too long
for the system; on Windows, whose limit is about 32 000 characters, that is every request. (`AGSTUDIO_CLAUDE_TRANSPORT=stdin` or `argv`, set in
the terminal that starts AGstudio, forces one way: handy to try the Windows way on a Mac.)

**Who answers** (the picker in the AI studio's header; "Auto" uses the first one that's set up):

1. **Your Claude subscription** (no API key, nothing billed separately; it counts toward your plan's usage like any
   Claude Code use). Install Claude Code and sign in once, in Terminal:

   ```bash
   curl -fsSL https://claude.ai/install.sh | bash
   ```

   ```bash
   ~/.local/bin/claude auth login
   ```

   On Windows, in PowerShell (the installer puts `claude.exe` in `%USERPROFILE%\.local\bin`; `npm i -g @anthropic-ai/claude-code`
   works too):

   ```powershell
   irm https://claude.ai/install.ps1 | iex
   claude auth login
   ```

   If AGstudio says Claude Code isn't installed although it is, set `AGSTUDIO_CLAUDE_BIN` to its full path in `.env.local`
   (for example `AGSTUDIO_CLAUDE_BIN=C:\Users\you\.local\bin\claude.exe`).

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
   `AGSTUDIO_CODEX_BIN=/path/to/codex` in `.env.local`. Same rule as above: for your own use on your machine. On Windows install it with
   `npm i -g @openai/codex` (then `codex login` in PowerShell); AGstudio finds `codex.cmd` in `%APPDATA%\npm` and `codex.exe` on your
   PATH. A copy bundled inside a ChatGPT or Codex desktop app on Windows is only found when it is on the PATH or named in
   `AGSTUDIO_CODEX_BIN` (where those apps keep it is not known here).
3. **An API key**: copy `.env.example` to `.env.local` and put your key after `ANTHROPIC_API_KEY=` (from
   https://console.anthropic.com/). The dev server adds it to requests; changes apply without a restart.
4. **The offline generator**: built in, always available, no account needed.

"Auto" tries them in this order: your Claude subscription, your ChatGPT plan, the API key, then offline. You can pick
the Claude model (Opus 5.5 by default; Sonnet and Haiku are faster) or the ChatGPT model ("Codex default", or type
the id of another one under "Other model…") in the assistant's header.

Shortcuts: press F1 in the app, or see [docs/shortcuts.md](docs/shortcuts.md) (⌘ and ⌥ on a Mac are Ctrl and Alt on Windows and Linux). On a Mac, F-keys may need Fn;
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

On Windows the command is the `.cmd` file, written with doubled backslashes in JSON, and the config file is
`%APPDATA%\Claude\claude_desktop_config.json` (Edit Config opens the right one; the Microsoft Store version of Claude keeps it elsewhere):

```json
{ "mcpServers": { "agstudio": { "command": "C:\\Users\\you\\AGstudio\\bin\\agstudio-mcp.cmd", "env": { "AGSTUDIO_URL": "http://localhost:5390" } } } }
```

The Claude Code line above is the same in PowerShell and Command Prompt. If Claude Desktop cannot start the `.cmd`, use
`"command": "node"` with `"args": ["C:\\Users\\you\\AGstudio\\bin\\agstudio-mcp.mjs"]` instead.

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
`render_preview` (a short WAV as audio content), `export_audio` (writes WAV, FLAC or MP3, or stems, into
`~/Music/AGstudio/` (on Windows `C:\Users\you\Music\AGstudio`; set the `AGSTUDIO_EXPORTS_DIR` environment variable to use another folder, for example when OneDrive moved your Music folder), no file dialog) and `export_video` (a music video of up to four minutes, MP4 or WebM, into the
same folder). The project, the commands, the plugins and the guide are also MCP resources.

**Safety**: the endpoint only answers connections from this computer, only for the `localhost`, `127.0.0.1` or `[::1]`
Host and Origin (against DNS rebinding), and only with the access token (`Authorization: Bearer …` or `?token=`),
which is made once into the git-ignored `.agstudio/mcp-token` (mode 0600 on macOS and Linux; Windows has no such modes, so the file is as private
as the folder it is in: keep AGstudio inside your user folder, where other accounts cannot read it) and can be replaced in Settings (apps with
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

(Drop the `export` part where Node is on your PATH, which includes Windows: `npm run new:plugin -- --kind instrument --style graph --id user.my-synth`.)

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
