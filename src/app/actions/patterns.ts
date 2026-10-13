import { makePattern, paletteColor } from '@core/model/defaults';
import { newId } from '@core/model/ids';
import type { PatternId } from '@core/model/types';
import { addPattern, clonePattern, removePattern, setPatternProps } from '@core/ops/playlist';
import type { Services } from '../services';

// User-level pattern actions (each one undoable edit).

function nextName(s: Services): string {
  const names = new Set(Object.values(s.doc.getState().project.patterns).map((p) => p.name));
  for (let i = 1; ; i++) if (!names.has(`Pattern ${i}`)) return `Pattern ${i}`;
}

/** FL's F4: a new empty pattern after the current one, which becomes current. */
export function newPattern(s: Services): PatternId {
  const p = s.doc.getState().project;
  const current = s.view.getState().currentPatternId;
  const pattern = makePattern(nextName(s), paletteColor(p.patternOrder.length), newId.pattern());
  const index = current ? p.patternOrder.indexOf(current) + 1 : p.patternOrder.length;
  s.history.transact('New pattern', (d) => addPattern(d, pattern, index));
  s.view.getState().setCurrentPattern(pattern.id);
  return pattern.id;
}

export function cloneCurrentPattern(s: Services): PatternId | null {
  const current = s.view.getState().currentPatternId;
  const src = current ? s.doc.getState().project.patterns[current] : undefined;
  if (!current || !src) return null;
  const id = newId.pattern();
  s.history.transact('Clone pattern', (d) => clonePattern(d, current, id, `${src.name} #2`));
  s.view.getState().setCurrentPattern(id);
  return id;
}

export function deletePattern(s: Services, id: PatternId): void {
  const p = s.doc.getState().project;
  if (p.patternOrder.length <= 1 || !p.patterns[id]) return;
  const i = p.patternOrder.indexOf(id);
  const fallback = p.patternOrder[i + 1] ?? p.patternOrder[i - 1] ?? null;
  s.history.transact(`Delete ${p.patterns[id]?.name ?? 'pattern'}`, (d) => removePattern(d, id));
  if (s.view.getState().currentPatternId === id) s.view.getState().setCurrentPattern(fallback);
}

export function renamePattern(s: Services, id: PatternId, name: string): void {
  s.history.transact('Rename pattern', (d) => setPatternProps(d, id, { name }));
}

export function stepPattern(s: Services, delta: number): void {
  const order = s.doc.getState().project.patternOrder;
  const current = s.view.getState().currentPatternId;
  const i = current ? order.indexOf(current) : -1;
  const next = order[Math.max(0, Math.min(order.length - 1, i + delta))];
  if (next) s.view.getState().setCurrentPattern(next);
}
