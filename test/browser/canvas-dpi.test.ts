/**
 * Canvases redraw when the screen's pixel ratio changes (the window moves to another monitor, the browser
 * zooms): otherwise they stay at the old backing size, blurry, until something else makes them redraw.
 */
import { describe, expect, it, vi } from 'vitest';

describe('pixel ratio changes (UI)', () => {
  it('redraws theme listeners when the resolution query fires, and keeps watching afterwards', async () => {
    const queries: { media: string; listeners: Set<() => void> }[] = [];
    const real = window.matchMedia.bind(window);
    window.matchMedia = ((media: string) => {
      if (!media.includes('resolution')) return real(media);
      const listeners = new Set<() => void>();
      queries.push({ media, listeners });
      return {
        media,
        matches: true,
        addEventListener: (_: string, fn: () => void) => listeners.add(fn),
        removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
      } as unknown as MediaQueryList;
    }) as typeof window.matchMedia;
    try {
      const { onThemeChange, themeVersion } = await import('@ui/timeline/canvas');
      const redraw = vi.fn();
      const off = onThemeChange(redraw);
      expect(queries).toHaveLength(1);
      expect(queries[0]!.media).toContain(`${window.devicePixelRatio}dppx`);
      const v0 = themeVersion();
      for (const fn of [...queries[0]!.listeners]) fn();
      expect(redraw).toHaveBeenCalledTimes(1);
      expect(themeVersion()).toBe(v0 + 1);
      // Re-armed for the next change (the query names the ratio it watches).
      expect(queries).toHaveLength(2);
      for (const fn of [...queries[1]!.listeners]) fn();
      expect(redraw).toHaveBeenCalledTimes(2);
      off();
    } finally {
      window.matchMedia = real;
    }
  });
});
