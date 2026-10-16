/**
 * What a controller can drive: the catalog of DJ targets (per deck and global) with the kind of
 * control each one needs. Target ids are plain strings: "A.play", "B.hotcue:3", "crossfader".
 * The app layer (`app/dj/controllers`) turns a target into a call on the live decks.
 */

export type DeckLetter = 'A' | 'B' | 'C' | 'D';
export const DECK_LETTERS: readonly DeckLetter[] = ['A', 'B', 'C', 'D'];

/** button: pressed or released. abs: a fader or knob (0–1). rel: an endless dial or jog wheel (steps). */
export type TargetKind = 'button' | 'abs' | 'rel';

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
    out.push({ fn: `hotcue:${i}`, label: `Hot cue ${i}`, kind: 'button', hint: `Empty: sets hot cue ${i} here; set: jumps to it (hold Shift to clear)`, led: true });
  for (const b of AUTO_LOOP_BEATS)
    out.push({ fn: `autoLoop:${b}`, label: `Loop ${b} beat${b === 1 ? '' : 's'}`, kind: 'button', hint: `Loops the next ${b} beat${b === 1 ? '' : 's'} from here` });
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
const byId = new Map(all.map((t) => [t.id, t]));

/** Every target, decks A–D first, then the global ones. */
export function allTargets(): readonly TargetInfo[] {
  return all;
}

export function targetInfo(id: string): TargetInfo | undefined {
  return byId.get(id);
}

export function isTargetId(id: unknown): id is string {
  return typeof id === 'string' && byId.has(id);
}

/** The target ids of one deck, in list order. */
export function deckTargets(deck: DeckLetter): TargetInfo[] {
  return all.filter((t) => t.deck === deck);
}

export function globalTargets(): readonly TargetInfo[] {
  return GLOBAL;
}

/** "A.hotcue:3" → { deck: 'A', fn: 'hotcue', arg: 3 }. */
export function parseTarget(id: string): { deck?: DeckLetter; fn: string; arg?: number } | null {
  const t = byId.get(id);
  if (!t) return null;
  const [name, arg] = t.fn.split(':');
  return { ...(t.deck ? { deck: t.deck } : {}), fn: name!, ...(arg !== undefined ? { arg: Number(arg) } : {}) };
}

/** The "other" deck's letter on the same side: used by the mapping presets (deck 1 ↔ A, deck 2 ↔ B). */
export const deckAt = (index: number): DeckLetter => DECK_LETTERS[index] ?? 'A';
