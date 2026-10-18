/**
 * What a controller can drive: the catalog of DJ targets (per deck and global) with the kind of
 * control each one needs. Target ids are plain strings: "A.play", "B.hotcue:3", "crossfader".
 * The app layer (`app/dj/controllers`) turns a target into a call on the live decks.
 */

export type DeckLetter = 'A' | 'B' | 'C' | 'D';
/** The deck letters used in target ids ("A.play"). */
export const DECK_LETTERS: readonly DeckLetter[] = ['A', 'B', 'C', 'D'];

/** button: pressed or released. abs: a fader or knob (0–1). rel: an endless dial or jog wheel (steps). */
export type TargetKind = 'button' | 'abs' | 'rel';

/** A control a mapping can drive: its id, deck, kind, label and hint. */
export interface TargetInfo {
  id: string;
  deck?: DeckLetter;
  /** The part after "A.", or the whole id for global targets. */
  fn: string;
  label: string;
  group: string;
  kind: TargetKind;
  /** Plain words for the hint bar and the learn list. */
  hint: string;
  /** The controller can show its state with an LED (play lit while playing…). */
  led?: boolean;
}

interface FnDef {
  fn: string;
  label: string;
  kind: TargetKind;
  hint: string;
  led?: boolean;
}

const HOT_CUE_COUNT = 8;
/** The loop sizes (beats) that have their own targets. */
export const AUTO_LOOP_BEATS = [1, 2, 4, 8, 16, 32] as const;

const DECK_FNS: readonly (FnDef & { group: string })[] = [
  { group: 'Transport', fn: 'play', label: 'Play / pause', kind: 'button', hint: 'Starts or pauses the deck', led: true },
  { group: 'Transport', fn: 'cue', label: 'Cue', kind: 'button', hint: 'Paused: sets the cue point; playing: back to the cue point; held: previews', led: true },
  { group: 'Transport', fn: 'sync', label: 'Sync', kind: 'button', hint: 'Matches this deck’s tempo and beat to the other deck', led: true },
  { group: 'Transport', fn: 'keylock', label: 'Key lock', kind: 'button', hint: 'Keeps the song’s key when the tempo changes', led: true },
  { group: 'Transport', fn: 'pfl', label: 'Headphone cue', kind: 'button', hint: 'Sends this deck to the headphone (cue) bus', led: true },
  { group: 'Transport', fn: 'load', label: 'Load song', kind: 'button', hint: 'Loads the highlighted library song (turn the browse encoder to choose) on this deck' },
  { group: 'Transport', fn: 'eject', label: 'Eject', kind: 'button', hint: 'Empties the deck' },
  { group: 'Platter', fn: 'jog', label: 'Jog wheel', kind: 'rel', hint: 'Turn to nudge the beat; touching the platter while playing scratches' },
  { group: 'Platter', fn: 'jogNudge', label: 'Jog rim (nudge)', kind: 'rel', hint: 'Always nudges the tempo up or down a little, never scratches' },
  { group: 'Platter', fn: 'jogScratch', label: 'Jog platter (scratch)', kind: 'rel', hint: 'Always scratches: moves the song with the wheel' },
  { group: 'Platter', fn: 'jogTouch', label: 'Jog touch', kind: 'button', hint: 'The platter’s touch sensor: while touched, the jog wheel scratches' },
  { group: 'Platter', fn: 'search', label: 'Search (seek)', kind: 'rel', hint: 'Turn to move quickly through the song' },
  { group: 'Pitch', fn: 'pitch', label: 'Pitch fader', kind: 'abs', hint: 'Tempo −/+ the pitch range (a 14-bit fader works best)' },
  { group: 'Mixer', fn: 'volume', label: 'Channel fader', kind: 'abs', hint: 'The deck’s volume' },
  { group: 'Mixer', fn: 'trim', label: 'Trim (gain)', kind: 'abs', hint: 'Input gain, −12 to +12 dB (centre = 0 dB)' },
  { group: 'Mixer', fn: 'eq.high', label: 'EQ high', kind: 'abs', hint: 'Treble: −26 dB (kill) to +6 dB, centre = 0 dB' },
  { group: 'Mixer', fn: 'eq.mid', label: 'EQ mid', kind: 'abs', hint: 'Mids: −26 dB (kill) to +6 dB, centre = 0 dB' },
  { group: 'Mixer', fn: 'eq.low', label: 'EQ low', kind: 'abs', hint: 'Bass: −26 dB (kill) to +6 dB, centre = 0 dB' },
  { group: 'Mixer', fn: 'filter', label: 'Filter', kind: 'abs', hint: 'Left of centre closes a low-pass, right of centre opens a high-pass, centre = off' },
  { group: 'Loops', fn: 'loopIn', label: 'Loop in', kind: 'button', hint: 'Starts a loop here (on the beat grid)' },
  { group: 'Loops', fn: 'loopOut', label: 'Loop out', kind: 'button', hint: 'Ends the loop here and starts looping' },
  { group: 'Loops', fn: 'loopExit', label: 'Exit loop', kind: 'button', hint: 'Leaves the loop', led: true },
  { group: 'Loops', fn: 'loopHalve', label: 'Loop ÷2', kind: 'button', hint: 'Halves the loop length' },
  { group: 'Loops', fn: 'loopDouble', label: 'Loop ×2', kind: 'button', hint: 'Doubles the loop length' },
  { group: 'Loops', fn: 'beatJumpBack', label: 'Beat jump back', kind: 'button', hint: 'Jumps back by the beat jump size, keeping the beat' },
  { group: 'Loops', fn: 'beatJumpFwd', label: 'Beat jump forward', kind: 'button', hint: 'Jumps forward by the beat jump size, keeping the beat' },
];

function deckFnDefs(): FnDef[] {
  const out: FnDef[] = DECK_FNS.map(({ group: _g, ...d }) => d);
  for (let i = 1; i <= HOT_CUE_COUNT; i++)
    out.push({ fn: `hotcue:${i}`, label: `Hot cue ${i}`, kind: 'button', hint: `Empty: sets hot cue ${i} here; set: jumps to it`, led: true });
  for (let i = 1; i <= HOT_CUE_COUNT; i++)
    out.push({ fn: `hotcueClear:${i}`, label: `Clear hot cue ${i}`, kind: 'button', hint: `Removes hot cue ${i}` });
  for (const b of AUTO_LOOP_BEATS)
    out.push({
      fn: `autoLoop:${b}`,
      label: `Loop ${b} beat${b === 1 ? '' : 's'}`,
      kind: 'button',
      hint: `Loops the next ${b} beat${b === 1 ? '' : 's'} from here`,
      led: true,
    });
  return out;
}

const groupOfFn = (fn: string): string => {
  const base = DECK_FNS.find((d) => d.fn === fn)?.group;
  if (base) return base;
  if (fn.startsWith('hotcue')) return 'Hot cues';
  if (fn.startsWith('autoLoop')) return 'Loops';
  return 'Other';
};

const GLOBAL: readonly TargetInfo[] = [
  { id: 'crossfader', fn: 'crossfader', label: 'Crossfader', group: 'Mixer', kind: 'abs', hint: 'Fades between the decks on side A and side B' },
  { id: 'masterVolume', fn: 'masterVolume', label: 'Master volume', group: 'Mixer', kind: 'abs', hint: 'The output level of the mix' },
  { id: 'browse', fn: 'browse', label: 'Browse (library)', group: 'Library', kind: 'rel', hint: 'Turn to move the highlight one song at a time through your music library' },
  { id: 'browseFast', fn: 'browseFast', label: 'Browse fast', group: 'Library', kind: 'rel', hint: 'Turn to move the highlight ten songs at a time' },
  { id: 'record', fn: 'record', label: 'Record the mix', group: 'Library', kind: 'button', hint: 'Starts and stops recording the master output into your library', led: true },
  { id: 'app.playPause', fn: 'app.playPause', label: 'Project play / pause', group: 'App', kind: 'button', hint: 'Plays or pauses the project’s transport (not a deck)' },
  { id: 'app.stop', fn: 'app.stop', label: 'Project stop', group: 'App', kind: 'button', hint: 'Stops the project’s transport (not a deck)' },
];

// ---- The clip launcher's pads, scene buttons, stop buttons and page buttons (8 tracks and 8 scenes at a time) ----

export const LAUNCH_PAD_SIZE = 8;

/** The page buttons: move the 8 × 8 pads one page (8 tracks or 8 scenes) over a bigger grid. */
export type LaunchPageDir = 'left' | 'right' | 'up' | 'down';
/** The directions the clip launcher's page can be moved in. */
export const LAUNCH_PAGE_DIRS: readonly LaunchPageDir[] = ['up', 'down', 'left', 'right'];

/** What a launcher target id means (1-based positions), or null for any other id. */
export type LaunchTarget =
  | { kind: 'slot'; track: number; scene: number }
  | { kind: 'scene'; scene: number }
  | { kind: 'stop'; track: number }
  | { kind: 'stopAll' }
  | { kind: 'page'; dir: LaunchPageDir };

const LAUNCH_RE = /^launch\.(slot):([1-8]):([1-8])$|^launch\.(scene|stop):([1-8])$|^launch\.(stopAll)$|^launch\.page:(left|right|up|down)$/;

/** Reads a clip launcher target id (null for any other id). */
export function parseLaunchTarget(id: string): LaunchTarget | null {
  const m = LAUNCH_RE.exec(id);
  if (!m) return null;
  if (m[1]) return { kind: 'slot', track: Number(m[2]), scene: Number(m[3]) };
  if (m[4] === 'scene') return { kind: 'scene', scene: Number(m[5]) };
  if (m[4] === 'stop') return { kind: 'stop', track: Number(m[5]) };
  if (m[7]) return { kind: 'page', dir: m[7] as LaunchPageDir };
  return { kind: 'stopAll' };
}

/** Whether an id is a clip launcher target. */
export const isLaunchTarget = (id: string): boolean => LAUNCH_RE.test(id);

/** The id of the pad for a track and a scene (1-based). */
export const launchSlotId = (track: number, scene: number) => `launch.slot:${track}:${scene}`;

function launchTargets(): TargetInfo[] {
  const out: TargetInfo[] = [];
  for (let s = 1; s <= LAUNCH_PAD_SIZE; s++)
    out.push({
      id: `launch.scene:${s}`,
      fn: `launch.scene:${s}`,
      label: `Launcher: scene ${s}`,
      group: 'Scene buttons',
      kind: 'button',
      hint: `Launches every slot of scene ${s} together in the clip launcher`,
      led: true,
    });
  for (let t = 1; t <= LAUNCH_PAD_SIZE; t++)
    out.push({
      id: `launch.stop:${t}`,
      fn: `launch.stop:${t}`,
      label: `Launcher: stop track ${t}`,
      group: 'Stop buttons',
      kind: 'button',
      hint: `Stops what track ${t} of the clip launcher plays, at the next boundary`,
    });
  out.push({
    id: 'launch.stopAll',
    fn: 'launch.stopAll',
    label: 'Launcher: stop all',
    group: 'Stop buttons',
    kind: 'button',
    hint: 'Stops everything the clip launcher plays, at the next boundary',
  });
  for (const dir of LAUNCH_PAGE_DIRS)
    out.push({
      id: `launch.page:${dir}`,
      fn: `launch.page:${dir}`,
      label: `Launcher: page ${dir}`,
      group: 'Page buttons',
      kind: 'button',
      hint: `Moves the pads one page ${dir} over the clip launcher’s grid (8 ${dir === 'left' || dir === 'right' ? 'tracks' : 'scenes'} at a time), so a grid bigger than 8 × 8 can be reached; the pad lights follow`,
    });
  for (let t = 1; t <= LAUNCH_PAD_SIZE; t++)
    for (let s = 1; s <= LAUNCH_PAD_SIZE; s++)
      out.push({
        id: launchSlotId(t, s),
        fn: launchSlotId(t, s),
        label: `Launcher: track ${t}, scene ${s}`,
        group: `Pads: track ${t}`,
        kind: 'button',
        hint: `Presses the slot at track ${t}, scene ${s} of the clip launcher (its mode decides what a press does); the pad lights up with the slot’s state`,
        led: true,
      });
  return out;
}

const all: TargetInfo[] = [];
for (const deck of DECK_LETTERS)
  for (const d of deckFnDefs())
    all.push({
      id: `${deck}.${d.fn}`,
      deck,
      fn: d.fn,
      label: `Deck ${deck}: ${d.label}`,
      group: groupOfFn(d.fn),
      kind: d.kind,
      hint: d.hint,
      ...(d.led ? { led: true } : {}),
    });
all.push(...GLOBAL);
const LAUNCH: readonly TargetInfo[] = launchTargets();
all.push(...LAUNCH);
const byId = new Map(all.map((t) => [t.id, t]));

/** Every target, decks A–D first, then the global ones. */
export function allTargets(): readonly TargetInfo[] {
  return all;
}

/** What is known about a target id (undefined for an unknown id). */
export function targetInfo(id: string): TargetInfo | undefined {
  return byId.get(id);
}

/** Whether a value is the id of a known target. */
export function isTargetId(id: unknown): id is string {
  return typeof id === 'string' && byId.has(id);
}

/** The target ids of one deck, in list order. */
export function deckTargets(deck: DeckLetter): TargetInfo[] {
  return all.filter((t) => t.deck === deck);
}

/** The targets that belong to no deck (the mixer, the library and the like). */
export function globalTargets(): readonly TargetInfo[] {
  return GLOBAL;
}

/** The clip launcher's targets (scene buttons, stop buttons, page buttons, pads). */
export function launcherTargets(): readonly TargetInfo[] {
  return LAUNCH;
}

/** "A.hotcue:3" → { deck: 'A', fn: 'hotcue', arg: 3 }. */
export function parseTarget(id: string): { deck?: DeckLetter; fn: string; arg?: number } | null {
  const t = byId.get(id);
  if (!t || isLaunchTarget(id)) return null;
  const [name, arg] = t.fn.split(':');
  return { ...(t.deck ? { deck: t.deck } : {}), fn: name!, ...(arg !== undefined ? { arg: Number(arg) } : {}) };
}
