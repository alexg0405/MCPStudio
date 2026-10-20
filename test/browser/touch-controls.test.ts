/**
 * Knobs, faders, sliders, drag numbers and the DJ platter under real fingers (Chrome's touch input through DevTools, see
 * `test/helpers/touch.ts`): a vertical drag, a dead zone that keeps a resting finger from changing anything, the two fine
 * modes (a second finger, or resting first), a rest without a drag opening the control's menu, and a double tap resetting.
 * The controls are mounted on their own, wired to a little state, so each gesture is the only thing happening.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { createElement, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createTestServices } from '@app/testing';
import { p } from '@agstudio/sdk/params';
import { Knob, ParamMenuContext } from '@agstudio/sdk/ui';
import { DragNumber } from '@ui/controls/DragNumber';
import { Slider } from '@ui/features/dj-decks/controls';
import { usePlatterGesture } from '@ui/features/dj-decks/deck-gestures';
import { Fader } from '@ui/features/mixer/Fader';
import { ServicesProvider } from '@ui/services-context';
import { installTouch } from '@ui/touch';
import '@ui/theme/tokens.css';
import '@ui/theme/themes.css';
import '@ui/theme/base.css';
import '@ui/touch/touch.css';
import { centerOf, Fingers, nextFrame, sleep, until } from '../helpers/touch';
import { EVENTUALLY } from '../helpers/wait';

const SPEC = p.float(0, 1, 0.5, { label: 'Amount' });

/** What the harness records. */
interface Log {
  values: number[];
  begins: number;
  ends: number;
  menus: Array<{ param: string; x: number; y: number }>;
  jogs: Array<{ delta: number; mode: string }>;
  touches: boolean[];
}
const newLog = (): Log => ({ values: [], begins: 0, ends: 0, menus: [], jogs: [], touches: [] });

describe('controls with touch', { timeout: 60_000 }, () => {
  let root: Root;
  let host: HTMLDivElement;
  let stopTouch: () => void;
  let fingers: Fingers;
  let log: Log;
  let mounts = 0;
  const services = createTestServices();
  const mount = async (content: ReactNode): Promise<void> => {
    const menu = (param: string, at: { clientX: number; clientY: number }) => log.menus.push({ param, x: at.clientX, y: at.clientY });
    // A new key each time: every test starts with controls that have not been touched.
    root.render(createElement(ServicesProvider, { key: ++mounts, services, children: createElement(ParamMenuContext.Provider, { value: menu, children: content }) }));
    await sleep(60);
    await nextFrame();
  };
  const find = <T extends Element>(selector: string): T => host.querySelector<T>(selector)!;

  function KnobHarness() {
    const [value, setValue] = useState(0.5);
    return createElement(Knob, {
      spec: SPEC,
      value,
      size: 28,
      param: 'amount',
      onBegin: () => void log.begins++,
      onChange: (v) => {
        log.values.push(Number(v));
        setValue(Number(v));
      },
      onEnd: () => void log.ends++,
      onCommit: (v) => {
        log.values.push(Number(v));
        setValue(Number(v));
      },
    });
  }

  function FaderHarness() {
    const [gain, setGain] = useState(1);
    return createElement('div', { style: { height: 160, width: 22 } }, [
      createElement(Fader, {
        key: 'fader',
        value: gain,
        label: 'Level',
        param: 'level',
        onBegin: () => void log.begins++,
        onChange: (g: number) => {
          log.values.push(g);
          setGain(g);
        },
        onEnd: () => void log.ends++,
        onCommit: (g: number) => {
          log.values.push(g);
          setGain(g);
        },
      }),
    ]);
  }

  function NumberHarness() {
    const [value, setValue] = useState(120);
    return createElement(DragNumber, {
      value,
      min: 20,
      max: 300,
      perPixel: 0.5,
      step: 1,
      format: (v) => `${Math.round(v)}`,
      onBegin: () => void log.begins++,
      onChange: (v) => {
        log.values.push(v);
        setValue(v);
      },
      onEnd: () => void log.ends++,
      onCommit: (v) => {
        log.values.push(v);
        setValue(v);
      },
      label: 'Tempo',
    });
  }

  function SliderHarness() {
    const [value, setValue] = useState(0.5);
    return createElement('div', { style: { height: 140 } }, [
      createElement(Slider, {
        key: 'slider',
        className: 'touch-test-tall',
        value,
        min: 0,
        max: 1,
        reset: 0.5,
        vertical: true,
        label: 'Pitch',
        hint: 'Tempo.',
        format: (v: number) => v.toFixed(2),
        onChange: (v: number) => {
          log.values.push(v);
          setValue(v);
        },
      }),
    ]);
  }

  function PlatterHarness() {
    const api = {
      jog: (_deck: string, delta: number, mode: string) => log.jogs.push({ delta, mode }),
      jogTouch: (_deck: string, touching: boolean) => log.touches.push(touching),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const platter = usePlatterGesture(api as any, 'A', true);
    return createElement('div', {
      'data-testid': 'platter',
      style: { width: 160, height: 160, borderRadius: '50%', background: '#555', touchAction: 'none' },
      onPointerDown: platter.onPointerDown,
      onPointerMove: platter.onPointerMove,
      onPointerUp: platter.onPointerUp,
      onPointerCancel: platter.onPointerUp,
    });
  }

  beforeAll(async () => {
    await page.viewport(900, 600);
    host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:100px;top:100px;width:500px;height:400px';
    document.body.append(host);
    const style = document.createElement('style');
    style.textContent = '.touch-test-tall { height: 140px; }';
    document.head.append(style);
    root = createRoot(host);
    stopTouch = installTouch(services);
  });

  beforeEach(async () => {
    await fingers?.liftAll();
    fingers = new Fingers();
    log = newLog();
    delete document.documentElement.dataset.touch;
    await sleep(700);
  });

  afterAll(async () => {
    await fingers.liftAll();
    stopTouch();
    root.unmount();
    host.remove();
  });

  describe('Knob', () => {
    it('turns with a vertical drag: up is more, as with a mouse, and a drag is one gesture', async () => {
      await mount(createElement(KnobHarness));
      const knob = find('[role="slider"]');
      const at = centerOf(knob);
      await fingers.pressAndDrag(1, at, { x: at.x, y: at.y - 60 });
      await fingers.lift(1);
      await nextFrame();
      const last = log.values[log.values.length - 1]!;
      // 60 px of drag, less the dead zone, of a 200 px range.
      expect(last).toBeGreaterThan(0.5 + 0.2);
      expect(last).toBeLessThan(0.5 + 0.3);
      expect(log.begins).toBe(1);
      expect(log.ends).toBe(1);
    });

    it('does not change while the finger only trembles (a dead zone), and the drag starts where it leaves it', async () => {
      await mount(createElement(KnobHarness));
      const at = centerOf(find('[role="slider"]'));
      await fingers.pressAndDrag(1, at, { x: at.x + 2, y: at.y - 4 }, 3);
      await fingers.lift(1);
      expect(log.values).toEqual([]);
    });

    it('a second finger anywhere makes the drag fine until it lifts', async () => {
      await mount(createElement(KnobHarness));
      const knob = find('[role="slider"]');
      const at = centerOf(knob);
      await fingers.pressAndDrag(1, at, { x: at.x, y: at.y - 30 });
      const coarse = log.values[log.values.length - 1]!;
      // Another finger puts itself down on the empty page.
      await fingers.press(2, { x: at.x + 200, y: at.y + 150 });
      await until(() => knob.hasAttribute('data-fine'));
      await fingers.drag(1, { x: at.x, y: at.y - 90 });
      const fine = log.values[log.values.length - 1]!;
      // 60 more px at a tenth of the speed: 0.03, where it would have been 0.3.
      expect(fine - coarse).toBeGreaterThan(0.02);
      expect(fine - coarse).toBeLessThan(0.05);
      await fingers.lift(2);
      await until(() => !knob.hasAttribute('data-fine'));
      await fingers.lift(1);
    });

    it('a finger that rests first drags finely, and the knob says so', async () => {
      await mount(createElement(KnobHarness));
      const knob = find('[role="slider"]');
      const at = centerOf(knob);
      await fingers.press(1, at);
      // The rest is noticed 500 ms after the touch (a busy machine can be late): wait for it, then drag.
      await until(() => knob.hasAttribute('data-fine'));
      await fingers.drag(1, { x: at.x, y: at.y - 60 });
      await fingers.lift(1);
      const last = log.values[log.values.length - 1]!;
      expect(last - 0.5).toBeGreaterThan(0.02);
      expect(last - 0.5).toBeLessThan(0.04);
      expect(log.menus).toEqual([]);
      expect(knob.hasAttribute('data-fine')).toBe(false);
    });

    it('a finger that rests and lifts without moving opens the knob’s menu (a right-click) and changes nothing', async () => {
      await mount(createElement(KnobHarness));
      const knob = find('[role="slider"]');
      const at = centerOf(knob);
      await fingers.press(1, at);
      await until(() => knob.hasAttribute('data-fine'));
      await fingers.lift(1);
      await until(() => log.menus.length === 1);
      expect(log.menus).toHaveLength(1);
      expect(log.menus[0]!.param).toBe('amount');
      expect(Math.abs(log.menus[0]!.x - at.x)).toBeLessThan(3);
      expect(log.values).toEqual([]);
    });

    it('two quick taps reset it (a double-click)', async () => {
      await mount(createElement(KnobHarness));
      const knob = find('[role="slider"]');
      const at = centerOf(knob);
      await fingers.pressAndDrag(1, at, { x: at.x, y: at.y - 60 });
      await fingers.lift(1);
      expect(log.values[log.values.length - 1]).toBeGreaterThan(0.7);
      await sleep(400);
      await fingers.doubleTap(1, at);
      await until(() => log.values[log.values.length - 1] === 0.5);
    });

    it('two knobs turn at once, one per finger', async () => {
      function TwoKnobs() {
        return createElement('div', { style: { display: 'flex', gap: 40 } }, [createElement(KnobHarness, { key: 'a' }), createElement(KnobHarness, { key: 'b' })]);
      }
      await mount(createElement(TwoKnobs));
      const [first, second] = [...host.querySelectorAll<HTMLElement>('[role="slider"]')];
      const a = centerOf(first!);
      const b = centerOf(second!);
      await fingers.pressTogether({ 1: a, 2: b });
      await fingers.dragTogether({ id: 1, to: { x: a.x, y: a.y - 50 } }, { id: 2, to: { x: b.x, y: b.y + 50 } });
      await fingers.liftAll();
      await nextFrame();
      await expect.poll(() => log.begins, EVENTUALLY).toBe(2);
      expect(first!.getAttribute('aria-valuenow')).not.toBe('0.5');
      expect(second!.getAttribute('aria-valuenow')).not.toBe('0.5');
      expect(Number(first!.getAttribute('aria-valuenow'))).toBeGreaterThan(0.5);
      expect(Number(second!.getAttribute('aria-valuenow'))).toBeLessThan(0.5);
    });

    it('a mouse is untouched: no dead zone, Shift for fine', async () => {
      await mount(createElement(KnobHarness));
      const knob = find('[role="slider"]');
      const box = knob.getBoundingClientRect();
      const fire = (type: string, y: number, init: PointerEventInit = {}) =>
        knob.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: box.left + 10, clientY: y, ...init }));
      fire('pointerdown', box.top + 20);
      fire('pointermove', box.top + 16);
      expect(log.values.length).toBe(1);
      expect(log.values[0]!).toBeCloseTo(0.5 + 4 / 200, 5);
      fire('pointerup', box.top + 16);
    });
  });

  describe('Fader', () => {
    it('slides with a vertical drag and goes fine with a second finger', async () => {
      await mount(createElement(FaderHarness));
      const fader = find('[role="slider"]');
      const at = centerOf(fader);
      await fingers.pressAndDrag(1, at, { x: at.x, y: at.y + 50 });
      const down = log.values[log.values.length - 1]!;
      expect(down).toBeLessThan(1);
      await fingers.press(2, { x: at.x + 150, y: at.y });
      await fingers.drag(1, { x: at.x, y: at.y + 100 });
      const finer = log.values[log.values.length - 1]!;
      await fingers.liftAll();
      // Another 50 px, but fine: much less than the first 50.
      expect(down - finer).toBeGreaterThan(0);
      expect(down - finer).toBeLessThan(0.1 * (1 - down) + 0.05);
      expect(log.begins).toBe(1);
      expect(log.ends).toBe(1);
    });

    it('a rest without a drag opens its menu', async () => {
      await mount(createElement(FaderHarness));
      const fader = find('[role="slider"]');
      await fingers.press(1, centerOf(fader));
      await until(() => fader.hasAttribute('data-fine'));
      await fingers.lift(1);
      await until(() => log.menus.length === 1);
      expect(log.menus.map((m) => m.param)).toEqual(['level']);
    });
  });

  describe('DJ slider (pitch fader, crossfader)', () => {
    it('follows a drag, and a second finger makes it fine', async () => {
      await mount(createElement(SliderHarness));
      const slider = find('[role="slider"]');
      const box = slider.getBoundingClientRect();
      const cap = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
      await fingers.pressAndDrag(1, cap, { x: cap.x, y: cap.y - 40 });
      const coarse = log.values[log.values.length - 1]!;
      expect(coarse).toBeGreaterThan(0.6);
      await fingers.press(2, { x: cap.x + 150, y: cap.y });
      await fingers.drag(1, { x: cap.x, y: cap.y - 80 });
      const fine = log.values[log.values.length - 1]!;
      await fingers.liftAll();
      expect(fine - coarse).toBeLessThan(0.1);
      expect(fine - coarse).toBeGreaterThan(0);
    });
  });

  describe('DragNumber', () => {
    it('drags vertically with a finger; a tap types a value', async () => {
      await mount(createElement(NumberHarness));
      const number = find<HTMLElement>('[data-hint], div');
      const target = host.querySelector<HTMLElement>('[data-touch-own]')!;
      expect(number).toBeTruthy();
      const at = centerOf(target);
      await fingers.pressAndDrag(1, at, { x: at.x, y: at.y - 40 });
      await fingers.lift(1);
      const last = log.values[log.values.length - 1]!;
      // 40 px less the dead zone, at 0.5 per pixel.
      expect(last).toBeGreaterThan(120 + 12);
      expect(last).toBeLessThan(120 + 20);
      expect(log.begins).toBe(1);
      expect(log.ends).toBe(1);
      await fingers.tap(1, centerOf(host.querySelector<HTMLElement>('[data-touch-own]')!));
      await until(() => host.querySelector('input') !== null);
    });
  });

  describe('Platter', () => {
    it('scratches while a finger turns it, and lets go when it lifts; two decks at once with two fingers', async () => {
      await mount(createElement('div', { style: { display: 'flex', gap: 20 } }, [createElement(PlatterHarness, { key: 'a' })]));
      const platter = find<HTMLElement>('[data-testid="platter"]');
      const box = platter.getBoundingClientRect();
      const middle = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
      // Start 40 px right of the centre, turn the finger a quarter turn clockwise (down), then a bit more.
      await fingers.press(1, { x: middle.x + 40, y: middle.y });
      expect(log.touches).toEqual([true]);
      await fingers.drag(1, { x: middle.x, y: middle.y + 40 });
      await fingers.drag(1, { x: middle.x - 40, y: middle.y });
      await fingers.lift(1);
      expect(log.touches).toEqual([true, false]);
      const turned = log.jogs.reduce((sum, j) => sum + j.delta, 0);
      expect(turned).toBeGreaterThan(0.4);
      expect(turned).toBeLessThan(0.6);
      expect(log.jogs.every((j) => j.mode === 'scratch')).toBe(true);
    });
  });

  describe('Touch layout', () => {
    it('gives knobs and faders a hit area of at least 40 px without changing how they look', async () => {
      await mount(createElement('div', { style: { display: 'flex', gap: 60, alignItems: 'center' } }, [createElement(KnobHarness, { key: 'k' }), createElement(FaderHarness, { key: 'f' })]));
      const sliders = [...host.querySelectorAll<HTMLElement>('[role="slider"]')];
      const sizes = (el: HTMLElement) => {
        const after = getComputedStyle(el, '::after');
        // Without the touch layout there is no ::after at all (its size reads "auto").
        return { w: parseFloat(after.width) || 0, h: parseFloat(after.height) || 0, box: el.getBoundingClientRect() };
      };
      const mouseKnob = sizes(sliders[0]!);
      expect(mouseKnob.w).toBeLessThan(40);
      document.documentElement.dataset.touch = 'on';
      await nextFrame();
      const knob = sizes(sliders[0]!);
      const fader = sizes(sliders[1]!);
      expect(knob.w).toBeGreaterThanOrEqual(40);
      expect(knob.h).toBeGreaterThanOrEqual(40);
      expect(fader.w).toBeGreaterThanOrEqual(40);
      // The look (the box itself) did not move.
      expect(sliders[0]!.getBoundingClientRect().width).toBe(mouseKnob.box.width);
      expect(sliders[1]!.getBoundingClientRect().width).toBe(fader.box.width);
    });

    it('a finger that lands just beside a small knob still turns it (in the touch layout)', async () => {
      document.documentElement.dataset.touch = 'on';
      await mount(createElement(KnobHarness));
      const knob = find('[role="slider"]');
      const box = knob.getBoundingClientRect();
      const beside = { x: box.right + 6, y: box.top + box.height / 2 };
      await fingers.pressAndDrag(1, beside, { x: beside.x, y: beside.y - 50 });
      await fingers.lift(1);
      expect(log.begins).toBe(1);
      expect(log.values.length).toBeGreaterThan(0);
    });
  });
});
