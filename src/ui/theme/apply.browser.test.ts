/**
 * The accent that really paints the page, read back from the computed --ag-accent in headless Chrome
 * (the CSS cascade is what decides it, so a Node test can't check it).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { applyTheme, THEMES } from './apply';
import './tokens.css';
import './themes.css';
import './base.css';

const root = document.documentElement;
const accentNow = () => getComputedStyle(root).getPropertyValue('--ag-accent').trim().toLowerCase();

/** Gold in each theme: the brushed gold, except Carrara, which deepens it for its white stone. */
const GOLD: Record<string, string> = {
  marble: '#c9a45c',
  carrara: '#a8823c',
  classic: '#c9a45c',
  midnight: '#c9a45c',
  graphite: '#c9a45c',
  light: '#c9a45c',
};

/** The high-contrast themes keep their own accent, picked or not: it is part of what makes them readable. */
const HIGH_CONTRAST: Record<string, string> = {
  contrast: '#ffd60a',
  'contrast-light': '#0033cc',
};
const regularThemes = () => THEMES.filter((t) => !(t.id in HIGH_CONTRAST));

describe('Gold accent on the page', () => {
  afterAll(() => {
    delete root.dataset.theme;
    delete root.dataset.accent;
  });

  it('shows gold in all six regular themes once Gold is picked', () => {
    expect(THEMES.map((t) => t.id).sort()).toEqual([...Object.keys(GOLD), ...Object.keys(HIGH_CONTRAST)].sort());
    for (const t of regularThemes()) {
      applyTheme(t.id, 'gold', true);
      expect(accentNow(), `${t.id} / Gold`).toBe(GOLD[t.id]);
      expect(accentNow(), `${t.id} / Gold is not orange`).not.toBe('#ff9a3c');
    }
  });

  it('keeps each theme default for users who never picked an accent', () => {
    for (const t of regularThemes()) {
      applyTheme(t.id, 'gold', false);
      const slate = ['classic', 'midnight', 'graphite', 'light'].includes(t.id);
      expect(accentNow(), `${t.id} / default`).toBe(slate ? '#ff9a3c' : GOLD[t.id]);
    }
  });

  it('keeps the high-contrast accent whether or not an accent was picked', () => {
    for (const [id, accent] of Object.entries(HIGH_CONTRAST)) {
      applyTheme(id as never, 'gold', true);
      expect(accentNow(), `${id} / Gold picked`).toBe(accent);
      applyTheme(id as never, 'gold', false);
      expect(accentNow(), `${id} / default`).toBe(accent);
    }
  });
});
