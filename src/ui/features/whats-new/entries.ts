import { showWindow } from '../tours/data/prepare';
import type { TourStep } from '../tours/tour-types';

/**
 * The version of the "What's new" list. Change it when a new batch of features is added to the list below: the panel then
 * opens once, by itself, for everyone who used AGstudio before (never for someone starting for the first time, who has the
 * welcome screen). Help → What's new opens it any time.
 */
export const WHATS_NEW_VERSION = '2026.10';

/** The small picture each entry has (`illustrations.tsx`). */
export type WhatsNewArt =
  | 'tour'
  | 'keys'
  | 'touch'
  | 'versions'
  | 'video'
  | 'meters'
  | 'launcher'
  | 'decks'
  | 'chords'
  | 'vocal'
  | 'samples'
  | 'mcp';

/** One new thing: what it is in a sentence or two, a picture, and where to find it ("Show me"). */
export interface WhatsNewEntry {
  id: string;
  title: string;
  text: string;
  art: WhatsNewArt;
  /** "Show me" opens what this points at and highlights it. */
  show: TourStep;
}

/** The newest features, newest first. */
export const WHATS_NEW: readonly WhatsNewEntry[] = [
  {
    id: 'help-and-tours',
    title: 'Help, Features and guided tours',
    text: 'Search everything AGstudio explains, see everything it can do by area, and take a guided tour of a job: your first song, a vocal, DJ mixing, the clip launcher, chords, mastering or Studio.',
    art: 'tour',
    show: {
      id: 'show-help',
      target: 'menu:help',
      title: 'Help menu',
      body: 'Help → Help and tours, Features, Guided tours and What’s new are all here. Press {key:help.palette} and type “learn” to start a tour from the action search.',
    },
  },
  {
    id: 'share-plugins',
    title: 'Share your own plugins',
    text: 'Pack an instrument or effect you wrote into one file for a friend, install one you were sent after seeing what it can do, and keep your plugins tidy in My plugins, with a gallery of examples to try.',
    art: 'samples',
    show: {
      id: 'show-my-plugins',
      target: 'window:plugin-manager',
      title: 'My plugins',
      body: 'Share, import, duplicate, switch off or delete your own plugins here. Press {key:view.pluginManager} to open it any time.',
      prepare: showWindow('plugin-manager'),
    },
  },
  {
    id: 'keyboard',
    title: 'Use AGstudio without a mouse',
    text: 'Every window, menu, grid and editor works from the keyboard, with a cursor in the playlist, the piano roll and the pitch editor, and a screen reader says where you are and what changed.',
    art: 'keys',
    show: {
      id: 'show-keyboard',
      target: 'window:keyboard-help',
      title: 'Keyboard navigation',
      body: 'Help → Keyboard navigation lists every key. Alt+0 says where you are, Ctrl+F6 jumps between windows and panels, and the arrow keys move inside toolbars and grids.',
      prepare: showWindow('keyboard-help'),
    },
  },
  {
    id: 'touch',
    title: 'Touch layout for tablets',
    text: 'Bigger buttons, finger gestures for panning and zooming the playlist and piano roll, a Keys panel with a piano and drum pads you can play with several fingers.',
    art: 'touch',
    show: {
      id: 'show-touch',
      target: 'menu:view',
      title: 'Touch layout',
      body: 'View → Touch layout turns the big-button layout on or off (it is on by itself when your main pointer is a finger). View → Keys opens the piano and drum pads.',
    },
  },
  {
    id: 'versions',
    title: 'Versions and projects',
    text: 'AGstudio keeps earlier versions of your song as you work, so no change is lost for good. Listen to a version, see what changed, restore it, or open it as a copy. The Projects window lists everything you have made.',
    art: 'versions',
    show: {
      id: 'show-versions',
      target: 'window:versions',
      title: 'Versions',
      body: 'File → Versions lists the save points, newest first. File → Save a version… names one and keeps it forever.',
      prepare: showWindow('versions'),
    },
  },
  {
    id: 'video',
    title: 'Music videos',
    text: 'Turn the song, or a part of it, into an MP4 or WebM video with a moving spectrum, your title and a pulse on every beat. Vertical for shorts and reels, widescreen or square.',
    art: 'video',
    show: {
      id: 'show-video',
      target: 'menu:file',
      title: 'Export as video',
      body: 'File → Export as video… makes the video. You can also right-click a marker, the loop region or a clip.',
    },
  },
  {
    id: 'mixing',
    title: 'Meters, mix snapshots and reference songs',
    text: 'Loudness meters measured the way streaming services do, saved mixes you can switch between while the song plays, mixer groups, and a reference song to compare your tempo, key, loudness and tone with.',
    art: 'meters',
    show: {
      id: 'show-meters',
      target: 'window:meters',
      title: 'Meters',
      body: 'View → Meters shows loudness, true peak, stereo width and the spectrum. View → Mix snapshots and View → Reference are next to it.',
      prepare: showWindow('meters'),
    },
  },
  {
    id: 'launcher',
    title: 'Clip launcher',
    text: 'A grid of scenes and tracks to launch patterns and clips live, always in time, then record the performance onto the playlist.',
    art: 'launcher',
    show: {
      id: 'show-launcher',
      target: 'window:launcher',
      title: 'Clip launcher',
      body: 'View → Clip launcher opens the grid. “Put my patterns in the clip launcher” fills it from your song.',
      prepare: showWindow('launcher'),
    },
  },
  {
    id: 'decks',
    title: 'DJ decks and controllers',
    text: 'Two live decks with sync, cues, loops and a crossfader, next to the auto-mix that builds a whole set. DJ controllers connect and learn any knob.',
    art: 'decks',
    show: {
      id: 'show-decks',
      target: 'window:dj-decks',
      title: 'DJ decks',
      body: 'View → DJ decks opens the live decks; View → DJ mix is the auto-mix.',
      prepare: showWindow('dj-decks'),
    },
  },
  {
    id: 'chords',
    title: 'Chord track and harmonies',
    text: 'Type, detect or pick chords, then write chords, a bass line and a melody that fit them. Turn one sung line into backing harmonies, or any audio into MIDI notes.',
    art: 'chords',
    show: {
      id: 'show-chords',
      target: 'window:chords',
      title: 'Chords',
      body: 'View → Chords opens the chord track’s window. Edit → Make chords from the chord track writes the parts.',
      prepare: showWindow('chords'),
    },
  },
  {
    id: 'vocals',
    title: 'Record, comp, tune and clean a vocal',
    text: 'Record several takes, comp the best parts, fix the pitch note by note, remove noise and breaths, and line doubles up with the lead vocal.',
    art: 'vocal',
    show: {
      id: 'show-vocals',
      target: 'window:pitch-editor',
      title: 'Pitch editor',
      body: 'Select a sung clip, then Playlist → Pitch editor for the selected audio clip. Clean up vocal and Align vocals are in the same menu.',
      prepare: showWindow('pitch-editor'),
    },
  },
  {
    id: 'samples',
    title: 'Sample browser',
    text: 'Add your sample folders and find any sound by its kind, tempo and key, with a preview and a drum kit you can make from what you pick.',
    art: 'samples',
    show: {
      id: 'show-samples',
      target: 'window:samples',
      title: 'Sample browser',
      body: 'View → Sample browser lists your sounds. File → Add a sample folder… adds more.',
      prepare: showWindow('samples'),
    },
  },
  {
    id: 'mcp',
    title: 'Studio, MCP and your own plugins',
    text: 'Ask Studio for changes in your own words. Let Claude Code and other apps control AGstudio over MCP. Build your own instrument or effect from the Add menu.',
    art: 'mcp',
    show: {
      id: 'show-mcp',
      target: 'menu:options',
      title: 'Connect other apps',
      body: 'Options → Connect Claude Code or other apps (MCP)… has the setup line. Add → New plugin… starts your own plugin.',
    },
  },
];
