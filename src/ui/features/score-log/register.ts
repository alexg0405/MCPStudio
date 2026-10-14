import type { Services } from '@app/services';
import { dumpScoreLog, lastPhrase, type DumpOptions } from '@app/score-log';
import { setBpm } from '@core/ops/notes';
import { TapTempo } from '@core/time/tap-tempo';
import { showFormDialog } from '../../controls/FormDialog';
import { addMenuItems, cmd, sep } from '../../shell/menus';

const SNAP: readonly { value: string; label: string }[] = [
  { value: '0', label: 'As played' },
  { value: '480', label: '1/8 note' },
  { value: '240', label: '1/16 note' },
  { value: '120', label: '1/32 note' },
  { value: '160', label: '1/16 triplet' },
];

/** Reads the AI's (or a script's) options: { span, quantize, into }. */
function optionsFrom(args: unknown): DumpOptions | null {
  if (!args || typeof args !== 'object') return null;
  const a = args as Record<string, unknown>;
  return {
    span: a.span === 'all' ? 'all' : 'phrase',
    quantize: typeof a.quantize === 'number' && a.quantize >= 0 ? Math.round(a.quantize) : 0,
    into: a.into === 'current' ? 'current' : 'new',
  };
}

/**
 * FL's score log ("Dump what I played…": the keyboard notes of the last five minutes into a
 * pattern, recording or not) and tap tempo.
 */
export function register(services: Services): void {
  const { commands } = services;
  commands.register<unknown>({
    id: 'patterns.dumpScoreLog',
    title: 'Dump what I played…',
    category: 'Patterns',
    hint: 'Everything you played on your keyboard in the last 5 minutes, even without recording, into a pattern',
    argsHint: "{ span: 'phrase' (the last phrase) | 'all' (5 minutes), quantize: ticks (0 = as played, 240 = 1/16), into: 'new' | 'current' }",
    run: async (s, args) => {
      const toast = s.session.getState().toast;
      let opts = optionsFrom(args);
      if (!opts) {
        const all = s.scoreLog.all();
        if (all.length === 0)
          return toast('Nothing played yet: play something on your keyboard (MIDI or the typing piano), then dump it.', 'error');
        const phrase = lastPhrase(all).length;
        const got = await showFormDialog({
          title: 'Dump what I played',
          message: `AGstudio keeps what you play, recording or not. You played ${all.length} note${all.length === 1 ? '' : 's'} in the last 5 minutes; the last phrase (since a pause of 4 s) has ${phrase}.`,
          fields: [
            {
              kind: 'choice',
              key: 'span',
              label: 'What',
              options: [
                { value: 'phrase', label: `The last phrase (${phrase} notes)` },
                { value: 'all', label: `Everything (${all.length} notes)` },
              ],
            },
            { kind: 'choice', key: 'quantize', label: 'Snap starts to', options: SNAP },
            {
              kind: 'choice',
              key: 'into',
              label: 'Into',
              options: [
                { value: 'new', label: 'A new pattern' },
                { value: 'current', label: 'The current pattern (from its start)' },
              ],
            },
          ],
          values: { span: 'phrase', quantize: '0', into: 'new' },
          okLabel: 'Dump',
        });
        if (!got) return;
        opts = { span: got.span === 'all' ? 'all' : 'phrase', quantize: Number(got.quantize) || 0, into: got.into === 'current' ? 'current' : 'new' };
      }
      const r = dumpScoreLog(s, opts);
      if ('error' in r) return toast(r.error, 'error');
      toast(`Wrote ${r.notes} note${r.notes === 1 ? '' : 's'} (${r.bars} bar${r.bars === 1 ? '' : 's'}) into “${s.doc.getState().project.patterns[r.patternId]?.name ?? 'the pattern'}”`);
    },
  });
  commands.register({
    id: 'patterns.clearScoreLog',
    title: 'Forget what I played',
    category: 'Patterns',
    hint: 'Empty the score log (the last 5 minutes of keyboard notes)',
    enabled: (s) => s.scoreLog.all().length > 0,
    run: (s) => s.scoreLog.clear(),
  });

  const taps = new TapTempo();
  commands.register({
    id: 'transport.tapTempo',
    title: 'Tap tempo',
    category: 'Transport',
    hint: 'Tap this (or its key) on the beat a few times and the tempo follows',
    run: (s) => {
      const bpm = taps.tap(performance.now());
      if (bpm === null) return s.session.getState().setHint('Tap tempo: keep tapping on the beat…');
      const rounded = Math.round(bpm);
      // One undo step for a run of taps.
      s.history.transact(`Tap tempo: ${rounded} BPM`, (d) => setBpm(d, rounded), { mergeKey: 'tap-tempo' });
      s.session.getState().setHint(`Tap tempo: ${rounded} BPM`);
    },
  });
  services.keymap.add([{ chord: 'Shift+T', command: 'transport.tapTempo', repeat: false }]);
  addMenuItems('patterns', [sep(70), cmd('patterns.dumpScoreLog', 71), cmd('patterns.clearScoreLog', 72)]);
  addMenuItems('options', [cmd('transport.tapTempo', 4)]);
}
