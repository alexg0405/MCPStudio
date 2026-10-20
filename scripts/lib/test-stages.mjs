// The test stages of `npm run check` and `npm run test:perf`: which Vitest project each one runs and which tests it picks.
//
// Most tests are fine on a busy machine, so the `unit` (Node) and `audio` (headless Chrome) stages run many files side by
// side. Tests tagged `perf` (speed, CPU cost, memory) or `realtime` (a live audio clock) measure the machine as much as the
// code, so they are left out of those stages and run last, one file at a time, in the `unit-timing` (Node) and
// `audio-realtime` (Chrome) projects. The tags are declared in vite.config.ts; the files that hold tagged tests are found by
// tools/test/quiet-files.ts.
//
// The tag expressions go to Vitest as plain words (`--tags-filter` takes them as one argument), never through a shell, so
// the same lines work in cmd.exe, PowerShell and Unix shells.

/** The tag expression of the tests that need a machine of their own, and of all the others. */
const QUIET = 'perf || realtime';
const NOT_QUIET = '!perf && !realtime';

/**
 * The stages: the name in the report, the Vitest project and the tag filter that picks its tests. `unit` and `audio` run many
 * files side by side; the two quiet ones run one file at a time (their projects set `fileParallelism: false`).
 */
export const STAGES = {
  unit: { label: 'vitest unit', project: 'unit', tagsFilter: NOT_QUIET },
  audio: { label: 'vitest audio', project: 'audio', tagsFilter: NOT_QUIET },
  'unit-timing': { label: 'vitest timing', project: 'unit-timing', tagsFilter: QUIET },
  'audio-realtime': { label: 'vitest realtime', project: 'audio-realtime', tagsFilter: QUIET },
};

/** The stages that run when nothing else runs, in the order `npm run check` takes them. */
export const QUIET_STAGES = ['unit-timing', 'audio-realtime'];

/** The Vitest command line (after the vitest script) for a stage, with `extra` arguments (file filters, reporters) last. */
export function vitestArguments(stageName, extra = []) {
  const stage = STAGES[stageName];
  if (!stage) throw new Error(`Unknown test stage "${stageName}"`);
  return ['run', '--project', stage.project, '--tags-filter', stage.tagsFilter, ...extra];
}
