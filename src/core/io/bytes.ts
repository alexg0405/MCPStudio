/**
 * Byte-array helpers. The app is cross-origin isolated, so views of SharedArrayBuffer memory can
 * show up; Web Crypto, Blob and the File System APIs only accept ArrayBuffer-backed views.
 */

/** True when the view's memory is a SharedArrayBuffer (realm-independent check). */
export function isSharedMemory(bytes: Uint8Array): boolean {
  return Object.prototype.toString.call(bytes.buffer) === '[object SharedArrayBuffer]';
}

/** The view itself when it is ArrayBuffer-backed, otherwise a copy that is. */
export function unsharedBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return (isSharedMemory(bytes) ? bytes.slice() : bytes) as Uint8Array<ArrayBuffer>;
}

/** An ArrayBuffer holding exactly the view's bytes (the view's own buffer when that already fits). */
export function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const whole = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength;
  return whole && !isSharedMemory(bytes) ? (bytes.buffer as ArrayBuffer) : bytes.slice().buffer;
}
