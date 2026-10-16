/**
 * Relative controls (jog wheels, browse encoders) send "how far it turned" instead of "where it is".
 * Three encodings are common; each maps a 7-bit value to a signed step count (clockwise = positive).
 */
export type RelEncoding = 'twos' | 'signmag' | 'offset64';
export const REL_ENCODINGS: readonly RelEncoding[] = ['twos', 'signmag', 'offset64'];

export const REL_ENCODING_LABEL: Record<RelEncoding, string> = {
  twos: 'Two’s complement (1 = right, 127 = left)',
  signmag: 'Sign and magnitude (1 = right, 65 = left)',
  offset64: 'Centred on 64 (65 = right, 63 = left)',
};

/** Signed steps for a value; 0 means "no movement". */
export function decodeRelative(value: number, encoding: RelEncoding): number {
  const v = value & 0x7f;
  switch (encoding) {
    case 'twos':
      return v < 64 ? v : v - 128;
    case 'signmag':
      return v < 64 ? v : -(v - 64);
    case 'offset64':
      return v - 64;
  }
}
