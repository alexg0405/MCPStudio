import { describe, expect, it } from 'vitest';
import { decodePcm, encodeWav } from './wav';

const LSB16 = 1 / 32768;
const LSB24 = 1 / 8388608;

/** Deterministic test signal: two sines plus noise, peaking just under `amp`. */
function signal(frames: number, seed: number, amp = 0.95): Float32Array {
  let s = seed >>> 0;
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const noise = s / 4294967296 - 0.5;
    out[i] = amp * (0.6 * Math.sin(i * 0.031 + seed) + 0.25 * Math.sin(i * 0.47) + 0.15 * noise);
  }
  return out;
}

function maxError(a: Float32Array, b: Float32Array): number {
  expect(b.length).toBe(a.length);
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs((a[i] as number) - (b[i] as number)));
  return m;
}

/** Little helper to assemble binary test files. */
class Writer {
  private bytes: number[] = [];
  constructor(private readonly le: boolean) {}
  tag(t: string) {
    for (const c of t) this.bytes.push(c.charCodeAt(0));
    return this;
  }
  u8(v: number) {
    this.bytes.push(v & 0xff);
    return this;
  }
  u16(v: number) {
    return this.le ? this.u8(v).u8(v >> 8) : this.u8(v >> 8).u8(v);
  }
  u32(v: number) {
    return this.le ? this.u16(v & 0xffff).u16(v >>> 16) : this.u16(v >>> 16).u16(v & 0xffff);
  }
  raw(data: ArrayLike<number>) {
    for (let i = 0; i < data.length; i++) this.bytes.push((data[i] as number) & 0xff);
    return this;
  }
  /** IEEE 754 80-bit extended, big-endian (AIFF sample rates). */
  ext80(value: number) {
    const exp = Math.floor(Math.log2(value));
    const mant = value / 2 ** exp; // [1, 2)
    const hi = Math.floor(mant * 2 ** 31) >>> 0;
    const lo = Math.floor((mant * 2 ** 31 - Math.floor(mant * 2 ** 31)) * 2 ** 32) >>> 0;
    return this.u16(exp + 16383)
      .u16(hi >>> 16)
      .u16(hi & 0xffff)
      .u16(lo >>> 16)
      .u16(lo & 0xffff);
  }
  get length() {
    return this.bytes.length;
  }
  done(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}

/** RIFF (little-endian) or FORM (big-endian) container from [id, payload] chunks, with padding. */
function container(kind: 'RIFF' | 'FORM', type: string, chunks: [string, Uint8Array][], pad = true): Uint8Array {
  const le = kind === 'RIFF';
  const body = new Writer(le).tag(type);
  for (const [id, payload] of chunks) {
    body.tag(id).u32(payload.length).raw(payload);
    if (pad && payload.length & 1) body.u8(0);
  }
  const b = body.done();
  return new Writer(le).tag(kind).u32(b.length).raw(b).done();
}

const le = () => new Writer(true);
const be = () => new Writer(false);

function fmtChunk(format: number, channels: number, rate: number, bits: number, blockAlign: number): Uint8Array {
  return le()
    .u16(format)
    .u16(channels)
    .u32(rate)
    .u32(rate * blockAlign)
    .u16(blockAlign)
    .u16(bits)
    .done();
}

function extensibleFmt(sub: number, channels: number, rate: number, bits: number, validBits: number): Uint8Array {
  const blockAlign = (channels * bits) / 8;
  return le()
    .raw(fmtChunk(0xfffe, channels, rate, bits, blockAlign))
    .u16(22)
    .u16(validBits)
    .u32(channels === 2 ? 3 : 4)
    .u16(sub)
    .raw([0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71])
    .done();
}

function smplChunk(unity: number, loops: [start: number, endInclusive: number][]): Uint8Array {
  const w = le().u32(0).u32(0).u32(22675).u32(unity).u32(0).u32(0).u32(0).u32(loops.length).u32(0);
  loops.forEach(([start, end], i) => w.u32(i).u32(0).u32(start).u32(end).u32(0).u32(0));
  return w.done();
}

function commChunk(channels: number, frames: number, bits: number, rate: number, compression?: string): Uint8Array {
  const w = be().u16(channels).u32(frames).u16(bits).ext80(rate);
  if (compression) w.tag(compression).u8(0).u8(0); // empty pstring, padded to even
  return w.done();
}

function ssndChunk(data: Uint8Array, offset = 0): Uint8Array {
  return be().u32(offset).u32(0).raw(new Uint8Array(offset)).raw(data).done();
}

describe('encodeWav', () => {
  const frames = 4096;
  const left = signal(frames, 1);
  const right = signal(frames, 2, 0.7);

  it('round-trips 16-bit PCM within 1 LSB without dither', () => {
    const decoded = decodePcm(encodeWav([left, right], 44100, { bitDepth: 16 }));
    expect(decoded?.sampleRate).toBe(44100);
    expect(decoded?.channels).toHaveLength(2);
    expect(maxError(left, decoded!.channels[0]!)).toBeLessThanOrEqual(LSB16);
    expect(maxError(right, decoded!.channels[1]!)).toBeLessThanOrEqual(LSB16);
    // Plain rounding is accurate to half a step.
    expect(maxError(left, decoded!.channels[0]!)).toBeLessThanOrEqual(LSB16 / 2 + 1e-12);
  });

  it('round-trips 16-bit PCM within 2 LSB with TPDF dither, deterministically per seed', () => {
    const a = encodeWav([left, right], 48000, { bitDepth: 16, dither: true, seed: 7 });
    const decoded = decodePcm(a)!;
    expect(maxError(left, decoded.channels[0]!)).toBeLessThanOrEqual(2 * LSB16);
    expect(maxError(right, decoded.channels[1]!)).toBeLessThanOrEqual(2 * LSB16);
    expect(encodeWav([left, right], 48000, { bitDepth: 16, dither: true, seed: 7 })).toEqual(a);
    expect(encodeWav([left, right], 48000, { bitDepth: 16, dither: true, seed: 8 })).not.toEqual(a);
    expect(encodeWav([left, right], 48000, { bitDepth: 16 })).not.toEqual(a);
    // No seed: still deterministic.
    const d1 = encodeWav([left], 48000, { bitDepth: 16, dither: true });
    expect(encodeWav([left], 48000, { bitDepth: 16, dither: true })).toEqual(d1);
  });

  it('dithers with zero-mean noise', () => {
    const quiet = new Float32Array(20000).fill(0.25 * LSB16);
    const decoded = decodePcm(encodeWav([quiet], 48000, { bitDepth: 16, dither: true, seed: 3 }))!.channels[0]!;
    const mean = decoded.reduce((s, x) => s + x, 0) / decoded.length;
    // Undithered, 0.25 LSB rounds to silence; dithered, the average keeps the level.
    expect(mean / LSB16).toBeCloseTo(0.25, 1);
  });

  it('round-trips 24-bit PCM within 1 LSB', () => {
    const decoded = decodePcm(encodeWav([left, right], 96000, { bitDepth: 24 }))!;
    expect(decoded.sampleRate).toBe(96000);
    expect(maxError(left, decoded.channels[0]!)).toBeLessThanOrEqual(LSB24);
    expect(maxError(right, decoded.channels[1]!)).toBeLessThanOrEqual(LSB24);
  });

  it('round-trips 32-bit float exactly', () => {
    const decoded = decodePcm(encodeWav([left, right], 44100, { bitDepth: 32 }))!;
    expect(decoded.channels[0]).toEqual(left);
    expect(decoded.channels[1]).toEqual(right);
  });

  it('clips to [-1, 1] and turns NaN into silence', () => {
    const x = Float32Array.from([1.5, -2, 1, -1, NaN, Infinity, -Infinity]);
    expect(Array.from(decodePcm(encodeWav([x], 8000, { bitDepth: 32 }))!.channels[0]!)).toEqual([
      1, -1, 1, -1, 0, 1, -1,
    ]);
    const v16 = new DataView(encodeWav([x], 8000, { bitDepth: 16 }).buffer, 44);
    expect([0, 1, 2, 3, 4, 5, 6].map((i) => v16.getInt16(i * 2, true))).toEqual([
      32767, -32768, 32767, -32768, 0, 32767, -32768,
    ]);
    const b24 = encodeWav([x], 8000, { bitDepth: 24 }).subarray(44);
    const s24 = (i: number) => ((b24[i * 3]! | (b24[i * 3 + 1]! << 8) | (b24[i * 3 + 2]! << 16)) << 8) >> 8;
    expect([0, 1, 4].map(s24)).toEqual([8388607, -8388608, 0]);
  });

  it('interleaves channels frame by frame', () => {
    const l = Float32Array.from([0.1, 0.2, 0.3]);
    const r = Float32Array.from([-0.1, -0.2, -0.3]);
    const c = Float32Array.from([0.5, 0.6, 0.7]);
    const v = new DataView(encodeWav([l, r, c], 8000, { bitDepth: 16 }).buffer, 44);
    const got = Array.from({ length: 9 }, (_, i) => v.getInt16(i * 2, true));
    const q = (x: number) => Math.round(x * 32768);
    expect(got).toEqual([0.1, -0.1, 0.5, 0.2, -0.2, 0.6, 0.3, -0.3, 0.7].map((x) => q(Math.fround(x))));
  });

  it('writes correct 16-bit PCM headers', () => {
    const bytes = encodeWav([new Float32Array(10), new Float32Array(10)], 44100, { bitDepth: 16 });
    const v = new DataView(bytes.buffer);
    const tag = (o: number) => String.fromCharCode(...bytes.subarray(o, o + 4));
    expect(bytes.length).toBe(44 + 40);
    expect(tag(0)).toBe('RIFF');
    expect(v.getUint32(4, true)).toBe(bytes.length - 8);
    expect(tag(8)).toBe('WAVE');
    expect(tag(12)).toBe('fmt ');
    expect(v.getUint32(16, true)).toBe(16);
    expect(v.getUint16(20, true)).toBe(1); // PCM
    expect(v.getUint16(22, true)).toBe(2);
    expect(v.getUint32(24, true)).toBe(44100);
    expect(v.getUint32(28, true)).toBe(44100 * 4); // byte rate
    expect(v.getUint16(32, true)).toBe(4); // block align
    expect(v.getUint16(34, true)).toBe(16);
    expect(tag(36)).toBe('data');
    expect(v.getUint32(40, true)).toBe(40);
  });

  it('pads odd-sized 24-bit data and counts the pad byte in the RIFF size', () => {
    const bytes = encodeWav([new Float32Array(3)], 48000, { bitDepth: 24 });
    const v = new DataView(bytes.buffer);
    expect(v.getUint32(28, true)).toBe(48000 * 3);
    expect(v.getUint16(32, true)).toBe(3);
    expect(v.getUint16(34, true)).toBe(24);
    expect(v.getUint32(40, true)).toBe(9); // data size excludes the pad
    expect(bytes.length).toBe(44 + 9 + 1);
    expect(v.getUint32(4, true)).toBe(bytes.length - 8);
    expect(decodePcm(bytes)!.channels[0]).toHaveLength(3);
  });

  it('writes IEEE float headers with cbSize and a fact chunk', () => {
    const bytes = encodeWav([new Float32Array(5), new Float32Array(5)], 48000, { bitDepth: 32 });
    const v = new DataView(bytes.buffer);
    const tag = (o: number) => String.fromCharCode(...bytes.subarray(o, o + 4));
    expect(v.getUint32(16, true)).toBe(18);
    expect(v.getUint16(20, true)).toBe(3); // IEEE float
    expect(v.getUint32(28, true)).toBe(48000 * 8);
    expect(v.getUint16(32, true)).toBe(8);
    expect(v.getUint16(34, true)).toBe(32);
    expect(v.getUint16(36, true)).toBe(0); // cbSize
    expect(tag(38)).toBe('fact');
    expect(v.getUint32(42, true)).toBe(4);
    expect(v.getUint32(46, true)).toBe(5); // frames per channel
    expect(tag(50)).toBe('data');
    expect(v.getUint32(54, true)).toBe(40);
    expect(bytes.length).toBe(58 + 40);
    expect(v.getUint32(4, true)).toBe(bytes.length - 8);
  });

  it('rejects inconsistent input', () => {
    expect(() => encodeWav([], 44100, { bitDepth: 16 })).toThrow(RangeError);
    expect(() => encodeWav([new Float32Array(2), new Float32Array(3)], 44100, { bitDepth: 16 })).toThrow(RangeError);
    expect(() => encodeWav([new Float32Array(2)], 0, { bitDepth: 16 })).toThrow(RangeError);
    expect(() => encodeWav([new Float32Array(2)], 44100.5, { bitDepth: 24 })).toThrow(RangeError);
    expect(() => encodeWav([new Float32Array(2)], 44100, { bitDepth: 8 as 16 })).toThrow(RangeError);
  });
});

describe('decodePcm: WAV', () => {
  it('decodes unsigned 8-bit PCM', () => {
    const wav = container('RIFF', 'WAVE', [
      ['fmt ', fmtChunk(1, 1, 11025, 8, 1)],
      ['data', Uint8Array.from([0, 64, 128, 192, 255])],
    ]);
    const d = decodePcm(wav)!;
    expect(d.sampleRate).toBe(11025);
    expect(Array.from(d.channels[0]!)).toEqual([-1, -0.5, 0, 0.5, 127 / 128]);
  });

  it('decodes 32-bit integer PCM', () => {
    const data = le().u32(0x40000000).u32(0xc0000000).u32(0x7fffffff).u32(0x80000000).done();
    const d = decodePcm(
      container('RIFF', 'WAVE', [
        ['fmt ', fmtChunk(1, 2, 48000, 32, 8)],
        ['data', data],
      ]),
    )!;
    expect(Array.from(d.channels[0]!)).toEqual([0.5, Math.fround(2147483647 / 2147483648)]);
    expect(Array.from(d.channels[1]!)).toEqual([-0.5, -1]);
  });

  it('decodes 64-bit float', () => {
    const data = new Uint8Array(24);
    const v = new DataView(data.buffer);
    [0.25, -0.75, 1e-3].forEach((x, i) => v.setFloat64(i * 8, x, true));
    const d = decodePcm(
      container('RIFF', 'WAVE', [
        ['fmt ', fmtChunk(3, 1, 44100, 64, 8)],
        ['data', data],
      ]),
    )!;
    expect(Array.from(d.channels[0]!)).toEqual([0.25, -0.75, Math.fround(1e-3)]);
  });

  it('decodes WAVE_FORMAT_EXTENSIBLE PCM and float', () => {
    // 24-bit stereo: L = 0.5, R = -0.25.
    const pcm = le().raw([0, 0, 0x40, 0, 0, 0xe0]).done();
    const d24 = decodePcm(
      container('RIFF', 'WAVE', [
        ['fmt ', extensibleFmt(1, 2, 48000, 24, 24)],
        ['data', pcm],
      ]),
    )!;
    expect(Array.from(d24.channels[0]!)).toEqual([0.5]);
    expect(Array.from(d24.channels[1]!)).toEqual([-0.25]);
    // 20 valid bits in a 24-bit container decode the same way (left-justified).
    const d20 = decodePcm(
      container('RIFF', 'WAVE', [
        ['fmt ', extensibleFmt(1, 2, 48000, 24, 20)],
        ['data', pcm],
      ]),
    )!;
    expect(Array.from(d20.channels[0]!)).toEqual([0.5]);
    const f = new Uint8Array(8);
    new DataView(f.buffer).setFloat32(0, 0.125, true);
    new DataView(f.buffer).setFloat32(4, -0.5, true);
    const df = decodePcm(
      container('RIFF', 'WAVE', [
        ['fmt ', extensibleFmt(3, 1, 44100, 32, 32)],
        ['data', f],
      ]),
    )!;
    expect(Array.from(df.channels[0]!)).toEqual([0.125, -0.5]);
    // An unknown sub-format GUID is not PCM.
    const odd = extensibleFmt(1, 1, 44100, 16, 16);
    odd[odd.length - 1] = 0x72;
    expect(
      decodePcm(
        container('RIFF', 'WAVE', [
          ['fmt ', odd],
          ['data', new Uint8Array(4)],
        ]),
      ),
    ).toBeNull();
  });

  it('skips unknown and odd-sized chunks, in any order', () => {
    const data = le().u16(16384).u16(0xc000).done(); // 0.5, -0.5
    const wav = container('RIFF', 'WAVE', [
      ['LIST', Uint8Array.from([1, 2, 3])], // odd size → padded
      ['data', data],
      ['junk', new Uint8Array(5)],
      ['fmt ', fmtChunk(1, 1, 22050, 16, 2)],
    ]);
    expect(Array.from(decodePcm(wav)!.channels[0]!)).toEqual([0.5, -0.5]);
  });

  it('reads files whose writer left out the pad byte after odd-sized chunks', () => {
    const data = le().u16(16384).u16(0xc000).done();
    const chunks: [string, Uint8Array][] = [
      ['fmt ', fmtChunk(1, 1, 22050, 16, 2)],
      ['LIST', Uint8Array.from([1, 2, 3])],
      ['INFO', Uint8Array.from([0x41])],
      ['data', data],
    ];
    for (const pad of [true, false]) {
      expect(Array.from(decodePcm(container('RIFF', 'WAVE', chunks, pad))!.channels[0]!)).toEqual([0.5, -0.5]);
    }
    // An odd chunk at the very end, padded or not.
    expect(decodePcm(container('RIFF', 'WAVE', [...chunks, ['junk', new Uint8Array(3)]], false))).not.toBeNull();
  });

  it('decodes the frames present in a truncated file', () => {
    const full = encodeWav([Float32Array.from([0.5, 0.25, -0.5, -0.25])], 8000, { bitDepth: 16 });
    const cut = full.subarray(0, full.length - 3); // drops 1.5 frames
    expect(Array.from(decodePcm(cut)!.channels[0]!)).toEqual([0.5, 0.25]);
  });

  it('reads the root key and first loop from a smpl chunk', () => {
    const pcm = new Uint8Array(2 * 1000);
    const wav = (smpl: Uint8Array) =>
      container('RIFF', 'WAVE', [
        ['fmt ', fmtChunk(1, 1, 44100, 16, 2)],
        ['data', pcm],
        ['smpl', smpl],
      ]);
    const d = decodePcm(
      wav(
        smplChunk(64, [
          [100, 199],
          [300, 400],
        ]),
      ),
    )!;
    expect(d.rootKey).toBe(64);
    expect(d.loop).toEqual({ start: 100, end: 200 }); // inclusive end → exclusive
    const clamped = decodePcm(wav(smplChunk(200, [[900, 5000]])))!;
    expect(clamped.rootKey).toBeUndefined(); // not a MIDI note
    expect(clamped.loop).toEqual({ start: 900, end: 1000 });
    const none = decodePcm(wav(smplChunk(60, [])))!;
    expect(none.rootKey).toBe(60);
    expect(none.loop).toBeUndefined();
    expect(decodePcm(wav(smplChunk(60, [[2000, 3000]])))!.loop).toBeUndefined();
  });

  it('returns null for unsupported or broken input', () => {
    expect(decodePcm(new Uint8Array(0))).toBeNull();
    expect(decodePcm(Uint8Array.from('not a sound file'.split('').map((c) => c.charCodeAt(0))))).toBeNull();
    expect(
      decodePcm(
        container('RIFF', 'WAVE', [
          ['fmt ', fmtChunk(2, 1, 44100, 4, 256)],
          ['data', new Uint8Array(8)],
        ]),
      ),
    ).toBeNull(); // ADPCM
    expect(decodePcm(container('RIFF', 'WAVE', [['fmt ', fmtChunk(1, 1, 44100, 16, 2)]]))).toBeNull(); // no data
    expect(decodePcm(container('RIFF', 'WAVE', [['data', new Uint8Array(8)]]))).toBeNull(); // no fmt
    expect(decodePcm(container('RIFF', 'AVI ', [['fmt ', fmtChunk(1, 1, 44100, 16, 2)]]))).toBeNull();
  });
});

describe('decodePcm: AIFF / AIFC', () => {
  const be16 = (values: number[]) => {
    const w = be();
    values.forEach((x) => w.u16(x));
    return w.done();
  };

  it('decodes big-endian 16-bit AIFF with an 80-bit sample rate', () => {
    const data = be16([0x4000, 0xc000, 0x2000, 0xe000]); // L 0.5, R -0.5, L 0.25, R -0.25
    const aiff = container('FORM', 'AIFF', [
      ['COMM', commChunk(2, 2, 16, 44100)],
      ['SSND', ssndChunk(data)],
    ]);
    const d = decodePcm(aiff)!;
    expect(d.sampleRate).toBe(44100);
    expect(Array.from(d.channels[0]!)).toEqual([0.5, 0.25]);
    expect(Array.from(d.channels[1]!)).toEqual([-0.5, -0.25]);
  });

  it('reads common sample rates exactly', () => {
    for (const rate of [8000, 11025, 22050, 32000, 44100, 48000, 88200, 96000, 192000]) {
      const aiff = container('FORM', 'AIFF', [
        ['COMM', commChunk(1, 1, 16, rate)],
        ['SSND', ssndChunk(be16([0]))],
      ]);
      expect(decodePcm(aiff)?.sampleRate).toBe(rate);
    }
  });

  it('decodes little-endian sowt AIFC', () => {
    const data = le().u16(0x4000).u16(0xc000).done();
    const aifc = container('FORM', 'AIFC', [
      ['FVER', be().u32(0xa2805140).done()],
      ['COMM', commChunk(1, 2, 16, 48000, 'sowt')],
      ['SSND', ssndChunk(data)],
    ]);
    expect(Array.from(decodePcm(aifc)!.channels[0]!)).toEqual([0.5, -0.5]);
  });

  it('decodes fl32 / FL32 float AIFC', () => {
    const f = new Uint8Array(8);
    new DataView(f.buffer).setFloat32(0, 0.75, false);
    new DataView(f.buffer).setFloat32(4, -0.125, false);
    for (const tag of ['fl32', 'FL32']) {
      const aifc = container('FORM', 'AIFC', [
        ['COMM', commChunk(1, 2, 32, 44100, tag)],
        ['SSND', ssndChunk(f)],
      ]);
      expect(Array.from(decodePcm(aifc)!.channels[0]!)).toEqual([0.75, -0.125]);
    }
  });

  it('decodes signed 8-bit and 24-bit AIFF, honouring the SSND offset', () => {
    const d8 = decodePcm(
      container('FORM', 'AIFF', [
        ['COMM', commChunk(1, 3, 8, 22050)],
        ['SSND', ssndChunk(Uint8Array.from([0x40, 0xc0, 0x00]), 4)],
      ]),
    )!;
    expect(Array.from(d8.channels[0]!)).toEqual([0.5, -0.5, 0]);
    const d24 = decodePcm(
      container('FORM', 'AIFF', [
        ['COMM', commChunk(1, 2, 24, 48000)],
        ['SSND', ssndChunk(Uint8Array.from([0x40, 0, 0, 0xe0, 0, 0]))],
      ]),
    )!;
    expect(Array.from(d24.channels[0]!)).toEqual([0.5, -0.25]);
  });

  it('never reads more frames than COMM declares or SSND holds', () => {
    const aiff = (declared: number) =>
      container('FORM', 'AIFF', [
        ['COMM', commChunk(1, declared, 16, 44100)],
        ['SSND', ssndChunk(be16([0x4000, 0x4000, 0x4000]))],
      ]);
    expect(decodePcm(aiff(2))!.channels[0]).toHaveLength(2);
    expect(decodePcm(aiff(10))!.channels[0]).toHaveLength(3);
  });

  it('reads the base note and sustain loop from INST + MARK', () => {
    const mark = be()
      .u16(2)
      .u16(1)
      .u32(10)
      .u8(5)
      .tag('start') // pstring "start" (6 bytes, even)
      .u16(2)
      .u32(90)
      .u8(3)
      .tag('end')
      .u8(0) // pstring "end" (4 bytes) + pad
      .done();
    const inst = (playMode: number, base = 57) =>
      be().u8(base).u8(0).u8(0).u8(127).u8(1).u8(127).u16(0).u16(playMode).u16(1).u16(2).u16(0).u16(0).u16(0).done();
    const aiff = (instChunk: Uint8Array) =>
      container('FORM', 'AIFF', [
        ['COMM', commChunk(1, 100, 16, 44100)],
        ['MARK', mark],
        ['INST', instChunk],
        ['SSND', ssndChunk(new Uint8Array(200))],
      ]);
    const d = decodePcm(aiff(inst(1)))!;
    expect(d.rootKey).toBe(57);
    expect(d.loop).toEqual({ start: 10, end: 90 });
    const noLoop = decodePcm(aiff(inst(0, 60)))!;
    expect(noLoop.rootKey).toBe(60);
    expect(noLoop.loop).toBeUndefined();
  });

  it('reads AIFF files without pad bytes after odd-sized chunks', () => {
    for (const pad of [true, false]) {
      const aiff = container(
        'FORM',
        'AIFF',
        [
          ['NAME', Uint8Array.from('Pad'.split('').map((c) => c.charCodeAt(0)))],
          ['COMM', commChunk(1, 2, 16, 44100)],
          ['SSND', ssndChunk(be16([0x4000, 0xc000]))],
        ],
        pad,
      );
      expect(Array.from(decodePcm(aiff)!.channels[0]!)).toEqual([0.5, -0.5]);
    }
  });

  it('returns null for compressed AIFC and incomplete files', () => {
    const comp = container('FORM', 'AIFC', [
      ['COMM', commChunk(1, 2, 16, 44100, 'ima4')],
      ['SSND', ssndChunk(new Uint8Array(68))],
    ]);
    expect(decodePcm(comp)).toBeNull();
    expect(decodePcm(container('FORM', 'AIFF', [['COMM', commChunk(1, 2, 16, 44100)]]))).toBeNull();
    expect(decodePcm(container('FORM', 'AIFF', [['SSND', ssndChunk(new Uint8Array(4))]]))).toBeNull();
  });
});
