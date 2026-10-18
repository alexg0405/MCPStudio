/**
 * The Studio's loudness report, run after its answer is applied: renders and measures the song, then says the numbers.
 * It changes nothing in the project, so there is nothing to fold into the answer's undo step.
 */
import { formatReport } from '@core/metering/report';
import type { AfterStep } from '../assistant/after-steps';

export const loudnessReportStep: AfterStep = async (item, c) => {
  if (item.kind !== 'loudness_report') return null;
  const report = await c.s.meters.makeReport({
    ...(item.fromTick !== undefined ? { fromTick: item.fromTick } : {}),
    ...(item.toTick !== undefined ? { toTick: item.toTick } : {}),
    signal: c.signal,
    whenQuiet: c.whenQuiet,
  });
  if (!report) return { message: 'There is nothing to measure yet: no pattern or clips play.' };
  const lines = formatReport(report, c.s.doc.getState().project.transport.timeSig).split('\n').slice(1);
  return { message: `I listened to ${report.what} and measured its loudness.`, changes: lines.filter((line) => line.trim() !== '') };
};
