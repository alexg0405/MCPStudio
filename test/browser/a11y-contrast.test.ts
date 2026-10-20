/**
 * Colour contrast of the theme tokens, computed from the real CSS (headless Chrome resolves every `color-mix()` and
 * `var()`): text pairs must reach 4.5:1 and the colours that mark things (focus ring, keyboard cursor, notes, meters,
 * lights) 3:1, in every theme, with each accent, with "more contrast" on and with the colour-blind safe palette.
 * The two High contrast themes are held to the strict level (7:1 for text).
 *
 * The colour-blind half checks that the safe palette's meter and note colours stay apart for the three kinds of colour
 * blindness (simulated with the usual linear-RGB matrices) and that the meter's low, middle and high colours differ in
 * lightness too, so they never depend on hue alone.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { rgbaOf, type RGBA } from '@ui/timeline/canvas';
import { ACCENTS, THEMES } from '@ui/theme/apply';
import '@ui/theme/tokens.css';
import '@ui/theme/themes.css';
import '@ui/theme/base.css';

const root = document.documentElement;
let probe: HTMLElement;

beforeAll(() => {
  probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;left:-99px;top:0;width:1px;height:1px';
  document.body.append(probe);
});

afterEach(() => {
  for (const name of ['data-theme', 'data-accent', 'data-contrast', 'data-palette']) root.removeAttribute(name);
});

/** A token as the colour Chrome computes for it (color-mix, var and all), as red, green, blue, alpha. */
function token(name: string): RGBA {
  probe.style.color = '';
  probe.style.color = `var(${name})`;
  return rgbaOf(getComputedStyle(probe).color);
}

/** `top` laid over the opaque `under`. */
function over(top: RGBA, under: RGBA): RGBA {
  const a = top[3];
  return [top[0] * a + under[0] * (1 - a), top[1] * a + under[1] * (1 - a), top[2] * a + under[2] * (1 - a), 1];
}

function channel(v: number): number {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function lightness([r, g, b]: RGBA): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** The WCAG contrast ratio of two opaque colours (1 to 21). */
function ratio(a: RGBA, b: RGBA): number {
  const [hi, lo] = [lightness(a), lightness(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

interface Pair {
  name: string;
  fg: string;
  bg: string;
  /** What translucent colours are laid over first (default: --ag-surface-1). */
  base?: string;
  min: number;
  /** The pair depends on the accent colour (the accent matrix checks only these). */
  accent?: boolean;
}

const SURFACES = ['--ag-bg', '--ag-workspace', '--ag-surface-1', '--ag-surface-2', '--ag-surface-3', '--ag-surface-inset', '--ag-title', '--ag-title-focused', '--ag-grid-bg'];

/** The text pairs of a theme at level `text` (4.5 or 7) and the marks at level `marks` (3 or 4.5). */
function pairsFor(text: number, marks: number): Pair[] {
  const pairs: Pair[] = [];
  for (const bg of SURFACES) pairs.push({ name: `text on ${bg}`, fg: '--ag-text', bg, min: text });
  for (const bg of ['--ag-surface-1', '--ag-surface-2', '--ag-title', '--ag-grid-bg']) {
    pairs.push({ name: `dim text on ${bg}`, fg: '--ag-text-dim', bg, min: text });
    pairs.push({ name: `faint text on ${bg}`, fg: '--ag-text-faint', bg, min: text });
  }
  pairs.push({ name: 'text on hover', fg: '--ag-text', bg: '--ag-hover', min: text });
  pairs.push({ name: 'text on raised', fg: '--ag-text', bg: '--ag-raised', min: text });
  pairs.push({ name: 'text on active', fg: '--ag-text', bg: '--ag-active', min: text });
  pairs.push({ name: 'text on glass', fg: '--ag-text', bg: '--ag-glass-strong', base: '--ag-bg', min: text });
  pairs.push({ name: 'accent ink on surface 1', fg: '--ag-accent-ink', bg: '--ag-surface-1', min: text, accent: true });
  pairs.push({ name: 'accent ink on surface 2', fg: '--ag-accent-ink', bg: '--ag-surface-2', min: text, accent: true });
  pairs.push({ name: 'ink on accent', fg: '--ag-on-accent', bg: '--ag-accent', min: text, accent: true });
  pairs.push({ name: 'LCD text', fg: '--ag-lcd-text', bg: '--ag-lcd', min: text });
  pairs.push({ name: 'LCD alt text', fg: '--ag-lcd-text-alt', bg: '--ag-lcd', min: text });
  pairs.push({ name: 'tooltip text', fg: '--ag-tooltip-text', bg: '--ag-tooltip', base: '--ag-bg', min: text });
  pairs.push({ name: 'danger text on its tint', fg: '--ag-danger-text', bg: '--ag-danger-tint', base: '--ag-surface-2', min: text });
  pairs.push({ name: 'confirmation text', fg: '--ag-ok-text', bg: '--ag-ok-bg', min: text });
  for (const bg of ['--ag-surface-1', '--ag-surface-2', '--ag-surface-3', '--ag-bg']) pairs.push({ name: `focus ring on ${bg}`, fg: '--ag-focus', bg, min: marks, accent: true });
  pairs.push({ name: 'keyboard cursor on the grid', fg: '--ag-cursor', bg: '--ag-grid-bg', min: marks });
  pairs.push({ name: 'notes on the grid', fg: '--ag-note', bg: '--ag-grid-bg', min: marks });
  pairs.push({ name: 'selected notes on the grid', fg: '--ag-note-selected', bg: '--ag-grid-bg', min: marks });
  pairs.push({ name: 'playhead on the grid', fg: '--ag-playhead', bg: '--ag-grid-bg', min: marks, accent: true });
  for (const meter of ['--ag-meter-lo', '--ag-meter-mid', '--ag-meter-hi']) pairs.push({ name: `${meter} on the meter well`, fg: meter, bg: '--ag-surface-inset', min: marks });
  pairs.push({ name: 'lit LED on surface 1', fg: '--ag-led', bg: '--ag-surface-1', min: marks });
  return pairs;
}

/** The pairs of the current page state that miss their level, as readable lines, and how many were checked. */
function check(text: number, marks: number, only: 'accent' | 'all' = 'all'): { misses: string[]; checked: number; lowest: number } {
  const misses: string[] = [];
  let lowest = Infinity;
  const pairs = pairsFor(text, marks).filter((pair) => only === 'all' || pair.accent);
  for (const pair of pairs) {
    const base = token(pair.base ?? '--ag-surface-1');
    const bg = over(token(pair.bg), over(base, token('--ag-bg')));
    const fg = over(token(pair.fg), bg);
    const value = ratio(fg, bg);
    lowest = Math.min(lowest, value);
    if (value < pair.min) misses.push(`${pair.name}: ${value.toFixed(2)}:1 (needs ${pair.min}:1)`);
  }
  return { misses, checked: pairs.length, lowest };
}

function show(theme: string, accent?: string, extra: Record<string, string> = {}): void {
  if (theme !== 'marble') root.dataset.theme = theme;
  if (accent) root.dataset.accent = accent;
  for (const [name, value] of Object.entries(extra)) root.setAttribute(name, value);
}

const report: string[] = [];

describe('colour contrast of the themes', () => {
  for (const theme of THEMES) {
    const strict = theme.id.startsWith('contrast');
    it(`${theme.label}: text ${strict ? '7' : '4.5'}:1, marks ${strict ? '4.5' : '3'}:1`, () => {
      show(theme.id);
      const { misses, checked, lowest } = check(strict ? 7 : 4.5, strict ? 4.5 : 3);
      report.push(`${theme.label}: ${checked} pairs, lowest ${lowest.toFixed(2)}:1`);
      expect(misses).toEqual([]);
    });

    it(`${theme.label}: still passes with more contrast and with the colour-blind safe palette`, () => {
      show(theme.id, undefined, { 'data-contrast': 'more', 'data-palette': 'safe' });
      const { misses } = check(strict ? 7 : 4.5, strict ? 4.5 : 3);
      expect(misses).toEqual([]);
    });
  }

  it('every accent keeps its text and marks readable on every theme (the contrast themes ignore the accent)', () => {
    const misses: string[] = [];
    let checked = 0;
    for (const theme of THEMES) {
      for (const accent of ACCENTS) {
        show(theme.id, accent.id);
        const strict = theme.id.startsWith('contrast');
        const result = check(strict ? 7 : 4.5, strict ? 4.5 : 3, 'accent');
        checked += result.checked;
        misses.push(...result.misses.map((miss) => `${theme.label} with ${accent.label}: ${miss}`));
        for (const name of ['data-theme', 'data-accent']) root.removeAttribute(name);
      }
    }
    report.push(`every theme with every accent: ${checked} pairs`);
    expect(misses).toEqual([]);
  });

  it('prints the numbers', () => {
    console.info(`Contrast audit:\n${report.join('\n')}`);
  });
});

// ------------------------------------------------------------------------------------------- colour blindness

/** Linear-RGB matrices that show a colour as someone with that kind of colour blindness sees it (Machado et al., severity 1.0). */
const BLINDNESS: Record<string, readonly number[]> = {
  protanopia: [0.152286, 1.052583, -0.204868, 0.114503, 0.786281, 0.099216, -0.003882, -0.048116, 1.051998],
  deuteranopia: [0.367322, 0.860646, -0.227968, 0.280085, 0.672501, 0.047413, -0.01182, 0.04294, 0.968881],
  tritanopia: [1.255528, -0.076749, -0.178779, -0.078411, 0.930809, 0.147602, 0.004733, 0.691367, 0.3039],
};

function toLinear(v: number): number {
  return channel(v);
}

function fromLinear(v: number): number {
  const c = Math.max(0, Math.min(1, v));
  return 255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);
}

function simulate(color: RGBA, matrix: readonly number[]): RGBA {
  const [r, g, b] = [toLinear(color[0]), toLinear(color[1]), toLinear(color[2])];
  const m = matrix as number[];
  return [
    fromLinear(m[0]! * r + m[1]! * g + m[2]! * b),
    fromLinear(m[3]! * r + m[4]! * g + m[5]! * b),
    fromLinear(m[6]! * r + m[7]! * g + m[8]! * b),
    1,
  ];
}

/** A rough distance between two colours in the simulated view (Euclidean in sRGB, 0 to 441). */
function distance(a: RGBA, b: RGBA): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** The least distance two colours need to stay apart when simulated (sRGB units out of 441). */
const MIN_SIMULATED_DISTANCE = 60;

describe('colour-blind safe colours', () => {
  const dark = ['marble', 'classic', 'midnight', 'graphite'];
  const light = ['carrara', 'light', 'contrast-light'];
  for (const theme of [...dark, ...light]) {
    it(`${theme}: the meter, the notes and the lights stay apart for each kind of colour blindness`, () => {
      show(theme, undefined, { 'data-palette': 'safe' });
      const groups: [string, string[]][] = [
        ['meter', ['--ag-meter-lo', '--ag-meter-mid', '--ag-meter-hi']],
        ['a note and a selected note', ['--ag-note', '--ag-note-selected']],
        ['a lit LED and a danger mark', ['--ag-led', '--ag-danger']],
      ];
      const problems: string[] = [];
      for (const [label, names] of groups) {
        const colors = names.map((name) => token(name));
        for (const [kind, matrix] of Object.entries(BLINDNESS)) {
          for (let i = 0; i < colors.length; i++) {
            for (let j = i + 1; j < colors.length; j++) {
              const apart = distance(simulate(colors[i]!, matrix), simulate(colors[j]!, matrix));
              if (apart < MIN_SIMULATED_DISTANCE) problems.push(`${label}: ${names[i]} and ${names[j]} are ${Math.round(apart)} apart for ${kind}`);
            }
          }
        }
      }
      expect(problems).toEqual([]);
    });

    it(`${theme}: the meter's three colours also differ in lightness, so hue is never the only clue`, () => {
      show(theme, undefined, { 'data-palette': 'safe' });
      const lo = lightness(token('--ag-meter-lo'));
      const mid = lightness(token('--ag-meter-mid'));
      const hi = lightness(token('--ag-meter-hi'));
      const steps = [Math.abs(lo - mid), Math.abs(mid - hi), Math.abs(lo - hi)];
      // The hot colour is the darkest or the lightest of the three, clearly different from the cool one.
      expect(steps[2], `${theme}: low and high are too close in lightness`).toBeGreaterThan(0.03);
    });
  }
});
