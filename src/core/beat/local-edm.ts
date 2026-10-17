/**
 * The offline generator's EDM pack: the drum grids and the bass, chord and lead parts of big room,
 * progressive house, future bass, dubstep, melodic dubstep, tech house, trance and drum & bass.
 * General genre conventions only (tempo, where the kick and snare sit, how a bass moves, how chords are
 * played); the notes are chord tones on stock progressions, not any particular song's melody.
 */
import type { BeatNote, BeatTrack } from './spec';
import { STEPS_PER_BAR } from './spec';
import type { Style } from './style';
import { bassKey, chords, voice, type Progression } from './theory';

export type EdmStyle = 'bigroom' | 'proghouse' | 'futurebass' | 'dubstep' | 'melodicdub' | 'techhouse' | 'trance' | 'dnb';
export const EDM_STYLES: ReadonlySet<Style> = new Set<Style>([
  'bigroom',
  'proghouse',
  'futurebass',
  'dubstep',
  'melodicdub',
  'techhouse',
  'trance',
  'dnb',
] satisfies EdmStyle[]);
export const isEdmStyle = (s: Style): s is EdmStyle => EDM_STYLES.has(s);

/** Drum grids (see `DRUMS` in local.ts): one bar, 16 steps; X = accent, x = hit, o = ghost. */
export const EDM_DRUMS: Record<EdmStyle, Record<string, string>> = {
  // Four on the floor, a clap on 2 and 4 (the snare roll in builds is the arranger's), offbeat open hats.
  bigroom: {
    kick: 'X...X...X...X...',
    clap: '....X.......X...',
    hat: 'x.x.x.x.x.x.x.x.',
    'open-hat': '..x...x...x...x.',
  },
  proghouse: {
    kick: 'X...X...X...X...',
    clap: '....x.......x...',
    hat: 'x.x.x.x.x.x.x.x.',
    'open-hat': '..x...x...x...x.',
  },
  // Half-time: kick on 1 (and a syncopated one), snare and clap together on beat 3.
  futurebass: {
    kick: 'X.....x..x......',
    snare: '........X.......',
    clap: '........x.......',
    hat: 'x.x.x.x.x.x.x.x.',
  },
  // Sparse: a kick on 1, the snare on 3, a few hats.
  dubstep: {
    kick: 'X.........x.....',
    snare: '........X.......',
    hat: 'x.x...x.x.x...x.',
  },
  melodicdub: {
    kick: 'X.....x...x.....',
    snare: '........X.......',
    clap: '........x.......',
    hat: 'x.x.x.x.x.x.x.x.',
  },
  // Shuffled: the hats sit on the swung 16ths, a rim and a shaker-ish open hat fill the gaps.
  techhouse: {
    kick: 'X...X...X...X...',
    clap: '....x.......x...',
    hat: 'x.xxx.xxx.xxx.xx',
    'open-hat': '..x...x...x...x.',
    rim: '.x....x..x..x...',
  },
  trance: {
    kick: 'X...X...X...X...',
    clap: '....X.......X...',
    hat: 'x.x.x.x.x.x.x.x.',
    'open-hat': '..x...x...x...x.',
  },
  // Two-step: kick on 1 and the "and" of 3, snare on 2 and 4, ghost snares and busy hats.
  dnb: {
    kick: 'X.........x.....',
    snare: '....X.o.....X..o',
    hat: 'x.x.x.x.x.x.x.x.',
    'open-hat': '......x.......x.',
  },
};

/** Loop length in bars: chords take four, a growl or a break two. */
export const EDM_LOOP: Record<EdmStyle, number> = {
  bigroom: 4,
  proghouse: 4,
  futurebass: 4,
  dubstep: 2,
  melodicdub: 4,
  techhouse: 2,
  trance: 4,
  dnb: 2,
};

/** Stock four-bar progressions per style (roots above the key's root, qualities). */
const PROGS: Record<EdmStyle, Record<'minor' | 'major', Progression>> = {
  bigroom: {
    minor: [[0, 'min'], [8, 'maj'], [10, 'maj'], [7, 'min']],
    major: [[0, 'maj'], [9, 'min'], [5, 'maj'], [7, 'maj']],
  },
  proghouse: {
    minor: [[0, 'm7'], [8, 'maj7'], [3, 'maj7'], [10, '7']],
    major: [[0, 'maj7'], [4, 'm7'], [9, 'm7'], [5, 'maj7']],
  },
  futurebass: {
    minor: [[8, 'maj7'], [10, '7'], [0, 'm7'], [3, 'maj7']],
    major: [[0, 'maj7'], [4, 'm7'], [9, 'm7'], [5, 'maj7']],
  },
  melodicdub: {
    minor: [[0, 'min'], [3, 'maj'], [8, 'maj'], [10, 'maj']],
    major: [[0, 'maj'], [4, 'min'], [5, 'maj'], [7, 'maj']],
  },
  trance: {
    minor: [[0, 'min'], [8, 'maj'], [10, 'maj'], [7, 'min']],
    major: [[0, 'maj'], [5, 'maj'], [9, 'min'], [7, 'maj']],
  },
  techhouse: {
    minor: [[0, 'm7'], [0, 'm7'], [5, 'm7'], [0, 'm7']],
    major: [[0, 'maj7'], [0, 'maj7'], [5, 'maj7'], [0, 'maj7']],
  },
  dubstep: {
    minor: [[0, 'min'], [0, 'min']],
    major: [[0, 'maj'], [0, 'maj']],
  },
  dnb: {
    minor: [[0, 'm7'], [8, 'maj7'], [3, 'maj7'], [10, '7']],
    major: [[0, 'maj7'], [9, 'm7'], [5, 'maj7'], [7, '7']],
  },
};

export interface EdmContext {
  bars: number;
  /** Pitch class 0–11 of the key's root and whether it's minor. */
  root: number;
  minor: boolean;
  /** The kick's notes (the bass follows it in the styles that do). */
  kick: readonly BeatNote[];
  /** Drum & bass: neuro (a growling bass on its own) rather than liquid (chords on top). */
  neuro: boolean;
}

/** A hook of single chord tones: one note per `rhythm` hit [step, length], tones picked by `contour`. */
function hook(
  prog: Progression,
  keyRoot: number,
  bars: number,
  rhythm: readonly (readonly [number, number])[],
  contour: readonly number[],
  low: number,
  vel: number,
): BeatNote[] {
  const notes: BeatNote[] = [];
  let n = 0;
  for (let bar = 0; bar < bars; bar++) {
    const [degree, quality] = prog[bar % prog.length]!;
    const tones = voice(keyRoot + degree, quality, low);
    for (const [step, len] of rhythm) {
      const c = contour[n++ % contour.length]!;
      const key = (tones[c % tones.length] as number) + 12 * Math.floor(c / tones.length);
      notes.push({ step: bar * STEPS_PER_BAR + step, len, key, vel });
    }
  }
  return notes;
}

/** A chord's tones played one at a time, in a repeating up-and-down order (arps, 16th or 8th notes). */
function arp(
  prog: Progression,
  keyRoot: number,
  bars: number,
  every: number,
  len: number,
  order: readonly number[],
  low: number,
  vel: number,
): BeatNote[] {
  const notes: BeatNote[] = [];
  for (let bar = 0; bar < bars; bar++) {
    const [degree, quality] = prog[bar % prog.length]!;
    const tones = voice(keyRoot + degree, quality, low);
    for (let i = 0, step = 0; step < STEPS_PER_BAR; i++, step += every) {
      const c = order[i % order.length]!;
      const key = (tones[c % tones.length] as number) + 12 * Math.floor(c / tones.length);
      // Accent the first note of every beat.
      notes.push({ step: bar * STEPS_PER_BAR + step, len, key, vel: step % 4 === 0 ? vel : vel * 0.82 });
    }
  }
  return notes;
}

/** Bass notes per bar from [step, length, semitones above the bar's chord root] hits. */
function bassLine(
  prog: Progression,
  bars: number,
  rootBass: number,
  hits: readonly (readonly [number, number, number])[],
  vel = 0.82,
): BeatNote[] {
  const notes: BeatNote[] = [];
  for (let bar = 0; bar < bars; bar++) {
    const [degree] = prog[bar % prog.length]!;
    for (const [step, len, up] of hits)
      notes.push({ step: bar * STEPS_PER_BAR + step, len, key: bassKey(rootBass + degree + up), vel });
  }
  return notes;
}

const track = (name: string, sound: BeatTrack['sound'], notes: BeatNote[]): BeatTrack => ({ name, sound, notes });

/** The pitched parts of an EDM-pack style (the drums come from `EDM_DRUMS`). */
export function edmTracks(style: EdmStyle, c: EdmContext): BeatTrack[] {
  const { bars, root, neuro } = c;
  const scale = c.minor ? 'minor' : 'major';
  const prog = PROGS[style][scale];
  const rootBass = 36 + root;
  const root808 = 24 + root;
  const out: BeatTrack[] = [];
  switch (style) {
    case 'bigroom': {
      // The drop: kick, a mono lead and the supersaw chords the sidechain pumps; a bass on the offbeat under them.
      out.push(track('Bass', 'bass', bassLine(prog, bars, rootBass, [[2, 1.5, 0], [6, 1.5, 0], [10, 1.5, 0], [14, 1.5, 0]], 0.8)));
      out.push(track('Pad', 'pad', chords(prog, root, bars, [[0, 16, 0.7]], 53)));
      out.push(
        track(
          'Lead',
          'lead',
          hook(prog, root, bars, [[0, 3], [3, 3], [6, 2], [8, 4], [12, 3]], [2, 1, 2, 0, 1], 72, 0.85),
        ),
      );
      break;
    }
    case 'proghouse': {
      // A rolling bass between the kicks, piano chords on 1 and the "and" of 2, a pluck arp on top.
      const rolling: [number, number, number][] = [1, 2, 3, 5, 6, 7, 9, 10, 11, 13, 14, 15].map((s) => [s, 0.8, s % 4 === 3 ? 12 : 0]);
      out.push(track('Bass', 'bass', bassLine(prog, bars, rootBass, rolling, 0.78)));
      out.push(track('Keys', 'keys', chords(prog, root, bars, [[0, 6, 0.75], [6, 3, 0.62], [8, 7, 0.68]], 53)));
      out.push(track('Pluck', 'pluck', arp(prog, root, bars, 2, 1.5, [0, 1, 2, 3, 2, 1], 72, 0.8)));
      break;
    }
    case 'futurebass': {
      // Supersaw chords held under a wobble, a sub on the roots, vocal-chop style leads in short bursts.
      out.push(track('Sub', 'bass', bassLine(prog, bars, rootBass, [[0, 12, 0], [12, 4, 0]], 0.85)));
      out.push(track('Chords', 'pad', chords(prog, root, bars, [[0, 8, 0.75], [8, 8, 0.7]], 53)));
      out.push(
        track(
          'Lead',
          'lead',
          hook(prog, root, bars, [[0, 1], [3, 1], [6, 2], [10, 1], [13, 1.5]], [3, 2, 3, 1, 2], 72, 0.85),
        ),
      );
      break;
    }
    case 'dubstep': {
      // A sub under the kick and snare, and a growl bass that answers them (two bars, a fill in the second).
      const sub: BeatNote[] = [];
      for (let bar = 0; bar < bars; bar++) {
        sub.push({ step: bar * STEPS_PER_BAR, len: 8, key: root808, vel: 0.9 });
        sub.push({ step: bar * STEPS_PER_BAR + 8, len: 8, key: root808, vel: 0.9 });
      }
      out.push(track('Sub', '808', sub));
      const growl: BeatNote[] = [];
      for (let bar = 0; bar < bars; bar++) {
        const b = bar * STEPS_PER_BAR;
        const hits: [number, number, number][] =
          bar % 2 === 0
            ? [[0, 6, 0], [6, 1.5, 0], [8, 3, 0], [12, 2, 3]]
            : [[0, 4, 0], [4, 2, 0], [8, 2, 0], [10, 2, 3], [12, 4, c.minor ? -2 : 7]];
        for (const [s, len, up] of hits) growl.push({ step: b + s, len, key: bassKey(rootBass + up), vel: 0.9 });
      }
      out.push(track('Growl', 'bass', growl));
      break;
    }
    case 'melodicdub': {
      // Emotional: big chords, a piano line over them, a sub; a vocal-chop lead.
      out.push(track('Sub', 'bass', bassLine(prog, bars, rootBass, [[0, 12, 0], [12, 4, 0]], 0.85)));
      out.push(track('Chords', 'pad', chords(prog, root, bars, [[0, 16, 0.75]], 53)));
      out.push(track('Piano', 'keys', arp(prog, root, bars, 2, 3, [0, 1, 2, 3, 2, 1, 2, 1], 60, 0.7)));
      out.push(track('Lead', 'lead', hook(prog, root, bars, [[0, 5], [6, 2], [8, 4]], [2, 3, 1], 72, 0.8)));
      break;
    }
    case 'techhouse': {
      // A groovy, syncopated bassline, minimal chord stabs and a vocal-style shot every other bar.
      out.push(track('Bass', 'bass', bassLine(prog, bars, rootBass, [[2, 1, 0], [3, 0.75, 0], [6, 1.5, 0], [10, 1, 0], [11, 0.75, 12], [14, 1, 3]], 0.82)));
      out.push(track('Stab', 'keys', chords(prog, root, bars, [[3, 1.5, 0.7], [10, 1, 0.6]], 55)));
      const shot: BeatNote[] = [];
      for (let bar = 1; bar < bars; bar += 2) shot.push({ step: bar * STEPS_PER_BAR + 11, len: 1, key: 72 + ((root + 3) % 12), vel: 0.85 });
      if (!shot.length) shot.push({ step: 11, len: 1, key: 72 + ((root + 3) % 12), vel: 0.85 });
      out.push(track('Vox', 'lead', shot));
      break;
    }
    case 'trance': {
      // An offbeat bass, held chords the gate chops into 16ths, and a 16th pluck arp.
      out.push(track('Bass', 'bass', bassLine(prog, bars, rootBass, [[2, 1.5, 0], [6, 1.5, 0], [10, 1.5, 0], [14, 1.5, 0]], 0.8)));
      out.push(track('Pad', 'pad', chords(prog, root, bars, [[0, 16, 0.7]], 53)));
      out.push(track('Arp', 'pluck', arp(prog, root, bars, 1, 0.75, [0, 1, 2, 3, 2, 1, 2, 3], 72, 0.8)));
      break;
    }
    case 'dnb': {
      // A reese under the two-step (long notes that follow the kick); liquid adds chords and a pluck.
      const hits = [...new Set(c.kick.map((n) => n.step % STEPS_PER_BAR))].sort((a, b) => a - b);
      const reese: BeatNote[] = [];
      for (let bar = 0; bar < bars; bar++) {
        const [degree] = prog[bar % prog.length]!;
        hits.forEach((s, i) => {
          const next = hits[i + 1] ?? STEPS_PER_BAR;
          reese.push({ step: bar * STEPS_PER_BAR + s, len: Math.max(1, next - s - 0.5), key: bassKey(rootBass + degree), vel: 0.85 });
        });
      }
      out.push(track('Reese', 'bass', reese));
      if (!neuro) {
        out.push(track('Pad', 'pad', chords(prog, root, bars, [[0, 16, 0.65]], 53)));
        out.push(track('Keys', 'keys', chords(prog, root, bars, [[0, 2, 0.7], [6, 2, 0.6], [10, 3, 0.65]], 55)));
      }
      break;
    }
  }
  return out;
}

