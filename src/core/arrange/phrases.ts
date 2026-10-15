/**
 * Phrase rules: what changes inside a section so a loop never just repeats.
 * - Every 8 bars (house and EDM: 16) a fill replaces the drums: 2 beats at energy ≥ 3, else 1; the
 *   fill rotates by style; at energy ≥ 4 a crash marks the next bar.
 * - Every 4 bars (house and EDM: 8) a small change: a hat roll or an 808 slide (trap, drill, EDM,
 *   pop), an open hat on the last 8th or an 808 slide (the other styles).
 * - Energy ≥ 4 sections of 16+ bars double the hats in bars 9–16.
 * - The guarantee: identical clips never run for more than 4 bars (a 2-bar loop is never followed by
 *   more than one identical copy); where they would, a small change goes at the 4-bar mark.
 * The section's last bars belong to the transition out of it (`end` events), never to a phrase.
 */
import { PHRASE, type Style } from '../beat/style';
import type { Tick, VariantKind } from '../model/types';
import type { FillChoice, VaryMode } from './sections';

const BEAT = 960;

/** A change inside a section (section-relative ticks). */
export interface PhraseEvent {
  kind: VariantKind;
  from: Tick;
  to: Tick;
  energy: number;
  level?: number;
  parts?: string[];
  /** The whole change spans [from, from + total) (a snare build). */
  total?: Tick;
  why: 'section' | 'phrase' | 'small' | 'end';
}

/** What a section's patterns can play (see `capabilities`). */
export interface SectionCaps {
  drums: boolean;
  hats: boolean;
  openHat: boolean;
  slide: boolean;
}

export interface PhraseInput {
  bars: number;
  barTicks: Tick;
  energy: number;
  style: Style;
  vary: VaryMode;
  fill: FillChoice;
  caps: SectionCaps;
  /** The shortest drum or bass loop playing, in bars (0: none). */
  loopBars: number;
  /** The section's position in the song (small changes start at a different point each section). */
  index: number;
  /** Parts left out of the whole section, and how thin its drums play (1–2, or 0). */
  without?: string[];
  thin?: number;
}

/** Fills each style rotates through. */
export const FILL_ROTATION: Record<Style, readonly VariantKind[]> = {
  trap: ['snare-fill', 'hat-fill', 'snare-fill', 'kick-fill'],
  drill: ['hat-fill', 'snare-fill', 'kick-fill'],
  boombap: ['snare-fill', 'kick-fill', 'tom-fill'],
  lofi: ['snare-fill', 'tom-fill', 'kick-fill'],
  house: ['snare-fill', 'tom-fill', 'hat-fill'],
  edm: ['snare-fill', 'tom-fill', 'snare-fill'],
  reggaeton: ['snare-fill', 'kick-fill', 'tom-fill'],
  afro: ['tom-fill', 'snare-fill', 'hat-fill'],
  pop: ['tom-fill', 'snare-fill', 'kick-fill'],
};

const ROLL_STYLES: ReadonlySet<Style> = new Set(['trap', 'drill', 'edm', 'pop']);

const CHOSEN: Record<Exclude<FillChoice, 'auto' | 'none'>, VariantKind> = {
  snare: 'snare-fill',
  tom: 'tom-fill',
  hat: 'hat-fill',
  kick: 'kick-fill',
};

/** The next fill of the song (the rotation counter moves on). */
export function nextFill(style: Style, choice: FillChoice, rotation: { fill: number }): VariantKind | null {
  if (choice === 'none') return null;
  if (choice !== 'auto') return CHOSEN[choice];
  const list = FILL_ROTATION[style];
  const kind = list[rotation.fill % list.length]!;
  rotation.fill++;
  return kind;
}

/** Small changes a style alternates between, best first, limited to what the patterns can play. */
function smallKinds(style: Style, caps: SectionCaps): VariantKind[] {
  const out: VariantKind[] = [];
  const first: VariantKind | null = ROLL_STYLES.has(style) ? (caps.hats ? 'hat-roll' : null) : caps.openHat ? 'open-hat' : caps.hats ? 'hat-roll' : null;
  if (first) out.push(first);
  if (caps.slide) out.push('slide');
  if (!out.length && caps.drums) out.push('snare-fill');
  return out;
}

const fillBeatsAt = (energy: number) => (energy >= 3 ? 2 : 1);

/** The section's whole-section changes, phrase fills and small changes, plus phrase crashes (section ticks). */
export function phraseEvents(
  input: PhraseInput,
  end: readonly PhraseEvent[],
  rotation: { fill: number },
): { events: PhraseEvent[]; crashes: Tick[] } {
  const { bars, barTicks: bar, energy, style } = input;
  const length = bars * bar;
  const events: PhraseEvent[] = [];
  const crashes: Tick[] = [];
  if (input.without?.length) events.push({ kind: 'without', from: 0, to: length, energy, parts: [...input.without], why: 'section' });
  if (input.thin) events.push({ kind: 'thin', from: 0, to: length, energy, level: input.thin, why: 'section' });
  if (input.vary !== 'none' && energy >= 4 && bars >= 16 && input.caps.hats)
    events.push({ kind: 'double-hats', from: 8 * bar, to: 16 * bar, energy, why: 'section' });
  // Bars the transition out of the section uses.
  const reservedFrom = end.length ? Math.floor(Math.min(...end.map((e) => e.from)) / bar) * bar : length;
  const free = (barNo: number) => barNo * bar <= reservedFrom;
  const phrase = PHRASE[style];
  const small = input.vary === 'more' ? 2 : phrase.small;
  const kinds = smallKinds(style, input.caps);
  let smallTurn = input.index;
  const changed = new Set<number>();
  const addSmall = (barNo: number) => {
    if (!kinds.length) return false;
    const kind = kinds[smallTurn++ % kinds.length]!;
    events.push({ kind, from: barNo * bar - BEAT, to: barNo * bar, energy, why: 'small' });
    changed.add(barNo);
    return true;
  };
  if (input.vary !== 'none' && (input.caps.drums || input.caps.slide)) {
    for (let b = 1; b <= bars; b++) {
      if (!free(b)) break;
      if (b % phrase.fill === 0 && input.caps.drums && input.fill !== 'none') {
        const kind = nextFill(style, input.fill, rotation);
        if (kind) {
          const beats = fillBeatsAt(energy);
          events.push({ kind, from: b * bar - beats * BEAT, to: b * bar, energy, why: 'phrase' });
          changed.add(b);
          if (energy >= 4 && b < bars) crashes.push(b * bar);
          continue;
        }
      }
      if (input.vary !== 'less' && b % small === 0) addSmall(b);
    }
    if (input.loopBars > 0) guarantee(input, events, end, changed, addSmall, free);
  }
  const order = (e: PhraseEvent) => (e.why === 'section' ? 0 : 1);
  return { events: [...events, ...end].sort((a, b) => order(a) - order(b) || a.from - b.from || a.to - b.to), crashes };
}

/** A clip's content as far as the events go (identical signatures play identically). */
function signature(events: readonly PhraseEvent[], from: Tick, to: Tick): string {
  return events
    .filter((e) => e.from < to && e.to > from)
    .map((e) => `${e.kind}:${Math.max(e.from, from) - from}:${Math.min(e.to, to) - from}:${e.level ?? ''}:${(e.parts ?? []).join(',')}`)
    .sort()
    .join('|');
}

/** Breaks runs of identical clips longer than 4 bars with a small change at the 4-bar mark. */
function guarantee(
  input: PhraseInput,
  events: PhraseEvent[],
  end: readonly PhraseEvent[],
  changed: Set<number>,
  addSmall: (barNo: number) => boolean,
  free: (barNo: number) => boolean,
): void {
  const bar = input.barTicks;
  const loop = input.loopBars * bar;
  const length = input.bars * bar;
  const count = Math.floor(length / loop);
  const all = () => [...events, ...end];
  for (let guard = 0; guard < 64; guard++) {
    const sigs = Array.from({ length: count }, (_, k) => signature(all(), k * loop, (k + 1) * loop));
    let fixed = false;
    for (let i = 0; i < count && !fixed; ) {
      let j = i;
      while (j + 1 < count && sigs[j + 1] === sigs[i]) j++;
      const run = j - i + 1;
      if (run >= 2 && run * input.loopBars > 4) {
        const m = Math.max(1, Math.floor(4 / input.loopBars));
        const target = i + m - 1;
        const barNo = Math.round(((target + 1) * loop) / bar);
        if (free(barNo) && !changed.has(barNo) && addSmall(barNo)) {
          fixed = true;
          break;
        }
      }
      i = j + 1;
    }
    if (!fixed) return;
  }
}
