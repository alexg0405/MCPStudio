/** The punch range commands: the range is separate from the loop region, and only audio recording uses it. */
import type { Services } from '@app/services';
import { clearPunch, describePunch, punchFromLoop, recordPunch, setPunchIn, setPunchOut, setPunchRange } from '@app/actions/punch';
import type { Tick } from '@core/model/types';
import { ticksPerBar } from '@core/time/ppq';

/** The longest pre-roll offered, in bars. */
const MAX_PRE_ROLL_BARS = 4;

/** Registers the punch commands: set the punch-in, punch-out or range, clear it, pre-roll and record it. */
export function registerPunchCommands({ commands }: Services): void {
  const barTick = (s: Services, bar: unknown): Tick | null =>
    typeof bar === 'number' && Number.isFinite(bar) ? Math.max(0, Math.round((bar - 1) * ticksPerBar(s.doc.getState().project.transport.timeSig))) : null;
  const punchAt = (s: Services, args: { bar?: number } | undefined) => barTick(s, args?.bar) ?? s.view.getState().songStart;
  commands.register<{ bar?: number }>({
    id: 'record.punchIn',
    title: 'Set punch-in',
    category: 'Recording',
    hint: 'Audio recording starts keeping sound here (the song position by default); the red band on the ruler shows the punch range',
    argsHint: '{ bar: 1-based bar (fractions allowed) } (default: the song position)',
    run: (s, args) => {
      setPunchIn(s, punchAt(s, args));
      s.session.getState().setHint(`Punch range: ${describePunch(s) ?? 'none'}`);
    },
  });
  commands.register<{ bar?: number }>({
    id: 'record.punchOut',
    title: 'Set punch-out',
    category: 'Recording',
    hint: 'Audio recording stops keeping sound here (the song position by default); with no loop region the take ends there and the song plays on',
    argsHint: '{ bar: 1-based bar where the punch ends (fractions allowed) } (default: the song position)',
    run: (s, args) => {
      setPunchOut(s, punchAt(s, args));
      s.session.getState().setHint(`Punch range: ${describePunch(s) ?? 'none'}`);
    },
  });
  commands.register<{ from_bar?: number; to_bar?: number }>({
    id: 'record.punchRange',
    title: 'Set the punch range',
    category: 'Recording',
    hint: 'Only this part of an audio recording is kept (bars from–to, inclusive); without arguments the loop region becomes the punch range',
    argsHint: '{ from_bar, to_bar } 1-based inclusive bars (default: the loop region)',
    run: (s, args) => {
      const bar = ticksPerBar(s.doc.getState().project.transport.timeSig);
      const a = typeof args?.from_bar === 'number' ? args.from_bar : null;
      const b = typeof args?.to_bar === 'number' ? args.to_bar : a;
      const ok =
        a !== null && b !== null
          ? setPunchRange(s, Math.max(0, Math.round((Math.min(a, b) - 1) * bar)), Math.round(Math.max(a, b) * bar))
          : punchFromLoop(s);
      if (ok) s.session.getState().setHint(`Punch range: ${describePunch(s)}`);
      else s.session.getState().toast('Give the bars to punch (from_bar, to_bar), or set a loop region first.');
    },
  });
  commands.register({
    id: 'record.clearPunch',
    title: 'Clear the punch range',
    category: 'Recording',
    hint: 'Audio recording keeps everything again (or whatever the loop region says)',
    enabled: (s) => !!s.view.getState().punch,
    run: (s) => clearPunch(s),
  });
  commands.register<number>({
    id: 'record.preRoll',
    title: 'Pre-roll bars',
    category: 'Recording',
    hint: 'Bars played before the punch-in when you record the punch range, so you can find the beat (0 starts right at the punch-in)',
    argsHint: 'a number of bars, 0–4',
    run: (s, bars) => {
      const v = Math.max(0, Math.min(MAX_PRE_ROLL_BARS, Math.round(Number(bars))));
      if (Number.isFinite(v)) s.prefs.getState().set({ preRollBars: v });
    },
  });
  commands.register({
    id: 'transport.recordPunch',
    title: 'Record the punch range',
    category: 'Transport',
    hint: 'Plays from the pre-roll before the punch-in (after the count-in) and records audio from the punch-in to the punch-out, then keeps the song playing',
    gesture: true,
    enabled: (s) => !!s.view.getState().punch,
    run: async (s) => {
      if (!(await recordPunch(s)) && !s.view.getState().punch) s.session.getState().toast('Set the punch range first: right-click the ruler or Alt-drag across it.');
    },
  });
}
