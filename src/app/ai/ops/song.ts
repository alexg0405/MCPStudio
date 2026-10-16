/** Song settings: tempo, swing, key, time signature. */
import { setBpm, setSongKey, setSwing } from '@core/ops/notes';
import { SCALES } from '@agstudio/sdk/notes';
import * as S from '../schema/parts';
import type { OpModule } from './context';
import { num, parseKey, str } from './values';

export const song: OpModule = {
  schemas: [
    S.op('song', 'Song settings: tempo, swing, key, time signature, title and author.', {
      bpm: S.num('Tempo in BPM (10–522).'),
      swing: S.num('0..1 swing on even 1/16 steps.'),
      key: S.str(
        `Song key: a root and a scale, like "F minor", "C# dorian", "A minor-pentatonic", or "none". Scales: ${SCALES.map((sc) => sc.id).join(', ')}.`,
      ),
      time_signature: S.str('Like "4/4" or "3/4".'),
      title: S.str('The project’s title.'),
      author: S.str('The project’s author ("" removes it).'),
    }),
  ],
  handlers: {
    song: (a, c) => {
      const { d } = c;
      const out: string[] = [];
      const bpm = num(a.bpm);
      if (bpm !== undefined) {
        setBpm(d, bpm);
        out.push(`tempo ${d.transport.bpm} BPM`);
      }
      const swing = num(a.swing);
      if (swing !== undefined) {
        setSwing(d, swing > 1 && swing <= 100 ? swing / 100 : swing);
        out.push(`swing ${Math.round(d.transport.swing * 100)}%`);
      }
      const keyText = str(a.key);
      if (keyText) {
        const key = parseKey(keyText);
        if (key === undefined) c.warn(`can't read the key "${keyText}"`);
        else {
          setSongKey(d, key);
          out.push(key ? `key ${keyText}` : 'no key');
        }
      }
      const sig = str(a.time_signature);
      if (sig) {
        const m = /^(\d+)\s*\/\s*(\d+)$/.exec(sig);
        const n = m ? Number(m[1]) : 0;
        const den = m ? Number(m[2]) : 0;
        if (n >= 1 && n <= 32 && [1, 2, 4, 8, 16, 32].includes(den)) {
          d.transport.timeSig = { num: n, den };
          out.push(`time signature ${n}/${den}`);
        } else c.warn(`can't use the time signature "${sig}"`);
      }
      const title = str(a.title);
      if (title) {
        d.meta.title = title.slice(0, 120);
        out.push(`title “${d.meta.title}”`);
      }
      if (typeof a.author === 'string') {
        const author = a.author.trim().slice(0, 120);
        if (author) d.meta.author = author;
        else delete d.meta.author;
        out.push(author ? `author ${author}` : 'no author');
      }
      return out.length ? `Song: ${out.join(', ')}` : null;
    },
  },
};
