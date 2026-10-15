import { describe, expect, it } from 'vitest';
import { BudgetCache } from './budget-cache';

/** A stand-in for an AudioBuffer: `n` bytes. */
const cache = (budget: number) => new BudgetCache<{ n: number }>(budget, (v) => v.n);

describe('BudgetCache', () => {
  it('keeps everything within the budget and counts the bytes', () => {
    const c = cache(100);
    c.set('a', { n: 40 });
    c.set('b', { n: 40 });
    expect(c.usedBytes).toBe(80);
    expect(c.keys()).toEqual(['a', 'b']);
    c.set('a', { n: 10 });
    expect(c.usedBytes).toBe(50);
  });

  it('evicts the least recently used entries first', () => {
    const c = cache(100);
    c.set('a', { n: 40 });
    c.set('b', { n: 40 });
    c.get('a'); // a is now the most recent
    c.set('c', { n: 40 });
    expect(c.keys()).toEqual(['a', 'c']);
    expect(c.stats().evictions).toBe(1);
    c.touch('a');
    c.set('d', { n: 40 });
    expect(c.keys()).toEqual(['a', 'd']);
  });

  it('never evicts pinned entries (pinned before or after loading), and evicts them once released', () => {
    const c = cache(100);
    const releaseA = c.pin('a');
    c.set('a', { n: 60 });
    c.set('b', { n: 60 });
    // b doesn't fit next to the pinned a: b goes, a stays.
    expect(c.keys()).toEqual(['a']);
    const releaseC = c.pin('c');
    c.set('c', { n: 60 });
    // Both pinned: over budget, nothing can go.
    expect(c.usedBytes).toBe(120);
    expect(c.stats().pinnedBytes).toBe(120);
    releaseA();
    releaseA(); // twice is harmless
    expect(c.keys()).toEqual(['c']);
    expect(c.isPinned('c')).toBe(true);
    releaseC();
    expect(c.isPinned('c')).toBe(false);
    expect(c.keys()).toEqual(['c']);
  });

  it('counts pins: a key stays pinned until every pin is released', () => {
    const c = cache(10);
    const r1 = c.pin('a');
    const r2 = c.pin('a');
    c.set('a', { n: 50 });
    r1();
    expect(c.has('a')).toBe(true);
    r2();
    expect(c.has('a')).toBe(false);
  });

  it('shares one load per key, stores its result and reloads after eviction', async () => {
    const c = cache(100);
    let loads = 0;
    const load = async () => {
      loads++;
      await new Promise((r) => setTimeout(r, 1));
      return { n: 30 };
    };
    const [x, y] = await Promise.all([c.getOrLoad('a', load), c.getOrLoad('a', load)]);
    expect(x).toBe(y);
    expect(loads).toBe(1);
    expect(await c.getOrLoad('a', load)).toBe(x);
    expect(loads).toBe(1);
    c.set('b', { n: 80 }); // evicts a
    expect(c.has('a')).toBe(false);
    const z = await c.getOrLoad('a', load);
    expect(loads).toBe(2);
    expect(z).not.toBe(x);
    expect(c.has('b')).toBe(false);
  });

  it('a failed load resolves null and is not stored', async () => {
    const c = cache(100);
    expect(await c.getOrLoad('a', () => Promise.reject(new Error('no')))).toBeNull();
    expect(await c.getOrLoad('a', async () => null)).toBeNull();
    expect(c.has('a')).toBe(false);
    expect(c.isPending('a')).toBe(false);
  });

  it('drops unpinned entries by key, keeps pinned ones, and evicts when the budget shrinks', () => {
    const c = cache(1000);
    c.set('e:x:48000', { n: 10 });
    c.set('e:x:48000|rev', { n: 10 });
    c.set('e:y:48000', { n: 10 });
    const release = c.pin('e:x:48000');
    expect(c.deleteWhere((k) => k.startsWith('e:x:'))).toBe(1);
    expect(c.keys()).toEqual(['e:x:48000', 'e:y:48000']);
    release();
    c.budgetBytes = 10;
    expect(c.keys()).toEqual(['e:y:48000']);
    expect(c.stats().peakBytes).toBe(30);
  });
});
