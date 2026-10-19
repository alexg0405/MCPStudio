import type { Style } from '../style';
import type { PromptInfo } from './types';

const NOTE_NAMES: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

/** Words that name a style, most specific first (the first match in the text wins). */
const STYLE_WORDS: [RegExp, Style][] = [
  [/\bdrill\b/, 'drill'],
  [/\btrap\b|\brage\b/, 'trap'],
  [/boom\s*-?\s*bap|\b90s\b|\bhip\s*-?\s*hop\b/, 'boombap'],
  [/\blo\s*-?\s*fi\b|\bchill\b/, 'lofi'],
  [/\bmelodic\s*-?\s*dub(step)?\b/, 'melodicdub'],
  [/\bdubstep\b|\briddim\b|\bbrostep\b|\bgrowl\b/, 'dubstep'],
  [/\bfuture\s*-?\s*bass\b/, 'futurebass'],
  [/\bbig\s*-?\s*room\b/, 'bigroom'],
  [/\bprogressive\b|\bprog\s*-?\s*house\b/, 'proghouse'],
  [/\btech\s*-?\s*house\b/, 'techhouse'],
  [/\btrance\b/, 'trance'],
  [/\bdrum\s*(?:&|and|n|'n')\s*bass\b|\bdnb\b|\bd\s*&\s*b\b|\bjungle\b|\bliquid\b|\bneuro(funk)?\b|\breese\b/, 'dnb'],
  [/\bedm\b|\bfestival\b|\belectro\b|\bdance\b/, 'edm'],
  [/\bhouse\b|\btechno\b|four on the floor|\bdisco\b/, 'house'],
  [/\breggaeton\b|\bdembow\b|\blatin\b/, 'reggaeton'],
  [/\bafro\s*-?\s*beats?\b|\bamapiano\b|\bafro\b/, 'afro'],
  [/\bpop\b|\bradio\b/, 'pop'],
];

/** Tempos the generator accepts from a prompt (BPM). */
const MIN_PROMPT_BPM = 50;
const MAX_PROMPT_BPM = 220;

/**
 * What the offline generator reads after one more request in the same conversation: the earlier requests, then this
 * one. A style named now replaces the earlier style (the first style word in the text wins, so "now make it drum and
 * bass" after "trance" would still have been trance); everything else ("no hats", "in D minor") carries on.
 */
export function mergeOfflinePrompt(previous: string, next: string): string {
  let kept = previous;
  if (parsePrompt(next).style) {
    for (const [re] of STYLE_WORDS) kept = kept.replace(new RegExp(re.source, 'gi'), ' ');
  }
  return `${kept} ${next}`.replace(/\s+/g, ' ').trim();
}

/** The tempo named in a (lower-case) prompt: the last "N bpm", else the last "at N"; null when absent or out of range. */
function tempoIn(text: string): number | null {
  // The last tempo named wins: a request later in the conversation ("make it 120 bpm") overrides an earlier one.
  const named =
    [...text.matchAll(/(\d{2,3})\s*(?:bpm|beats per minute)/g)].at(-1) ??
    [...text.matchAll(/\bat (\d{2,3})\b/g)].at(-1);
  if (!named) return null;
  const bpm = Number(named[1]);
  return bpm >= MIN_PROMPT_BPM && bpm <= MAX_PROMPT_BPM ? bpm : null;
}

/** The first style word in the prompt. */
function styleIn(text: string): Style | undefined {
  for (const [re, style] of STYLE_WORDS) if (re.test(text)) return style;
  return undefined;
}

/** The key named in the prompt: "in D minor" (the last one), or a bare "f# minor" / "bb major". */
function keyIn(text: string): PromptInfo['key'] {
  const bare = text.match(
    /\b(?:in\s+)?([a-g])\s*(#|♯|b|♭|sharp|flat)?\s*(m(?:in(?:or)?)?|maj(?:or)?)?\b(?=\s|$|[,.!])/,
  );
  const after = [...text.matchAll(/\bin\s+([a-g])\s*(#|♯|b|♭|sharp|flat)?\s*(m(?:in(?:or)?)?|maj(?:or)?)?\b/g)].at(-1);
  const found = after ?? (bare && (bare[2] || bare[3]) ? bare : null);
  if (!found) return undefined;
  let root = NOTE_NAMES[found[1] as string] as number;
  if (found[2] === '#' || found[2] === '♯' || found[2] === 'sharp') root += 1;
  if (found[2] === 'b' || found[2] === '♭' || found[2] === 'flat') root -= 1;
  return { root: (root + 12) % 12, minor: !found[3]?.startsWith('maj') };
}

/** −1 (simpler) … +1 (busier) from the words that ask for either. */
function densityIn(text: string): number {
  let density = 0;
  if (
    /\bbusy\b|\bbusier\b|\bmore\b|\bcrazy\b|\bhard(er)?\b|\baggressive\b|\benergetic\b|\bfast(er)? hats\b/.test(text)
  ) {
    density += 1;
  }
  if (/\bsimple\b|\bsimpler\b|\bminimal\b|\bsparse\b|\bless\b|\bchill\b|\bcalm\b/.test(text)) density -= 1;
  return Math.max(-1, Math.min(1, density));
}

/** Reads a request: tempo, style, key, how busy, and which parts the user asks for or leaves out. */
export function parsePrompt(prompt: string): PromptInfo {
  const text = prompt.toLowerCase();
  const info: PromptInfo = {
    density: 0,
    wants808: /\b808s?\b|\bsub\b/.test(text),
    wantsMelody: /\bmelod|\blead\b|\bpluck|\bchords?\b|\bkeys\b|\bpiano\b/.test(text),
    noHats: /\bno (hi-?)?hats?\b|\bwithout (hi-?)?hats?\b/.test(text),
    drumsOnly: /\b(only|just) drums\b|\bdrums only\b/.test(text),
  };
  const bpm = tempoIn(text);
  if (bpm !== null) info.bpm = bpm;
  const style = styleIn(text);
  if (style) info.style = style;
  const key = keyIn(text);
  if (key) info.key = key;
  info.density = densityIn(text);
  return info;
}
