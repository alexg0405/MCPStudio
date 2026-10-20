/**
 * Tempo, swing and key. A tempo or swing change is one `song` action. A key change moves every pitched part: the notes of the
 * bass, chords and leads (the piano-roll Transpose tool), the chord track (typed again, a semitone count away), a recorded
 * vocal's pitch, and the song key itself. A named part only gets its notes and chords moved, since the key is the whole song's.
 */
import { channelsPlaying, patternParts, skippedLine, oneDecimal } from '../rule-kit';
import { chordsSorted } from '../../query/chords';
import { formatChord, keyUsesFlats, mod12, pitchName, transposeChord } from '../../harmony/chord';
import { harmonyKey } from '../../harmony/key';
import { keyMode } from '../../harmony/scale';
import { symbolOf } from '../../ops/chords';
import { harmonyVoices } from '../../query/harmony-voices';
import type { ChordEvent } from '../../model/types';
import { PITCHED_ROLES, rangeTicks, type SongFacts } from '../song-facts';
import { byAmount, keyChangeIn, tempoChangeIn, type KeyChange } from '../words';
import type { BarRange, OfflineAction, Rule, RuleContext, RuleResult } from '../types';

/** Finest chord spacing the typed chord line can express, in bars. */
const CHORD_GRIDS = [1, 0.5, 0.25] as const;
/** How far one move shifts a recorded vocal at most (cents): the channel pitch limit. */
const MAX_PITCH_CENTS = 2400;

/** A chord track typed again, shifted: the text, how many bars each name lasts and the bar it starts at. */
interface ChordLine {
  text: string;
  barsPerChord: number;
  fromBar: number;
}

/** The chord track (inside a range) as typed text with every chord moved by `semitones`; null when its chords do not sit on a bar grid. */
function shiftedChordLine(facts: SongFacts, semitones: number, flats: boolean, range: BarRange | null): ChordLine | null {
  const limits = range ? rangeTicks(facts, range) : { from: 0, to: Infinity };
  const events: readonly ChordEvent[] = chordsSorted(facts.project).filter((event) => event.tick >= limits.from && event.tick + event.length <= limits.to);
  if (events.length === 0) return null;
  const grid = CHORD_GRIDS.find((size) => events.every((event) => event.tick % (size * facts.barTicks) === 0 && event.length % (size * facts.barTicks) === 0));
  if (grid === undefined) return null;
  const slot = grid * facts.barTicks;
  const first = events[0] as ChordEvent;
  const names: string[] = [];
  for (const event of events) {
    const expected = first.tick + names.length * slot;
    // A gap in the track cannot be typed as a chord line: leave the chord track alone.
    if (event.tick > expected) return null;
    names.push(formatChord(transposeChord(symbolOf(event), semitones), flats));
    for (let held = event.tick + slot; held < event.tick + event.length; held += slot) names.push('.');
  }
  return { text: names.join(' | '), barsPerChord: grid, fromBar: Math.round(first.tick / facts.barTicks) + 1 };
}

/** The key text the `song` action reads ("F minor"). */
function keyText(root: number, scale: string): string {
  const flats = keyUsesFlats(root, keyMode(scale));
  return `${pitchName(root, flats)} ${scale}`;
}

/** The semitones that move one key to another by the shortest way (−6 … +5). */
function shortestShift(from: number, to: number): number {
  return ((mod12(to - from) + 6) % 12) - 6;
}

function changeKey(context: RuleContext, change: KeyChange): RuleResult {
  const { facts, scope } = context;
  const current = harmonyKey(facts.project, facts.roles);
  let semitones: number;
  let target: { root: number; scale: string };
  if (change.kind === 'shift') {
    semitones = change.semitones;
    target = { root: mod12(current.root + semitones), scale: current.scale };
  } else {
    if (current.from === 'default') {
      return { reply: 'I can not tell what key the song is in now, so I can not move it to another. Say how far to move it instead ("up 2 semitones").' };
    }
    const wantedMinor = change.minor;
    if (wantedMinor !== null && wantedMinor !== (keyMode(current.scale) === 'minor')) {
      return { reply: `The song is in a ${keyMode(current.scale)} key now. Changing between major and minor changes the chords and the notes, not just their height: ask for new chords ("change the chords") or move it by a number of semitones.` };
    }
    semitones = shortestShift(current.root, change.root);
    target = { root: change.root, scale: current.scale };
  }
  if (semitones === 0 && !(change.kind === 'shift' && change.semitones !== 0)) return { reply: 'The song is in that key already.' };
  const actions: OfflineAction[] = [];
  const isWholeKey = !scope.isNamed && semitones % 12 !== 0;
  if (isWholeKey && current.from !== 'default') actions.push({ op: 'song', key: keyText(target.root, target.scale) });
  const flats = keyUsesFlats(target.root, keyMode(target.scale));
  let chordsNote = '';
  if (semitones % 12 !== 0) {
    const range = scope.isNamed ? (scope.ranges[0] ?? null) : null;
    const line = shiftedChordLine(facts, semitones, flats, range);
    if (line) actions.push({ op: 'chords', action: 'set', text: line.text, bars_per_chord: line.barsPerChord, from_bar: line.fromBar });
    else if (chordsSorted(facts.project).length > 0) chordsNote = ' The chord track is not on a bar grid, so I left it as it is.';
  }
  const channels = channelsPlaying(facts, PITCHED_ROLES);
  const { parts, skipped } = patternParts(context, channels);
  for (const part of parts) {
    actions.push({ op: 'note_tool', tool: 'agstudio.notes.transpose', pattern: part.pattern, channel: part.channel, params: [{ name: 'semitones', value: semitones }] });
  }
  if (!scope.isNamed) {
    for (const id of facts.project.channelOrder) {
      const channel = facts.project.channels[id];
      if (channel?.kind !== 'audioClip' || facts.roles.get(id) !== 'vox') continue;
      const cents = Math.max(-MAX_PITCH_CENTS, Math.min(MAX_PITCH_CENTS, (channel.pitch ?? 0) + semitones * 100));
      actions.push({ op: 'edit_channel', channel: id, pitch_cents: cents });
    }
    if (harmonyVoices(facts.project).length > 0) actions.push({ op: 'update_harmonies' });
  }
  if (actions.length === 0) return { reply: 'There are no pitched parts to move: the song has no bass, chords or lead notes.' };
  const direction = semitones >= 0 ? 'up' : 'down';
  const amount = Math.abs(semitones);
  const to = isWholeKey ? ` to ${keyText(target.root, target.scale)}` : '';
  const what = scope.isNamed ? `the notes in ${scope.label}` : 'the pitched parts';
  const keepsKey = scope.isNamed ? ' The song key stays as it is, since it belongs to the whole song.' : '';
  return {
    message: `Moved ${what} ${direction} ${amount} semitone${amount === 1 ? '' : 's'}${to}.${keepsKey}${chordsNote}${skippedLine(skipped)}`,
    actions,
  };
}

function changeTempo(context: RuleContext): RuleResult {
  const { facts, text, amount } = context;
  const bpm = facts.project.transport.bpm;
  const change = tempoChangeIn(text, bpm, amount);
  if (!change) return { reply: 'Say the tempo you want ("set the tempo to 120") or how much faster or slower.' };
  if (change.bpm === Math.round(bpm)) return { reply: `The tempo is ${change.bpm} BPM already.` };
  return { message: `Set the tempo to ${change.summary} (it was ${oneDecimal(bpm)} BPM).`, actions: [{ op: 'song', bpm: change.bpm }] };
}

const SWING_WORDS = /\b(?:swing|swung|shuffle|shuffled)\b/;

function changeSwing(context: RuleContext): RuleResult {
  const { facts, text, amount } = context;
  const current = facts.project.transport.swing;
  const named = /(\d{1,3})\s*%\s*swing|swing\s*(?:of |to |at |=)?\s*(\d{1,3})\s*%?/.exec(text);
  let swing: number;
  if (named) swing = Number(named[1] ?? named[2]) / 100;
  else if (/\b(?:no|zero|remove|straight|straighten|without)\b/.test(text)) swing = 0;
  else {
    const step = byAmount(amount, [0.08, 0.15, 0.3]);
    const less = /\b(?:less|reduce|lower|tighter|tighten|decrease|fewer)\b/.test(text);
    swing = less ? current - step : Math.max(current, 0.05) + step;
  }
  swing = Math.max(0, Math.min(1, Math.round(swing * 100) / 100));
  if (swing === current) return { reply: `The swing is already ${Math.round(swing * 100)} %.` };
  return { message: `Set the swing to ${Math.round(swing * 100)} % (it was ${Math.round(current * 100)} %).`, actions: [{ op: 'song', swing }] };
}

/** Key, tempo and swing. */
export const KEY_TEMPO_RULES: readonly Rule[] = [
  {
    id: 'key',
    matches: (text) => keyChangeIn(text) !== null,
    run: (context) => changeKey(context, keyChangeIn(context.text) as KeyChange),
  },
  {
    id: 'tempo',
    // "faster hats" is about the hats, not the tempo.
    matches: (text) => tempoChangeIn(text, 120, 'medium') !== null && !/\b(?:hi-?hats?|hats?|drums?|rolls?|fills?|melody|lead)\b/.test(text),
    run: changeTempo,
    needsSong: false,
  },
  { id: 'swing', matches: (text) => SWING_WORDS.test(text), run: changeSwing, needsSong: false },
];
