/** "Clean up the song": what it would fix (for the confirm dialog) and doing it as one undo step. */
import { songCheck } from '@core/query/arrangement';
import { tidySong, type TidyReport } from '@core/ops/tidy';
import { barSpan } from '@core/time/bars';
import type { Services } from '../services';

/** Plain-language lines about what the clean-up would change (empty: nothing to do). */
export function tidyPreview(s: Services): string[] {
  const p = s.doc.getState().project;
  const ts = p.transport.timeSig;
  const out: string[] = [];
  for (const issue of songCheck(p)) {
    if (issue.kind === 'stacked')
      out.push(`${barSpan(issue.from, issue.to, ts)} play the same clips ${issue.times} times at once: keep one copy.`);
    else if (issue.kind === 'duplicateAutomation')
      out.push(`${issue.count} automation channels “${issue.name}” are the same curve: keep one.`);
    else if (issue.kind === 'unnamedLanes')
      out.push(`Name tracks that play just one thing (${issue.count} track${issue.count === 1 ? ' has' : 's have'} no name).`);
  }
  return out;
}

export function tidyNow(s: Services): TidyReport {
  let report: TidyReport = { stacked: 0, automation: 0, named: [] };
  s.versions.beforeBigChange('before-tidy');
  s.history.transact('Clean up the song', (d) => {
    report = tidySong(d);
  });
  return report;
}

export function describeTidy(r: TidyReport): string {
  const parts = [
    r.stacked ? `removed ${r.stacked} stacked cop${r.stacked === 1 ? 'y' : 'ies'}` : '',
    r.automation ? `merged ${r.automation} automation channel${r.automation === 1 ? '' : 's'}` : '',
    r.named.length ? `named ${r.named.length} track${r.named.length === 1 ? '' : 's'}` : '',
  ].filter(Boolean);
  return parts.length ? `Cleaned up the song: ${parts.join(', ')}.` : 'The song had nothing to clean up.';
}
