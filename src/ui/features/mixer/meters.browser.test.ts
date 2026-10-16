import { afterEach, describe, expect, it } from 'vitest';
import { createTestServices } from '@app/testing';
import type { Services } from '@app/services';
import type { InsertId } from '@core/model/types';
import { MeterBank } from './meters';

type Frameable = { frame(s: Services, now: number): void };

const made: (() => void)[] = [];
afterEach(() => {
  for (const fn of made.splice(0)) fn();
});

/** A bank with a canvas per mixer insert, driven by hand (one `step` is one animation frame). */
async function setup(count = 4) {
  const s = createTestServices();
  const ids = s.doc.getState().project.mixer.order.slice(0, count);
  const bank = new MeterBank();
  const canvases = new Map<InsertId, HTMLCanvasElement>();
  for (const id of ids) {
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:20px;height:80px;display:block';
    document.body.appendChild(canvas);
    canvases.set(id, canvas);
    made.push(bank.attach(id, canvas));
    made.push(() => canvas.remove());
  }
  made.push(bank.start(s));
  // The canvases get their size from the resize observer, a frame or two later.
  await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
  await new Promise<void>((r) => requestAnimationFrame(() => r()));
  let now = 1000;
  const reads: InsertId[][] = [];
  const read = s.fakeEngine.readMeters.bind(s.fakeEngine);
  s.fakeEngine.readMeters = (order, out) => {
    reads.push([...order]);
    read(order, out);
  };
  const step = () => (bank as unknown as Frameable).frame(s, (now += 16));
  const lit = (id: InsertId) => {
    const canvas = canvases.get(id)!;
    const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
    return data.some((v, i) => i % 4 === 3 && v > 200);
  };
  return { s, ids, bank, canvases, reads, step, lit };
}

describe('mixer meters (UI)', () => {
  it('reads and draws the strips that are on screen, in one engine call', async () => {
    const { ids, reads, step } = await setup();
    step();
    expect(reads).toEqual([ids]);
  });

  it('leaves strips that scrolled out of view alone, and starts them from silence when they come back', async () => {
    const { s, ids, bank, canvases, reads, step, lit } = await setup();
    const [a, b, c] = ids as [InsertId, InsertId, InsertId];
    s.fakeEngine.meterLevels.set(b, [0.9, 0.9]);
    step();
    expect(lit(b)).toBe(true);

    bank.setVisible(canvases.get(b)!, false);
    reads.length = 0;
    step();
    expect(reads[0]).toEqual(ids.filter((id) => id !== b));
    expect(reads[0]).toContain(a);
    expect(reads[0]).toContain(c);

    // Back in view: its level is read again, and the strip draws it.
    bank.setVisible(canvases.get(b)!, true);
    step();
    expect(reads.at(-1)).toContain(b);
    expect(lit(b)).toBe(true);
  });

  it('does not touch the engine when no strip is on screen', async () => {
    const { bank, canvases, reads, step } = await setup(2);
    for (const canvas of canvases.values()) bank.setVisible(canvas, false);
    step();
    expect(reads).toEqual([]);
  });

  it('draws a changed level once and nothing while it stays the same', async () => {
    const { s, ids, canvases, step } = await setup(1);
    const id = ids[0] as InsertId;
    const canvas = canvases.get(id)!;
    const g = canvas.getContext('2d')!;
    let fills = 0;
    const fillRect = g.fillRect.bind(g);
    g.fillRect = (...args: Parameters<CanvasRenderingContext2D['fillRect']>) => {
      fills++;
      fillRect(...args);
    };
    s.fakeEngine.meterLevels.set(id, [0.5, 0.5]);
    step();
    expect(fills).toBeGreaterThan(0);
    // A level that holds: the same picture, so nothing is painted again (the peak marker holds for 1.5 s).
    const after = fills;
    step();
    step();
    expect(fills).toBe(after);
  });
});
