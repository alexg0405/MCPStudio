/** Mixing by role: setting up the buses and master chain (setup_mix), leveling the mix (level_mix). */
import { inferStyle, isStyle, STYLES, type Style } from '@core/beat/style';
import type { Project } from '@core/model/types';
import { mixRoles } from '../../mix/layout';
import { pinnedFor } from '../../mix/level-step';
import { setupMix } from '../../mix/setup';
import * as S from '../schema/parts';
import { beatAnswerState } from './beat';
import type { OpContext, OpModule } from './context';
import type { AfterEdit } from './types';
import { num, str } from './values';

const STYLE = {
  type: 'string',
  enum: [...STYLES],
  description: 'The song’s style (leave it out to have it guessed from the tempo, swing and drums).',
};

const styleOf = (raw: unknown, c: OpContext): Style => {
  const s = str(raw)?.toLowerCase();
  return isStyle(s) ? s : inferStyle(c.project as Project);
};

export const mix: OpModule = {
  schemas: [
    S.op(
      'setup_mix',
      'Sets up the mix by role: buses (Kick, Drums, 808, Chords, Lead, FX) with their effects, Reverb and Delay returns, the 808 ducking under the kick, and a master chain ending in a Limiter at −1 dB. Reuses what is there; safe to repeat.',
      {
        style: STYLE,
        mode: {
          type: 'string',
          enum: ['rebuild', 'fill-gaps'],
          description:
            'rebuild: every channel goes to its bus and every bus gets its fader (a song built in this answer; the default after a beat in it). fill-gaps: only what is missing, and only channels still on the master move (the default otherwise).',
        },
        level: S.bool('Also level the mix afterwards (as level_mix does).'),
      },
    ),
    S.op(
      'level_mix',
      'Levels the mix after the edit, before anything plays: renders the busiest part, sets each bus fader to the style’s balance around the kick and the master Limiter to the style’s loudness. One undo step with the answer.',
      {
        style: STYLE,
        from_bar: S.int('Listen from this bar (1-based; default: the busiest section, or the part being worked on).'),
        bars: S.int('How many bars to listen to (1–16, default 8).'),
      },
    ),
  ],
  prompt: {
    id: 'mix',
    order: 25,
    text: `Mixing by role (setup_mix, level_mix):
- A new song built from beats without an arrange action gets its mix set up: end the answer with setup_mix with its style and level: true. An arrange action already sets up and levels the mix itself (its mix is auto), so don't add setup_mix after it. Every channel goes to a bus by role (Kick, Drums, 808, Chords, Lead, FX) with EQ, glue and saturation, the 808 and the chords duck under the kick, Chords and Lead send to Reverb and Delay returns, and the master gets EQ, tape and a Limiter (−1 dB, true peak). It reuses buses that exist and empty Insert tracks, so repeating it changes nothing. The Chords and Lead buses' EQ Pro band 1 (high-pass) and band 8 (low-pass) are what filter sweeps automate.
- level (or level_mix on its own) then listens to the busiest part and sets each bus fader to the style's balance around the kick and the Limiter's input so the master reaches the style's loudness (trap about −10 LUFS, lo-fi −13, big room −8.5, trance and drum & bass −9, dubstep −8.5, the house styles −9.5 to −10); a loudness the Limiter can't give cleanly also gets a Maximizer before it (a limiter plus a gentle soft clip on the peaks). In the dance styles the chords duck hard under the kick (the sidechained pads of big room and trance, the 1/8 wobble of future bass). It runs after your edit and before playback, in the same undo step. Faders you set yourself in the answer stay where you put them; leave the rest to it. A song without role buses (mixed by hand) keeps its balance: level_mix then only sets its loudness, moving everything into the master together.
- "Mix it", "balance it", "make it louder": setup_mix (when the song has no buses yet) and level_mix. "Check my mix", "what's wrong with my mix", a specific problem (muddy, harsh, the bass masks the kick): analyze_mix, then fix it by hand with the measurements. Don't send analyze_mix and level_mix in one answer; after a level_mix, change faders only when asked.
- Space and echo: route tracks to the Reverb and Delay returns (route with a level_db) instead of adding a Reverb or Delay to every track. Every reverb, delay and wavetable voice costs the audio thread, and songs with many of them crackle; one or two shared returns sound more together anyway.
- Never put a hard-clip Saturator (mode clip) or heavy drive on the master: clipping the whole mix sounds like static and breaking up. On the master use tape at 2–3 dB drive at most, and leave loudness to the Limiter and Maximizer (level_mix sets them; don't add your own clipper or a Maximizer).`,
  },
  handlers: {
    setup_mix: (a, c) => {
      const style = styleOf(a.style, c);
      const beats = beatAnswerState(c.state);
      const mode = a.mode === 'rebuild' || a.mode === 'fill-gaps' ? a.mode : beats.count > 0 ? 'rebuild' : 'fill-gaps';
      const res = setupMix(c.d, c.s, {
        style,
        mode,
        roles: mixRoles(c.project),
        pinned: c.state.pinnedInserts,
        pinnedChannels: beats.levels,
      });
      if (a.level === true) c.state.after.push({ kind: 'level_mix', style });
      return res.changes.length ? res.changes.join('; ') : 'The mix was already set up';
    },
    level_mix: (a, c) => {
      const style = styleOf(a.style, c);
      const bar = c.bar();
      const fromBar = num(a.from_bar);
      const bars = num(a.bars);
      // In a part of the song: that part.
      const part = c.focus.range();
      const fromTick = fromBar !== undefined ? (Math.max(1, Math.round(fromBar)) - 1) * bar : part?.from;
      const length = bars !== undefined ? Math.round(bars) : part ? Math.round((part.to - part.from) / bar) : undefined;
      c.state.after.push({
        kind: 'level_mix',
        style,
        ...(fromTick !== undefined ? { fromTick } : {}),
        ...(length !== undefined ? { bars: Math.max(1, Math.min(16, length)) } : {}),
      });
      return null;
    },
  },
  beforeCommit(c) {
    // One leveling per answer (the last request, whoever made it), leaving the AI's own faders alone.
    const items = c.state.after.filter((x): x is Extract<AfterEdit, { kind: 'level_mix' }> => x.kind === 'level_mix');
    for (const it of items.slice(0, -1)) c.state.after.splice(c.state.after.indexOf(it), 1);
    const last = items.at(-1);
    // A loudness asked for (match_reference) outlives the arranger's own leveling request.
    const asked = items.find((x) => x.targetLufs !== undefined)?.targetLufs;
    if (last && asked !== undefined) last.targetLufs = asked;
    if (last) pinnedFor.set(last, new Set(c.state.pinnedInserts));
  },
};
