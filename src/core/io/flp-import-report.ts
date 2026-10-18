/** The FL import report in plain words, for the dialog shown after an import. */
import type { FlpImportReport } from './flp-import-types';

/** "1 channel", "3 channels"; `many` is the plural when it is not just "s" added. */
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** Up to `max` distinct names, then "and N more". */
function list(names: readonly string[], max = 4): string {
  const unique = [...new Set(names)];
  const shown = unique.slice(0, max).join(', ');
  return unique.length > max ? `${shown} and ${unique.length - max} more` : shown;
}

/** "a", "a and b", "a, b and c". */
function joinAnd(parts: string[]): string {
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** The report in plain words: a headline and one line per thing worth knowing. */
export function describeFlpImport(
  report: FlpImportReport,
  opts: { fromPackage?: boolean } = {},
): {
  headline: string;
  details: string[];
} {
  const details: string[] = [
    ...describeStandIns(report),
    ...describeMissingSamples(report, opts),
    ...describeEffects(report),
    ...describeStructure(report),
    ...describeLeftOut(report),
  ];
  if (report.standIns.length > 0 || report.effects > 0) {
    details.push(
      'Plugin settings aren’t read from FL Studio: every instrument and effect starts from its default sound.',
    );
  }
  details.push(...report.warnings);
  return { headline: headline(report), details };
}

function headline(report: FlpImportReport): string {
  const got: string[] = [plural(report.channels, 'channel'), plural(report.patterns, 'pattern')];
  if (report.clips > 0) {
    got.push(
      report.arrangement
        ? `the arrangement “${report.arrangement}” (${plural(report.clips, 'clip')})`
        : `the playlist (${plural(report.clips, 'clip')})`,
    );
  }
  if (report.markers > 0) got.push(plural(report.markers, 'marker'));
  if (report.effects > 0) got.push(plural(report.effects, 'effect'));
  return `Imported ${joinAnd(got)}.`;
}

/** FL plugins that play through a built-in instead. */
function describeStandIns(report: FlpImportReport): string[] {
  const details: string[] = [];
  const vsts = report.standIns.filter((s) => s.vst);
  const natives = report.standIns.filter((s) => !s.vst);
  if (vsts.length > 0) {
    const vstCount = plural(new Set(vsts.map((s) => s.plugin)).size, 'VST plugin');
    const standIns = list(
      vsts.map((s) => s.using),
      3,
    );
    details.push(
      `Not imported: ${vstCount} (${list(vsts.map((s) => s.plugin))}). Their channels keep their notes and play a stand-in (${standIns}), marked “stand-in” in the channel name.`,
    );
  }
  if (natives.length > 0) {
    const standIns = list(
      natives.map((s) => s.using),
      3,
    );
    details.push(
      `FL instruments without a match here (${list(natives.map((s) => s.plugin))}) play a stand-in instead (${standIns}); their notes are all there.`,
    );
  }
  return details;
}

function describeMissingSamples(report: FlpImportReport, opts: { fromPackage?: boolean }): string[] {
  if (report.missingSamples.length === 0) return [];
  const files = list(report.missingSamples.map((m) => m.file));
  const count = new Set(report.missingSamples.map((m) => m.path)).size;
  return [
    opts.fromPackage
      ? `${plural(count, 'sample was', 'samples were')} not in the zip (${files}): use File > Find missing samples… with the audio files, or drop them on their channels.`
      : `${plural(count, 'sample wasn’t', 'samples weren’t')} in the file (${files}): an .flp only points at samples on the computer that made it. Drop the zipped loop package (in FL: File > Export > Zipped loop package) to bring them, or use File > Find missing samples….`,
  ];
}

function describeEffects(report: FlpImportReport): string[] {
  const details: string[] = [];
  if (report.skippedEffects.length > 0) {
    details.push(`Effects not imported: ${list(report.skippedEffects.map((e) => `${e.plugin} (${e.insert})`))}.`);
  }
  if (report.effectStandIns.length > 0) {
    details.push(
      `Effects replaced by a built-in: ${list(report.effectStandIns.map((e) => `${e.plugin} → ${e.using}`))}.`,
    );
  }
  return details;
}

/** Arrangements, layers and automation: how the file's structure was mapped. */
function describeStructure(report: FlpImportReport): string[] {
  const details: string[] = [];
  if (report.otherArrangements.length > 0) {
    details.push(
      `Only the open arrangement came in; not imported: ${list(report.otherArrangements.map((a) => `“${a}”`))}.`,
    );
  }
  if (report.layers.length > 0) {
    details.push(
      `Layer channels (${list(report.layers.map((l) => l.channel))}) became their child channels, which play the layer’s notes.`,
    );
  }
  if (report.untargetedAutomation.length > 0) {
    const clips = plural(report.untargetedAutomation.length, 'automation clip');
    details.push(
      `${clips} came in without a target (${list(report.untargetedAutomation)}): right-click a control and use “Create automation clip” to redo them.`,
    );
  }
  return details;
}

function describeLeftOut(report: FlpImportReport): string[] {
  const details: string[] = [];
  if (report.slideNotes > 0) {
    details.push(`${plural(report.slideNotes, 'slide note')} (FL’s pitch slides) were left out.`);
  }
  if (report.orphanNotes > 0) {
    details.push(`${plural(report.orphanNotes, 'note')} on channels that couldn’t be imported were left out.`);
  }
  if (report.skippedClips > 0) {
    details.push(`${plural(report.skippedClips, 'playlist clip')} couldn’t be placed and were left out.`);
  }
  return details;
}
