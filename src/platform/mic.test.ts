import { afterEach, describe, expect, it, vi } from 'vitest';
import { micError, MicError, openMic } from './mic';

const dom = (name: string, message = '') => new DOMException(message, name);

describe('microphone errors in plain words', () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ['NotAllowedError', 'Microphone access is blocked. Allow it from the icon in the address bar, then try again.', 'blocked'],
    ['SecurityError', "This page isn't allowed to use the microphone. Open AGstudio from a secure address (https or localhost) and try again.", 'blocked'],
    ['NotFoundError', 'No microphone was found. Plug one in and try again.', 'missing'],
    ['OverconstrainedError', "This audio input isn't available. Pick another one in Options › Audio input.", 'missing'],
    ['NotReadableError', 'The microphone is in use by another app. Close that app and try again.', 'busy'],
    ['AbortError', 'Starting the microphone was interrupted. Try again.', 'failed'],
  ])('%s has its own message', (name, text, kind) => {
    const err = micError(dom(name, 'the browser says something raw'));
    expect(err).toBeInstanceOf(MicError);
    expect(err.message).toBe(text);
    expect(err.kind).toBe(kind);
  });

  it('keeps the browser text in parentheses for errors nobody mapped', () => {
    expect(micError(new Error('Device exploded')).message).toBe("Couldn't start the microphone (Device exploded).");
    expect(micError(dom('TypeError', 'bad constraint')).message).toBe("Couldn't start the microphone (bad constraint).");
    expect(micError(dom('UnknownError')).message).toBe("Couldn't start the microphone (UnknownError).");
    expect(micError('oops').message).toBe("Couldn't start the microphone (oops).");
  });

  it('openMic gives the plain message when the browser refuses', async () => {
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia: async () => Promise.reject(dom('NotReadableError', 'Could not start audio source')) },
    });
    await expect(openMic()).rejects.toThrow('The microphone is in use by another app. Close that app and try again.');
  });

  it('openMic keeps the permission-denied message', async () => {
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia: async () => Promise.reject(dom('NotAllowedError', 'Permission denied')) },
    });
    await expect(openMic()).rejects.toMatchObject({
      kind: 'blocked',
      message: 'Microphone access is blocked. Allow it from the icon in the address bar, then try again.',
    });
  });
});
