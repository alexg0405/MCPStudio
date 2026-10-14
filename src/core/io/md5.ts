/**
 * MD5 (RFC 1321), incremental. FLAC files carry the MD5 of their decoded audio so players and
 * `flac -t` can verify them. Pure TypeScript, no DOM.
 */
const S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15,
  21,
];
const K = new Uint32Array(64);
for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0;

export class Md5 {
  private readonly h = new Uint32Array([0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476]);
  private readonly block = new Uint8Array(64);
  private readonly w = new Uint32Array(16);
  private fill = 0;
  private bytes = 0;

  update(data: Uint8Array): void {
    let i = 0;
    this.bytes += data.length;
    while (i < data.length) {
      const n = Math.min(64 - this.fill, data.length - i);
      this.block.set(data.subarray(i, i + n), this.fill);
      this.fill += n;
      i += n;
      if (this.fill === 64) {
        this.compress();
        this.fill = 0;
      }
    }
  }

  /** The 16-byte digest (the hash can't be updated afterwards). */
  digest(): Uint8Array {
    const bits = this.bytes * 8;
    const pad = new Uint8Array((this.fill < 56 ? 56 : 120) - this.fill + 8);
    pad[0] = 0x80;
    const view = new DataView(pad.buffer);
    view.setUint32(pad.length - 8, bits >>> 0, true);
    view.setUint32(pad.length - 4, Math.floor(bits / 2 ** 32), true);
    this.update(pad);
    const out = new Uint8Array(16);
    const o = new DataView(out.buffer);
    for (let i = 0; i < 4; i++) o.setUint32(i * 4, this.h[i] as number, true);
    return out;
  }

  private compress(): void {
    const w = this.w;
    const b = this.block;
    for (let i = 0; i < 16; i++)
      w[i] = ((b[i * 4] as number) | ((b[i * 4 + 1] as number) << 8) | ((b[i * 4 + 2] as number) << 16) | ((b[i * 4 + 3] as number) << 24)) >>> 0;
    let a = this.h[0] as number;
    let bb = this.h[1] as number;
    let c = this.h[2] as number;
    let d = this.h[3] as number;
    for (let i = 0; i < 64; i++) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (bb & c) | (~bb & d);
        g = i;
      } else if (i < 32) {
        f = (d & bb) | (~d & c);
        g = (5 * i + 1) & 15;
      } else if (i < 48) {
        f = bb ^ c ^ d;
        g = (3 * i + 5) & 15;
      } else {
        f = c ^ (bb | ~d);
        g = (7 * i) & 15;
      }
      const tmp = d;
      d = c;
      c = bb;
      const x = (a + f + (K[i] as number) + (w[g] as number)) >>> 0;
      const s = S[i] as number;
      bb = (bb + ((x << s) | (x >>> (32 - s)))) >>> 0;
      a = tmp;
    }
    this.h[0] = ((this.h[0] as number) + a) >>> 0;
    this.h[1] = ((this.h[1] as number) + bb) >>> 0;
    this.h[2] = ((this.h[2] as number) + c) >>> 0;
    this.h[3] = ((this.h[3] as number) + d) >>> 0;
  }
}

/** Lowercase hex MD5 of some bytes. */
export function md5Hex(data: Uint8Array): string {
  const h = new Md5();
  h.update(data);
  return [...h.digest()].map((x) => x.toString(16).padStart(2, '0')).join('');
}
