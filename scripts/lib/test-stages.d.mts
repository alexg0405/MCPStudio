/** Types for scripts/lib/test-stages.mjs. */
export interface TestStage {
  label: string;
  project: string;
  tagsFilter: string;
}
export const STAGES: Record<'unit' | 'audio' | 'unit-timing' | 'audio-realtime', TestStage>;
export const QUIET_STAGES: string[];
export function vitestArguments(stageName: string, extra?: string[]): string[];
