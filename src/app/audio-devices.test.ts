import { describe, expect, it } from 'vitest';
import { findOutput, type AudioOutput } from './audio-devices';
import { createTestServices } from './testing';

const outputs: AudioOutput[] = [
  { id: '', label: 'System default (MacBook Pro Speakers)' },
  { id: 'a', label: 'MacBook Pro Speakers' },
  { id: 'b', label: 'AirPods Pro' },
  { id: 'c', label: 'Scarlett 2i2 USB' },
];

describe('findOutput', () => {
  it('finds a device by any part of its name, ignoring case', () => {
    expect(findOutput(outputs, 'airpods')?.id).toBe('b');
    expect(findOutput(outputs, 'Scarlett')?.id).toBe('c');
    expect(findOutput(outputs, 'usb')?.id).toBe('c');
  });

  it('prefers an exact name, then a name that starts with it', () => {
    const more = [...outputs, { id: 'd', label: 'Speakers' }];
    expect(findOutput(more, 'speakers')?.id).toBe('d');
    expect(findOutput(more, 'macbook')?.id).toBe('a');
  });

  it('"default" (or nothing) means the system default', () => {
    expect(findOutput(outputs, 'default')?.id).toBe('');
    expect(findOutput(outputs, ' ')?.id).toBe('');
  });

  it('is null when nothing matches', () => {
    expect(findOutput(outputs, 'headphones')).toBeNull();
  });
});

describe('the chosen output device', () => {
  it('goes to the engine when the setting changes', async () => {
    const s = createTestServices();
    s.prefs.getState().set({ outputDevice: 'b' });
    await Promise.resolve();
    expect(s.fakeEngine.outputDevice).toBe('b');
    s.prefs.getState().set({ outputDevice: '' });
    expect(s.fakeEngine.outputDevice).toBe('');
  });
});
