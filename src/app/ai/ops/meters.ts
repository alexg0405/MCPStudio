/**
 * The loudness report as an action: Studio can ask for the offline loudness report (integrated loudness, range, true
 * peak with bar positions, what streaming services do) of the song or a range of bars. Nothing in the project changes;
 * it renders after the answer's edits, and the numbers come back as the step's message (and `get_loudness`).
 */
import * as S from '../schema/parts';
import { type OpModule } from './context';
import { num } from './values';

export const meters: OpModule = {
  schemas: [
    S.op(
      'loudness_report',
      'Listens to the song offline (through the master chain, as an export would sound) and reports its integrated loudness (LUFS), loudness range, true peak and where it happens, the loudest moments and what Spotify, YouTube, Apple Music and broadcast do to it. Changes nothing in the project. Give from_bar and to_bar for a part; with none, the whole song (or the pattern on a loop when there is no song yet).',
      {
        from_bar: S.int('1-based first bar of the part to measure.'),
        to_bar: S.int('1-based last bar (inclusive).'),
      },
    ),
  ],
  prompt: {
    id: 'meters',
    order: 27,
    text: `Loudness and stereo meters (get_loudness, loudness_report):
- The Meters window (View → Meters) measures the master live: momentary and short-term loudness, integrated loudness (LUFS), loudness range, true peak, stereo correlation and width per band, spectrum. get_loudness returns those live numbers (the musician must be playing the song with a meter open; the first call opens one) and the last loudness report.
- "Is it loud enough", "how loud is my song", "will it clip", "what will Spotify do": loudness_report (the whole song unless a range is named), then say the numbers in plain words: integrated LUFS against the style or reference target, true peak against −1 dBTP, the streaming services' turn-down. To change the loudness use level_mix; the report itself changes nothing.
- Out-of-phase bass or a low correlation: suggest the Stereo effect's mono bass or a polarity flip, not a different mix.`,
  },
  handlers: {
    loudness_report: (action, context) => {
      const from = num(action.from_bar);
      const to = num(action.to_bar);
      const bar = context.bar();
      context.state.after.push({
        kind: 'loudness_report',
        ...(from !== undefined ? { fromTick: (Math.max(1, Math.round(from)) - 1) * bar } : {}),
        ...(to !== undefined ? { toTick: Math.max(1, Math.round(to)) * bar } : {}),
      });
      return null;
    },
  },
};
