/**
 * The version of the plugin SDK (`@agstudio/sdk`) this AGstudio offers, and the small version-range language a plugin
 * bundle uses to say which SDKs it was written for.
 *
 * The SDK's major number goes up only when a change would break existing plugins; minor numbers add things.
 */
export const PLUGIN_SDK_VERSION = '1.0.0';

/** What a range may look like, shown to authors when theirs is wrong. */
export const SDK_RANGE_HELP = 'a range like "^1.0.0", "~1.2.0", ">=1.0.0 <2.0.0", "1.x", "1.0.0" or "*"';

type Version = readonly [major: number, minor: number, patch: number];

function parseVersion(text: string): Version | null {
  const match = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/.exec(text);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compare(a: Version, b: Version): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** One comparison such as ">=1.2.0": true when `version` satisfies it, null when the text is not one. */
function satisfiesTerm(version: Version, term: string): boolean | null {
  if (term === '*' || term === 'x') return true;
  const wildcard = /^(\d{1,6})\.x$/.exec(term);
  if (wildcard) return version[0] === Number(wildcard[1]);
  const operator = /^(\^|~|>=|<=|>|<|=)?(\d{1,6}\.\d{1,6}\.\d{1,6})$/.exec(term);
  if (!operator) return null;
  const base = parseVersion(operator[2] as string) as Version;
  const order = compare(version, base);
  switch (operator[1]) {
    case '^':
      // Same major, at least this version (below 1.0.0 the minor is the breaking number).
      return base[0] === 0 ? version[0] === 0 && version[1] === base[1] && order >= 0 : version[0] === base[0] && order >= 0;
    case '~':
      return version[0] === base[0] && version[1] === base[1] && order >= 0;
    case '>=':
      return order >= 0;
    case '<=':
      return order <= 0;
    case '>':
      return order > 0;
    case '<':
      return order < 0;
    default:
      return order === 0;
  }
}

/** True when `range` is written in the language above. */
export function isValidSdkRange(range: unknown): range is string {
  if (typeof range !== 'string' || range.length > 60 || range.trim() === '') return false;
  const probe: Version = [1, 0, 0];
  return range
    .trim()
    .split(/\s+/)
    .every((term) => satisfiesTerm(probe, term) !== null);
}

/** True when the SDK `version` ("1.0.0") is inside `range`; false for a malformed range or version. */
export function sdkInRange(range: string, version: string = PLUGIN_SDK_VERSION): boolean {
  const parsed = parseVersion(version);
  if (!parsed || !isValidSdkRange(range)) return false;
  return range
    .trim()
    .split(/\s+/)
    .every((term) => satisfiesTerm(parsed, term) === true);
}
