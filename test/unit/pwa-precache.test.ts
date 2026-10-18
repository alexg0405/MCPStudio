import { describe, expect, it } from 'vitest';
import { isPrecached, precacheList, type BuiltFile } from '../../tools/pwa/precache';

const file = (path: string, text: string): BuiltFile => ({ path, bytes: new TextEncoder().encode(text) });

const build = (): BuiltFile[] => [
  file('index.html', '<html>app</html>'),
  file('assets/index-abc.js', 'main'),
  file('assets/PianoRoll-def.js', 'roll'),
  file('assets/PianoRoll-def.css', 'roll css'),
  file('assets/limiter.worklet-ghi.js', 'worklet'),
  file('favicon.svg', '<svg/>'),
  file('manifest.webmanifest', '{}'),
  file('icons/icon-192.png', 'png'),
  file('sw.js', 'the worker itself'),
  file('assets/index-abc.js.map', 'map'),
  file('.DS_Store', 'junk'),
];

describe('precache list', () => {
  it('lists the app’s files as site-root paths, sorted, without the worker, maps and hidden files', () => {
    expect(precacheList(build()).urls).toEqual([
      '/assets/PianoRoll-def.css',
      '/assets/PianoRoll-def.js',
      '/assets/index-abc.js',
      '/assets/limiter.worklet-ghi.js',
      '/favicon.svg',
      '/icons/icon-192.png',
      '/index.html',
      '/manifest.webmanifest',
    ]);
  });

  it('holds the shell page the worker falls back to', () => {
    expect(precacheList(build()).urls).toContain('/index.html');
  });

  it('knows what is skipped', () => {
    expect(isPrecached('sw.js')).toBe(false);
    expect(isPrecached('assets/sw.js')).toBe(true);
    expect(isPrecached('assets/a.js.map')).toBe(false);
    expect(isPrecached('icons/.keep')).toBe(false);
    expect(isPrecached('assets/a.js')).toBe(true);
  });

  it('gives the same build id for the same build, in any file order', () => {
    const a = precacheList(build()).buildId;
    expect(a).toMatch(/^[0-9a-f]{12}$/);
    expect(precacheList(build().reverse()).buildId).toBe(a);
    expect(precacheList(build()).buildId).toBe(a);
  });

  it('changes the build id when a file’s content or name changes, or one is added (a new worker, a new cache)', () => {
    const base = precacheList(build()).buildId;
    const edited = build();
    edited[0] = file('index.html', '<html>app v2</html>');
    expect(precacheList(edited).buildId).not.toBe(base);
    const renamed = build();
    renamed[1] = file('assets/index-xyz.js', 'main');
    expect(precacheList(renamed).buildId).not.toBe(base);
    expect(precacheList([...build(), file('assets/new-123.js', 'x')]).buildId).not.toBe(base);
  });

  it('does not change the build id for files that are not cached', () => {
    const base = precacheList(build()).buildId;
    const other = build().map((f) => (f.path === 'sw.js' ? file('sw.js', 'a different worker') : f));
    expect(precacheList(other).buildId).toBe(base);
  });
});
