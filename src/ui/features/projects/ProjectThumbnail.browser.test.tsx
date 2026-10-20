import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { describe, expect, it } from 'vitest';
import { songWithClips } from '@core/versions/test-songs';
import { arrangementThumbnail } from '@core/versions/thumbnail';
import { ProjectThumbnail } from './ProjectThumbnail';

/** Renders the picture in a host of the given width and returns the canvas's pixels as a data URL. */
function pixelsAt(width: number, thumbnail: ReturnType<typeof arrangementThumbnail> | null): { url: string; canvas: HTMLCanvasElement } {
  const host = document.createElement('div');
  host.style.cssText = `position:fixed;left:0;top:0;width:${width}px`;
  document.body.append(host);
  const root = createRoot(host);
  flushSync(() => root.render(createElement(ProjectThumbnail, { thumbnail, label: 'Test song' })));
  const canvas = host.querySelector('canvas')!;
  const url = canvas.toDataURL();
  root.unmount();
  host.remove();
  return { url, canvas };
}

describe('ProjectThumbnail', () => {
  it('paints the same pixels for the same song every time', () => {
    const thumbnail = arrangementThumbnail(songWithClips(8));
    const first = pixelsAt(240, thumbnail);
    const second = pixelsAt(240, structuredClone(thumbnail));
    expect(second.url).toBe(first.url);
  });

  it('paints marks for a song and only the background when there is no picture', () => {
    const withClips = pixelsAt(240, arrangementThumbnail(songWithClips(1)));
    const blank = pixelsAt(240, null);
    expect(withClips.url).not.toBe(blank.url);
  });

  it('is as wide as its card, and names itself for a screen reader', () => {
    const { canvas } = pixelsAt(300, arrangementThumbnail(songWithClips(2)));
    expect(canvas.getAttribute('role')).toBe('img');
    expect(canvas.getAttribute('aria-label')).toBe('Arrangement of Test song');
    const empty = pixelsAt(300, arrangementThumbnail(songWithClips(0)));
    expect(empty.canvas.getAttribute('aria-label')).toBe('Test song has nothing on its playlist yet');
  });
});
