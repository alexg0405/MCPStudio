import type { PerformanceRole } from '@core/beat/local';

/** What a request says the take is ("808s that go like…", "my beatbox"), if anything. */
export function inferRole(prompt: string): Exclude<PerformanceRole, 'auto'> | null {
  const text = prompt.toLowerCase();
  if (/\b808s?\b|\bbass ?line|\bbass\b|\bsub\b/.test(text)) return '808';
  if (/\bmelod|\blead\b|\btune\b|\bsing|\bhook\b|\bhumm?(ed|ing)? (a |the )?(melody|tune)/.test(text)) return 'melody';
  if (/\bbeat ?box|\bdrums?\b|\bkicks?\b|\bsnares?\b|\bhats?\b|\bpercussion\b/.test(text)) return 'drums';
  return null;
}

/** How the voice analysis should listen for a role: for drums, for pitched sound, or let it decide. */
export function analysisMode(role: PerformanceRole): 'auto' | 'drums' | 'tonal' {
  if (role === 'drums') return 'drums';
  if (role === 'auto') return 'auto';
  return 'tonal';
}

/** The role as a phrase for the chat ("with your 2-bar take (…, as an 808 line)"). */
export function roleLabel(role: PerformanceRole): string {
  return { auto: 'auto', drums: 'drums', '808': 'an 808 line', melody: 'a melody' }[role];
}
