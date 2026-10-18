/**
 * What Studio and the MCP tools read about loudness: the master's live numbers (when a meter is open), the target the
 * song is aiming for and the last loudness report.
 */
import { reportFacts } from '@core/metering/report';
import type { Services } from '../services';

const round1 = (value: number | null) => (value === null ? null : Math.round(value * 10) / 10);

export function loudnessFacts(s: Services) {
  const live = s.meters.live();
  const target = s.meters.target();
  const report = s.meters.store.getState().report;
  const timeSig = s.doc.getState().project.transport.timeSig;
  return {
    live: live
      ? {
          playing: live.playing,
          momentary_lufs: round1(live.momentary),
          short_term_lufs: round1(live.shortTerm),
          integrated_lufs_since_play: round1(live.integrated),
          loudness_range_lu: live.range,
          true_peak_dbtp_since_play: round1(live.truePeakDb),
          max_momentary_lufs: round1(live.maxMomentary),
          max_short_term_lufs: round1(live.maxShortTerm),
          correlation: live.correlation,
          mono_loss_db: live.monoLossDb,
        }
      : null,
    live_note: live
      ? live.playing
        ? 'Live readings of the master; integrated loudness and the maximums count from when the song started playing.'
        : 'The song is not playing: the numbers are what the meter last measured. Play the song and read again.'
      : 'A meter was just opened on the master: play the song for a few seconds and ask again, or use loudness_report to measure it offline.',
    target: target.lufs === null ? null : { lufs: target.lufs, from: target.label },
    last_report: report ? { ...reportFacts(report, timeSig), made_at: new Date(report.at).toISOString() } : null,
  };
}
