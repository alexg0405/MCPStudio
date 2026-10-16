/**
 * DJ live decks for the Studio: load a song on a deck, play or pause it, sync, crossfade over some beats, set the
 * mixer knobs (EQ, filter, volume, trim, key lock, pitch), loop, and start or stop the recording of the master.
 * Decks are live performance state, not part of the project, so none of these edit the document: they become one
 * `decks` request that runs after the answer (`runDeckActions`).
 */
import { AUTO_LOOP_BEATS } from '@core/dj/decks-math';
import { DECK_IDS, type DeckId, type DecksApi } from '../../dj/decks-api';
import { findSongs, library, type LibrarySong } from '../../dj/library';
import type { Services } from '../../services';
import type { AiAnswer } from '../schema';
import * as S from '../schema/parts';
import type { AnswerState, OpModule } from './context';
import { bool, lower, num, str } from './values';

export type DeckAction =
  | { do: 'load'; deck: DeckId; song: LibrarySong }
  | { do: 'play'; deck: DeckId; on: boolean }
  | { do: 'sync'; deck: DeckId; on: boolean }
  | {
      do: 'set';
      deck: DeckId;
      volume?: number;
      trimDb?: number;
      eq?: { low?: number; mid?: number; high?: number };
      filter?: number;
      keyLock?: boolean;
      pitch?: number;
      cue?: boolean;
    }
  | { do: 'crossfade'; to: number; beats: number }
  | { do: 'loop'; deck: DeckId; beats: number | null }
  | { do: 'record'; on: boolean };

const DECK = { type: 'string', enum: ['A', 'B', 'C', 'D'], description: 'Which deck (A and B are the two shown by default).' };

export const decks: OpModule = {
  schemas: [
    S.op(
      'deck_load',
      'Puts a song from the music library on a DJ deck (live decks, not the playlist), ready to play.',
      { deck: DECK, song: S.str('A song title (or part of it) from <music-library>.') },
      ['deck', 'song'],
    ),
    S.op('deck_play', 'Plays or pauses a DJ deck.', { deck: DECK, action: { type: 'string', enum: ['play', 'pause'] } }, ['deck', 'action']),
    S.op(
      'deck_sync',
      'Syncs a DJ deck to the other deck: it matches the tempo (half and double time too) and the beat and stays locked, so the two songs can be blended. on false lets go.',
      { deck: DECK, on: S.bool('Default true.') },
      ['deck'],
    ),
    S.op(
      'deck_set',
      'Sets a deck’s mixer knobs: the 3-band kill EQ (dB, −26 kills the band, up to +6), the one-knob filter, the channel volume, trim, key lock, pitch and the headphone cue. Only what you give is changed.',
      {
        deck: DECK,
        eq_low_db: S.num('Bass, −26…+6 dB (−26 kills it; 0 is flat).'),
        eq_mid_db: S.num('Mids, −26…+6 dB.'),
        eq_high_db: S.num('Treble, −26…+6 dB.'),
        filter: S.num('−1…1: below 0 closes a low-pass (muffled), above 0 opens a high-pass (thin), 0 = off.'),
        volume: S.num('Channel fader 0…1.25 (1 = 0 dB).'),
        trim_db: S.num('Trim −12…+12 dB.'),
        key_lock: S.bool('Keep the pitch when the tempo changes.'),
        pitch_percent: S.num('Tempo change in percent, e.g. 3 for 3 % faster, −2.5 for slower (up to ±50).'),
        cue: S.bool('Send this deck to the headphone cue.'),
      },
      ['deck'],
    ),
    S.op(
      'deck_crossfade',
      'Moves the DJ crossfader: to side A or B (or a position −1…1), instantly or as a fade over a number of beats of the tempo playing, the way a DJ blends one song into the next.',
      {
        to: { anyOf: [{ type: 'string', enum: ['A', 'B', 'center'] }, { type: 'number' }], description: '"A", "B", "center" or a position −1 (all A) … 1 (all B).' },
        beats: S.num('Fade over this many beats (e.g. 16 or 32 for a long blend); 0 or leave out to jump.'),
      },
      ['to'],
    ),
    S.op(
      'deck_loop',
      'Loops a DJ deck: an auto loop of this many beats (1/4 … 32) from the beat it is on, or off to leave the loop.',
      { deck: DECK, beats: { anyOf: [{ type: 'number' }, { type: 'string', enum: ['off'] }], description: `Loop length in beats (${AUTO_LOOP_BEATS.join(', ')}) or "off".` } },
      ['deck', 'beats'],
    ),
    S.op(
      'deck_record',
      'Starts or stops recording what the DJ decks play; stopping adds the recording to the music library as “Live mix …”.',
      { action: { type: 'string', enum: ['start', 'stop'] } },
      ['action'],
    ),
  ],
  prompt: {
    id: 'decks',
    order: 23,
    text: `DJ live decks (deck_load, deck_play, deck_sync, deck_set, deck_crossfade, deck_loop, deck_record):
- The DJ decks play songs LIVE from the music library (<music-library>), separate from the project and the playlist: use them when asked to DJ, "put X on deck A", "play it live", "blend into the next song", "kill the bass", "loop the drop", "record my set". For a finished, exported mix on the playlist use dj_mix instead.
- A typical blend: deck_load the next song on the idle deck, deck_play it, deck_sync it to the playing one, deck_set its eq_low_db to −26 (so the bass doesn't double), then deck_crossfade to the other side over 16 or 32 beats (the playing deck's tempo sets the beat length), then bring the bass over with deck_set on both decks.
- <decks> in the context lists what is on each deck (title, BPM, playing, synced, pitch, EQ) and the crossfader (−1 = all A, +1 = all B). Deck A sits on crossfader side A, deck B on side B.
- deck_set only changes what you give it. EQ is in dB (−26 = killed, 0 flat), filter −1…1, volume 0…1.25 (1 = 0 dB), pitch_percent is the tempo change.
- The decks need the song analyzed to sync or loop on the beat (a song with no clear beat can't sync); songs are analyzed when loaded.`,
  },
  handlers: {},
};

/** A deck letter from 'A'…'D' (any case) or 1…4. */
function deckOf(raw: unknown): DeckId | null {
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 1 && raw <= 4) return DECK_IDS[raw - 1] as DeckId;
  const t = str(raw)?.toUpperCase();
  return t && (DECK_IDS as readonly string[]).includes(t) ? (t as DeckId) : null;
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** Turns the answer's deck actions into one request that runs after it (the decks aren't in the project). */
export function decksAfter(_s: Services, answer: AiAnswer, state: AnswerState): void {
  const { warnings, after } = state;
  const actions: DeckAction[] = [];
  for (const a of answer.actions) {
    if (!a.op.startsWith('deck_')) continue;
    if (a.op === 'deck_crossfade') {
      const to = a.to === 'A' ? -1 : a.to === 'B' ? 1 : a.to === 'center' ? 0 : num(a.to);
      if (to === undefined) warnings.push('deck crossfade: to must be A, B, center or a number from −1 to 1');
      else actions.push({ do: 'crossfade', to: clamp(to, -1, 1), beats: clamp(num(a.beats) ?? 0, 0, 256) });
      continue;
    }
    if (a.op === 'deck_record') {
      if (a.action === 'start' || a.action === 'stop') actions.push({ do: 'record', on: a.action === 'start' });
      else warnings.push('deck record: action must be start or stop');
      continue;
    }
    const deck = deckOf(a.deck);
    if (!deck) {
      warnings.push(`${a.op.replace(/_/g, ' ')}: there is no deck “${String(a.deck)}” (A, B, C or D)`);
      continue;
    }
    switch (a.op) {
      case 'deck_load': {
        const name = str(a.song);
        if (!name) {
          warnings.push('deck load: which song?');
          break;
        }
        if (!library.getState().songs.length) {
          warnings.push('deck load: the music library is empty: add song files in the DJ window first (streaming services like Spotify can’t be used: their audio is locked)');
          break;
        }
        const { found } = findSongs([name]);
        if (!found[0]) warnings.push(`deck load: no song “${name}” in the music library`);
        else actions.push({ do: 'load', deck, song: found[0] });
        break;
      }
      case 'deck_play':
        if (a.action === 'play' || a.action === 'pause') actions.push({ do: 'play', deck, on: a.action === 'play' });
        else warnings.push('deck play: action must be play or pause');
        break;
      case 'deck_sync':
        actions.push({ do: 'sync', deck, on: bool(a.on) ?? true });
        break;
      case 'deck_set': {
        const set: Extract<DeckAction, { do: 'set' }> = { do: 'set', deck };
        const eq: NonNullable<typeof set.eq> = {};
        const low = num(a.eq_low_db);
        const mid = num(a.eq_mid_db);
        const high = num(a.eq_high_db);
        if (low !== undefined) eq.low = clamp(low, -26, 6);
        if (mid !== undefined) eq.mid = clamp(mid, -26, 6);
        if (high !== undefined) eq.high = clamp(high, -26, 6);
        if (Object.keys(eq).length) set.eq = eq;
        const filter = num(a.filter);
        if (filter !== undefined) set.filter = clamp(filter, -1, 1);
        const volume = num(a.volume);
        if (volume !== undefined) set.volume = clamp(volume, 0, 1.25);
        const trim = num(a.trim_db);
        if (trim !== undefined) set.trimDb = clamp(trim, -12, 12);
        const kl = bool(a.key_lock);
        if (kl !== undefined) set.keyLock = kl;
        const pitch = num(a.pitch_percent);
        if (pitch !== undefined) set.pitch = clamp(pitch / 100, -0.5, 0.5);
        const cue = bool(a.cue);
        if (cue !== undefined) set.cue = cue;
        if (Object.keys(set).length === 2) warnings.push('deck set: nothing to set (give eq_*_db, filter, volume, trim_db, key_lock, pitch_percent or cue)');
        else actions.push(set);
        break;
      }
      case 'deck_loop': {
        const b = typeof a.beats === 'string' && lower(a.beats) === 'off' ? null : num(a.beats);
        if (b === undefined) warnings.push('deck loop: beats must be a number or "off"');
        else actions.push({ do: 'loop', deck, beats: b === null || b <= 0 ? null : clamp(b, 1 / 32, 32) });
        break;
      }
    }
  }
  if (actions.length) after.push({ kind: 'decks', actions });
}

/** One plain line for what an action does (for the chat). */
export function describeDeckAction(a: DeckAction): string {
  switch (a.do) {
    case 'load':
      return `Deck ${a.deck}: loading “${a.song.label}”`;
    case 'play':
      return `Deck ${a.deck}: ${a.on ? 'play' : 'pause'}`;
    case 'sync':
      return `Deck ${a.deck}: ${a.on ? 'sync to the other deck' : 'sync off'}`;
    case 'set': {
      const parts: string[] = [];
      if (a.eq) for (const [k, v] of Object.entries(a.eq)) parts.push(`${k} ${v} dB`);
      if (a.filter !== undefined) parts.push(`filter ${a.filter}`);
      if (a.volume !== undefined) parts.push(`volume ${a.volume}`);
      if (a.trimDb !== undefined) parts.push(`trim ${a.trimDb} dB`);
      if (a.keyLock !== undefined) parts.push(`key lock ${a.keyLock ? 'on' : 'off'}`);
      if (a.pitch !== undefined) parts.push(`pitch ${Math.round(a.pitch * 1000) / 10}%`);
      if (a.cue !== undefined) parts.push(`headphone cue ${a.cue ? 'on' : 'off'}`);
      return `Deck ${a.deck}: ${parts.join(', ')}`;
    }
    case 'crossfade':
      return `Crossfader to ${a.to <= -0.99 ? 'A' : a.to >= 0.99 ? 'B' : a.to.toFixed(2)}${a.beats > 0 ? ` over ${a.beats} beats` : ''}`;
    case 'loop':
      return a.beats === null ? `Deck ${a.deck}: loop off` : `Deck ${a.deck}: loop ${a.beats} beats`;
    case 'record':
      return a.on ? 'Recording the decks' : 'Stopped recording';
  }
}

/** Runs deck actions in order; resolves with what went wrong (one line each). */
export async function runDeckActions(s: Services, actions: readonly DeckAction[]): Promise<string[]> {
  const problems: string[] = [];
  let api: DecksApi;
  try {
    api = await s.decks();
  } catch (e) {
    return [`The decks couldn’t start: ${e instanceof Error ? e.message : String(e)}`];
  }
  for (const a of actions) {
    try {
      switch (a.do) {
        case 'load':
          await api.load(a.deck, a.song.ref, a.song.title, a.song.artist);
          break;
        case 'play':
          if (a.on) api.play(a.deck);
          else api.pause(a.deck);
          break;
        case 'sync':
          api.sync(a.deck, a.on);
          break;
        case 'set':
          if (a.keyLock !== undefined) api.setKeyLock(a.deck, a.keyLock);
          if (a.pitch !== undefined) {
            const range = Math.abs(a.pitch) <= 0.08 ? 0.08 : Math.abs(a.pitch) <= 0.16 ? 0.16 : 0.5;
            if (api.store.getState().decks[a.deck].pitchRange < range) api.setPitchRange(a.deck, range);
            api.setPitch(a.deck, a.pitch);
          }
          if (a.eq?.low !== undefined) api.setEq(a.deck, 'low', a.eq.low);
          if (a.eq?.mid !== undefined) api.setEq(a.deck, 'mid', a.eq.mid);
          if (a.eq?.high !== undefined) api.setEq(a.deck, 'high', a.eq.high);
          if (a.filter !== undefined) api.setFilter(a.deck, a.filter);
          if (a.volume !== undefined) api.setVolume(a.deck, a.volume);
          if (a.trimDb !== undefined) api.setTrim(a.deck, a.trimDb);
          if (a.cue !== undefined) api.setCueListen(a.deck, a.cue);
          break;
        case 'crossfade':
          if (a.beats > 0 && api.crossfade) api.crossfade(a.to, a.beats);
          else api.setCrossfader(a.to);
          break;
        case 'loop':
          if (a.beats === null) api.exitLoop(a.deck);
          else api.autoLoop(a.deck, a.beats);
          break;
        case 'record':
          if (a.on) await api.startRecording();
          else await api.stopRecording();
          break;
      }
    } catch (e) {
      problems.push(`${describeDeckAction(a)}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return problems;
}

/** The decks for the Studio's context: what is on each deck and where the crossfader is. */
export function deckLines(s: Services): string[] {
  const api = s.decks.peek();
  if (!api) return [];
  const st = api.store.getState();
  const loaded = DECK_IDS.filter((id) => st.decks[id].song);
  if (!loaded.length) return [];
  const lines = [`<decks> (live DJ decks; crossfader ${Math.round(st.crossfader * 100) / 100}, −1 = all A, +1 = all B${st.recording ? '; recording' : ''}):`];
  for (const id of loaded) {
    const d = st.decks[id];
    const bits = [
      d.baseBpm === null ? 'no steady beat' : `${Math.round((d.bpm ?? d.baseBpm) * 10) / 10} BPM`,
      d.playing ? 'playing' : 'paused',
      ...(d.synced ? ['synced'] : []),
      ...(Math.abs(d.pitch) > 0.0005 ? [`pitch ${d.pitch > 0 ? '+' : ''}${Math.round(d.pitch * 1000) / 10}%`] : []),
      ...(d.keyLock ? ['key lock'] : []),
      ...(d.eq.low !== 0 || d.eq.mid !== 0 || d.eq.high !== 0 ? [`EQ low ${d.eq.low} mid ${d.eq.mid} high ${d.eq.high} dB`] : []),
      ...(d.loop?.active ? ['looping'] : []),
      `side ${st.crossfaderAssign[id]}`,
    ];
    lines.push(`- Deck ${id}: “${d.song!.title}”${d.song!.artist ? ` by ${d.song!.artist}` : ''}: ${bits.join(', ')}`);
  }
  lines.push('</decks>');
  return lines;
}
