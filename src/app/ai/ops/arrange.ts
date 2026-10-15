/**
 * Song craft: arranging a whole song from sections (arrange), adding fills and transitions to an
 * existing one (develop), one boundary (transition), one spot (vary). The AI decides the structure
 * (sections, which beats play, the energy); the arranger (`core/arrange`, `app/arrange`) does the
 * craft: variations every 4 and 8 bars, fills that replace the groove, gaps, risers, impacts,
 * crashes, sweeps and the ending.
 */
import { notesHash } from '@core/arrange/notes';
import { partName } from '@core/arrange/roles';
import {
  DEFAULT_ENERGY,
  FILL_CHOICES,
  isSectionRole,
  roleFromName,
  SECTION_ROLES,
  TRANSITION_CHOICES,
  VARY_MODES,
  type FillChoice,
  type SectionSpec,
  type TransitionChoice,
  type VaryMode,
} from '@core/arrange/sections';
import { refreshVariants } from '@core/arrange/apply';
import { inferStyle, isStyle, STYLES, type Style } from '@core/beat/style';
import type { PatternId, Project } from '@core/model/types';
import { variantEnvFor } from '../../arrange/env';
import {
  ArrangeInputError,
  arrangeInDraft,
  developInDraft,
  transitionInDraft,
  TRANSITION_KINDS,
  VARY_KINDS,
  varyInDraft,
  type RunResult,
  type TransitionKind,
  type VaryKind,
} from '../../arrange/run';
import * as S from '../schema/parts';
import { SONG_CRAFT } from './arrange-prompt';
import { beatAnswerState } from './beat';
import { fail, type OpContext, type OpModule } from './context';
import { bool, isObj, num, str } from './values';

const MAX_SECTIONS = 24;
const MAX_BARS = 512;

const SECTION = {
  type: 'object',
  additionalProperties: false,
  description: 'One section of the song.',
  properties: {
    name: S.str('Its marker name, e.g. "Intro", "Verse 2", "Drop".'),
    bars: S.int('Length in bars, 1–64 (4, 8 or 16 make clean phrases).'),
    role: {
      type: 'string',
      enum: [...SECTION_ROLES],
      description: 'What part of the song it is (default: from its name).',
    },
    energy: S.int('1 (sparse) … 5 (everything playing). Default by role: intro 1, verse 3, build 3, drop 5, break 2, outro 1.'),
    play: {
      type: 'array',
      description: 'The patterns that play in it: usually one beat (by @ref, name or id), plus a melody pattern if it has its own.',
      items: S.PATTERN,
    },
    without: {
      type: 'array',
      description: 'Parts left out of its patterns: kick, snare, hats, perc, drums, 808, bass, chords, lead, music, or channel names.',
      items: { type: 'string' },
    },
    vary: {
      type: 'string',
      enum: [...VARY_MODES],
      description: 'auto (default): a fill every 8 bars and a small change every 4; more: a change every 2 bars; less: fills only; none: the loop as written.',
    },
    transition_in: {
      type: 'string',
      enum: [...TRANSITION_CHOICES],
      description: 'How it is entered (default auto: from the energy change, a build into a drop is a rise); none: a hard cut.',
    },
    fill: { type: 'string', enum: [...FILL_CHOICES], description: 'The fills it uses (default auto: they rotate by style).' },
  },
  required: ['name', 'bars', 'play'],
};

const STYLE = { type: 'string', enum: [...STYLES], description: 'Genre (default: read from the tempo and the beats).' };

const lineup = (r: RunResult, c: OpContext): string | null => {
  for (const w of r.warnings) c.warn(w);
  if (r.touched) c.touch(r.touched.from, r.touched.to, r.clipIds);
  if (r.touched || r.clipIds.length) c.state.after.push({ kind: 'mode', mode: 'song' });
  // The summary first, then the details.
  for (const line of r.changes) c.note(line);
  return null;
};

/** Runs an arranger operation; its input errors become the action's warning. */
function guarded<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof ArrangeInputError) return fail(e.message);
    throw e;
  }
}

/** A part name or a channel, as given ("hats", "808", "Bell", ch_…). */
function part(raw: unknown, c: OpContext, where: string): string {
  const text = str(raw) ?? fail(`${where}: a part to leave out has no name`);
  const named = partName(text);
  if (named) return named;
  try {
    return c.channel(text);
  } catch {
    return fail(`${where}: "${text}" is neither a part (kick, snare, hats, drums, 808, bass, chords, lead…) nor a channel`);
  }
}

const styleOf = (a: Record<string, unknown>, p: Project): Style => (isStyle(a.style) ? a.style : inferStyle(p));

export const arrange: OpModule = {
  schemas: [
    S.op(
      'arrange',
      'Lays out a whole song (or a part of one) from sections in ONE action: each section plays the beats you give it, and the arranger adds what makes it flow: fills every 8 bars and changes every 4 (as variants of your beats), gaps before drops, risers, reverse crashes, impacts, downlifters, crashes, filter sweeps, markers and the ending. Arranging again replaces your earlier arrangement.',
      {
        from_bar: S.int('1-based bar where the first section starts (default 1; with replace false, after the song).'),
        replace: S.bool('Clear the playlist over the arrangement first (default true).'),
        style: STYLE,
        sections: { type: 'array', description: `In song order, up to ${MAX_SECTIONS} sections and ${MAX_BARS} bars.`, items: SECTION },
        fx: {
          type: 'string',
          enum: ['auto', 'light', 'none'],
          description: 'Transition sounds and sweeps: auto (default), light (only into drops), none (fills, gaps and crashes stay).',
        },
        mix: {
          type: 'string',
          enum: ['auto', 'keep'],
          description: 'auto (default): set up the mix by role for the song (buses, levels); keep: leave the mixer as it is.',
        },
        outro: {
          type: 'string',
          enum: ['auto', 'fade', 'stop'],
          description: 'How it ends: auto (a stop for trap, drill, boom bap and reggaeton, else a fade), fade, or stop.',
        },
      },
      ['sections'],
    ),
    S.op(
      'develop',
      'Develops a song that already exists, in place: fills every 8 bars and changes every 4 (variants of the clips there), transitions between its sections (gaps, risers, impacts, crashes, sweeps), keeping FX and fills already there. Cleanup also removes stacked copies and makes fills on their own track replace the drums under them.',
      {
        from_bar: S.int('1-based first bar (default: the part asked about, or 1).'),
        to_bar: S.int('1-based last bar, inclusive (default: the song’s end).'),
        fills: S.bool('Fills and small changes inside sections (default true).'),
        transitions: S.bool('Transitions between sections and the ending (default true).'),
        fx: S.bool('Transition sounds and sweeps (default true).'),
        cleanup: S.bool('Remove stacked copies, make layered fills replace the groove, move per-loop crashes out (default true).'),
        style: STYLE,
      },
    ),
    S.op(
      'transition',
      'One transition into a bar: the whole recipe its sections call for (auto), a kind (rise, lift, same, dip, fall), or one element: fill, gap, riser, reverse_crash, impact, downlifter, crash, filter_open, filter_close, reverb_throw.',
      {
        bar: S.int('The 1-based bar it leads into (the downbeat).'),
        kind: { type: 'string', enum: [...TRANSITION_KINDS], description: 'Default auto.' },
        bars: S.num('Riser, downlifter or filter length in bars.'),
        beats: S.num('Fill or gap length in beats.'),
        style: STYLE,
      },
      ['bar'],
    ),
    S.op(
      'vary',
      'One variation: at the end of a bar (fill, hat_roll, 808_slide, dropout, stutter), over bars (thin, double_hats, without), a crash at a bar, or a variant of a pattern (with pattern and ref, placed later). Only the clips there change (each gets its own variant).',
      {
        kind: { type: 'string', enum: [...VARY_KINDS] },
        bar: S.int('The 1-based bar whose end gets it (crash: whose start).'),
        from_bar: S.int('With to_bar: 1-based first bar of a range.'),
        to_bar: S.int('Last bar of the range, inclusive.'),
        pattern: { ...S.PATTERN, description: 'Instead of a bar: make a variant of this pattern (not placed); give it a ref.' },
        track: S.int('Only clips on this 1-based playlist track.'),
        channels: { type: 'array', items: { type: 'string' }, description: 'without: parts or channels to leave out.' },
        beats: S.num('Fill, dropout or stutter length in beats (default 2 for fills and dropouts, else 1).'),
        level: S.int('thin: 1 (lighter) or 2 (sparse).'),
        ref: S.REF,
        style: STYLE,
      },
      ['kind'],
    ),
  ],
  prompt: { id: 'song-craft', order: 20, text: SONG_CRAFT },
  handlers: {
    arrange: (a, c) => {
      const { d } = c;
      const bar = c.bar();
      const raw = Array.isArray(a.sections) ? a.sections.filter(isObj) : [];
      if (!raw.length) fail('it needs its sections');
      if (raw.length > MAX_SECTIONS) fail(`an arrangement holds up to ${MAX_SECTIONS} sections`);
      // Every reference first: nothing changes when one is wrong.
      const sections: SectionSpec[] = raw.map((x, i) => {
        const name = (str(x.name) ?? `Section ${i + 1}`).slice(0, 40);
        const bars = Math.max(1, Math.min(64, Math.round(num(x.bars) ?? 8)));
        const role = isSectionRole(x.role) ? x.role : (roleFromName(name) ?? 'verse');
        const playRaw = Array.isArray(x.play) ? x.play : [];
        if (!playRaw.length) fail(`“${name}” plays nothing (give it a beat in play)`);
        const play = playRaw.map((r) => {
          try {
            return c.pattern(r);
          } catch (e) {
            return fail(`“${name}”: ${(e as Error).message}`);
          }
        }) as PatternId[];
        const without = (Array.isArray(x.without) ? x.without : []).map((w) => part(w, c, `“${name}”`));
        const energy = Math.max(1, Math.min(5, Math.round(num(x.energy) ?? DEFAULT_ENERGY[role])));
        const vary = (VARY_MODES as readonly string[]).includes(String(x.vary)) ? (x.vary as VaryMode) : 'auto';
        const transitionIn = (TRANSITION_CHOICES as readonly string[]).includes(String(x.transition_in))
          ? (x.transition_in as TransitionChoice)
          : 'auto';
        const fill = (FILL_CHOICES as readonly string[]).includes(String(x.fill)) ? (x.fill as FillChoice) : 'auto';
        return { name, bars, role, energy, play, without, vary, transitionIn, fill };
      });
      const total = sections.reduce((n, x) => n + x.bars, 0);
      if (total > MAX_BARS) fail(`an arrangement holds up to ${MAX_BARS} bars (these sections add up to ${total})`);
      const replace = bool(a.replace) ?? true;
      const focus = c.focus.range();
      const fromBar = num(a.from_bar);
      const from = fromBar !== undefined ? Math.max(0, Math.round(fromBar - 1)) * bar : focus?.from;
      const fx = a.fx === 'light' || a.fx === 'none' ? a.fx : 'auto';
      const mix = a.mix === 'keep' ? 'keep' : 'auto';
      const ending = a.outro === 'fade' || a.outro === 'stop' ? a.outro : 'auto';
      const res = guarded(() =>
        arrangeInDraft(
          d,
          c.s,
          c.base,
          {
            ...(from !== undefined ? { from } : {}),
            replace,
            style: styleOf(a, c.project),
            sections,
            fx,
            mix,
            ending,
            // Levels the AI set in this answer (faders, beat tracks) stay as it set them.
            pinned: { inserts: c.state.pinnedInserts, channels: beatAnswerState(c.state).levels },
          },
          (f, t, what) => c.focus.span(f, t, what),
        ),
      );
      if (mix === 'auto') c.state.after.push({ kind: 'level_mix', style: res.style, fromTick: res.plan.from, bars: total });
      return lineup(res, c);
    },

    develop: (a, c) => {
      const bar = c.bar();
      const focus = c.focus.range();
      const fromBar = num(a.from_bar);
      const toBar = num(a.to_bar);
      const res = guarded(() =>
        developInDraft(
          c.d,
          c.s,
          c.base,
          {
            ...(fromBar !== undefined ? { from: Math.max(0, Math.round(fromBar - 1)) * bar } : focus ? { from: focus.from } : {}),
            ...(toBar !== undefined ? { to: Math.max(1, Math.round(toBar)) * bar } : focus ? { to: focus.to } : {}),
            fills: bool(a.fills) ?? true,
            transitions: bool(a.transitions) ?? true,
            fx: bool(a.fx) ?? true,
            cleanup: bool(a.cleanup) ?? true,
            style: styleOf(a, c.project),
          },
          (f, t, what) => c.focus.span(f, t, what),
        ),
      );
      return lineup(res, c);
    },

    transition: (a, c) => {
      const bar = c.bar();
      const at = num(a.bar) ?? fail('which bar does it lead into?');
      const kind = (TRANSITION_KINDS as readonly string[]).includes(String(a.kind ?? 'auto')) ? ((a.kind ?? 'auto') as TransitionKind) : fail(`unknown transition "${String(a.kind)}"`);
      const res = guarded(() =>
        transitionInDraft(
          c.d,
          c.s,
          c.base,
          {
            at: Math.max(0, Math.round(at - 1)) * bar,
            kind,
            ...(num(a.bars) !== undefined ? { bars: num(a.bars)! } : {}),
            ...(num(a.beats) !== undefined ? { beats: num(a.beats)! } : {}),
            style: styleOf(a, c.project),
          },
          (f, t, what) => c.focus.span(f, t, what),
        ),
      );
      for (const w of res.warnings) fail(w);
      return lineup(res, c);
    },

    vary: (a, c) => {
      const kind = (VARY_KINDS as readonly string[]).includes(String(a.kind)) ? (a.kind as VaryKind) : fail(`unknown variation "${String(a.kind)}"`);
      const pattern = a.pattern !== undefined ? c.focus.writable(c.pattern(a.pattern)) : undefined;
      const focus = c.focus.range();
      const bars = (t: number) => Math.round(t / c.bar());
      const lane = a.track !== undefined ? c.lane(a.track) : undefined;
      const parts = Array.isArray(a.channels) ? a.channels.map((x) => part(x, c, 'without')) : undefined;
      // In a part of the song, it goes at the part's end (or over the part).
      const range =
        num(a.bar) !== undefined || num(a.from_bar) !== undefined || pattern || !focus
          ? {}
          : kind === 'thin' || kind === 'double_hats' || kind === 'without'
            ? { fromBar: bars(focus.from) + 1, toBar: bars(focus.to) }
            : { bar: bars(focus.to) };
      const res = guarded(() =>
        varyInDraft(
          c.d,
          c.s,
          c.base,
          {
            kind,
            ...(num(a.bar) !== undefined ? { bar: Math.round(num(a.bar)!) } : {}),
            ...(num(a.from_bar) !== undefined ? { fromBar: Math.round(num(a.from_bar)!) } : {}),
            ...(num(a.to_bar) !== undefined ? { toBar: Math.round(num(a.to_bar)!) } : {}),
            ...range,
            ...(pattern ? { pattern } : {}),
            ...(lane ? { lane } : {}),
            ...(parts ? { parts } : {}),
            ...(num(a.beats) !== undefined ? { beats: num(a.beats)! } : {}),
            ...(num(a.level) !== undefined ? { level: num(a.level)! } : {}),
            style: styleOf(a, c.project),
          },
          (f, t, what) => c.focus.span(f, t, what),
        ),
      );
      if (res.variant) c.remember(a.ref, { kind: 'pattern', id: res.variant });
      return lineup(res, c);
    },
  },
  // Variants follow their source: an answer that changed a source rebuilds its unmodified variants.
  beforeCommit: (c) => {
    const d = c.d;
    const sources = new Set<PatternId>();
    for (const pid of d.patternOrder) {
      const from = d.patterns[pid]?.derived?.from;
      if (!from || sources.has(from) || !d.patterns[from]) continue;
      const before = c.base.patterns[from];
      if (!before || notesHash(before.notes) !== notesHash(d.patterns[from]!.notes as Project['patterns'][PatternId]['notes'])) sources.add(from);
    }
    if (!sources.size) return;
    const p = c.project;
    const r = refreshVariants(d, variantEnvFor(p, inferStyle(p)), sources);
    if (r.rebuilt.length)
      c.note(
        `Rebuilt ${r.rebuilt.length} variation${r.rebuilt.length === 1 ? '' : 's'} of ${[...sources].map((x) => `“${p.patterns[x]?.name ?? '?'}”`).join(', ')} to follow the new notes${
          r.handEdited.length ? ` (${r.handEdited.length} edited by hand stay as they are)` : ''
        }`,
      );
  },
};

