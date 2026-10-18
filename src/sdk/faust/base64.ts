const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Characters that are not part of the base64 alphabet (padding, line breaks): skipped when decoding. */
const NOT_BASE64 = /[^A-Za-z0-9+/]/g;

/** Base64 to bytes. The AudioWorklet scope has no `atob`, so the Faust kernel decodes its WebAssembly itself. */
export function decodeBase64(text: string): Uint8Array {
  const sixBitValueOf = new Int16Array(128).fill(-1);
  for (let i = 0; i < BASE64_ALPHABET.length; i++) sixBitValueOf[BASE64_ALPHABET.charCodeAt(i)] = i;
  const clean = text.replace(NOT_BASE64, '');
  const bytes = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let pendingBits = 0;
  let accumulator = 0;
  let written = 0;
  for (let i = 0; i < clean.length; i++) {
    accumulator = (accumulator << 6) | (sixBitValueOf[clean.charCodeAt(i)] as number);
    pendingBits += 6;
    if (pendingBits >= 8) {
      pendingBits -= 8;
      bytes[written++] = (accumulator >> pendingBits) & 0xff;
    }
  }
  return bytes.subarray(0, written);
}
