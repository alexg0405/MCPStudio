import { describe, expect, it } from 'vitest';
import { pushRecent, searchActions, type ActionEntry } from './search';

const entry = (label: string, path: string[], extra: Partial<ActionEntry> = {}): ActionEntry => ({
  key: `${path.join('/')}/${label}`,
  label,
  path,
  run: () => {},
  ...extra,
});

const ENTRIES = [
  entry('Metronome', ['Options'], { hint: 'Click on every beat while playing' }),
  entry('Mixer', ['View'], { hint: 'Show or hide the mixer' }),
  entry('Export WAV…', ['File'], { hint: 'Render the song to a WAV file' }),
  entry('2 bars', ['Options', 'Count-in']),
  entry('Tempo…', ['Options'], { keywords: ['speed'] }),
  entry('Delete selected channel', ['Channels'], { disabled: true }),
  entry('New pattern', ['Patterns']),
];

const labels = (q: string, recent: string[] = []) => searchActions(ENTRIES, q, recent).map((e) => e.label);

describe('searchActions', () => {
  it('ranks label matches at the start of a word first', () => {
    expect(labels('mix')[0]).toBe('Mixer');
    expect(labels('metro')).toEqual(['Metronome']);
  });

  it('needs every word to match somewhere: label, path, hint or keywords', () => {
    expect(labels('count 2')).toEqual(['2 bars']);
    expect(labels('render song')).toEqual(['Export WAV…']);
    expect(labels('speed')).toEqual(['Tempo…']);
    expect(labels('mixer zebra')).toEqual([]);
  });

  it('understands the words newcomers use', () => {
    expect(labels('bpm')).toEqual(['Tempo…']);
    expect(labels('click')).toContain('Metronome');
    expect(labels('remove channel')).toEqual(['Delete selected channel']);
    expect(labels('add pattern')).toEqual(['New pattern']);
  });

  it('floats recent actions up, and lists them first for an empty query', () => {
    const recent = ['View/Mixer'];
    expect(labels('', recent)[0]).toBe('Mixer');
    expect(labels('m', recent)[0]).toBe('Mixer');
    expect(labels('m')[0]).toBe('Metronome');
  });

  it('puts disabled entries below enabled ones with the same match', () => {
    const list = searchActions(
      [entry('Delete clip', ['Edit'], { disabled: true }), entry('Delete note', ['Edit'])],
      'delete',
    );
    expect(list.map((e) => e.label)).toEqual(['Delete note', 'Delete clip']);
  });
});

describe('pushRecent', () => {
  it('moves a key to the front without duplicates and caps the list', () => {
    expect(pushRecent(['a', 'b', 'c'], 'b')).toEqual(['b', 'a', 'c']);
    expect(pushRecent(['a', 'b', 'c'], 'd', 3)).toEqual(['d', 'a', 'b']);
  });
});
