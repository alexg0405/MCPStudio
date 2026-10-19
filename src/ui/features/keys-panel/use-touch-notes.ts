/**
 * Playing notes with any number of fingers (or a mouse): every finger holds its own note, a finger that slides onto
 * another key plays that one instead (on the piano), and lifting a finger stops its note. The notes go through the same
 * live-note path as the MIDI keyboard and the typing keys (`services.live`), stamped with the touch's own time, so a tap
 * sounds as soon as the engine can play it.
 */
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useServices } from '../../services-context';

/** The element that carries a key or pad: `data-key="60"`. */
const KEY_ATTR = 'data-key';

/** Where a press lands on a key or pad. */
export interface PressPlace {
  element: HTMLElement;
  clientX: number;
  clientY: number;
}

export interface TouchNotesOptions {
  /** How hard a press plays, from where it landed on its key or pad (0-1). */
  velocityAt(place: PressPlace): number;
  /** A finger moving onto another key plays it (a piano glissando); false for pads, which only play when touched. */
  slides: boolean;
}

/** The handlers for the element that holds the keys or pads, and the keys sounding now (for lighting them). */
export interface TouchNotes {
  handlers: {
    onPointerDown(e: ReactPointerEvent<HTMLElement>): void;
    onPointerMove(e: ReactPointerEvent<HTMLElement>): void;
    onPointerUp(e: ReactPointerEvent<HTMLElement>): void;
    onPointerCancel(e: ReactPointerEvent<HTMLElement>): void;
  };
  lit: ReadonlySet<number>;
}

/** The key under a point of the screen (null when it is not on a key). */
function keyUnder(clientX: number, clientY: number): { key: number; element: HTMLElement } | null {
  const element = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>(`[${KEY_ATTR}]`);
  return element ? { key: Number(element.getAttribute(KEY_ATTR)), element } : null;
}

/** Multi-touch notes for the keys or pads inside one element. */
export function useTouchNotes(options: TouchNotesOptions): TouchNotes {
  const services = useServices();
  const [lit, setLit] = useState<ReadonlySet<number>>(() => new Set(services.live.heldKeys()));
  const latest = useRef(options);
  useEffect(() => {
    latest.current = options;
  });
  /** The key each finger holds, and how many fingers hold each key (a key stops when its last finger lifts). */
  const fingers = useRef(new Map<number, number>());
  const holders = useRef(new Map<number, number>());

  useEffect(
    () =>
      services.live.subscribe((e) => {
        if (e.type === 'noteOn' || e.type === 'noteOff') setLit(new Set(services.live.heldKeys()));
      }),
    [services],
  );
  useEffect(() => () => services.live.releaseAll('screen'), [services]);

  const handlers = useMemo<TouchNotes['handlers']>(() => {
    const play = (pointerId: number, key: number, velocity: number, time: number): void => {
      fingers.current.set(pointerId, key);
      holders.current.set(key, (holders.current.get(key) ?? 0) + 1);
      services.live.noteOn(key, velocity, { source: 'screen' }, time);
    };
    const stop = (pointerId: number, time: number): void => {
      const key = fingers.current.get(pointerId);
      if (key === undefined) return;
      fingers.current.delete(pointerId);
      const remaining = (holders.current.get(key) ?? 1) - 1;
      if (remaining > 0) {
        holders.current.set(key, remaining);
        return;
      }
      holders.current.delete(key);
      services.live.noteOff(key, 0.5, { source: 'screen' }, time);
    };

    return {
      onPointerDown(e) {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        const under = keyUnder(e.clientX, e.clientY);
        if (!under) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        const velocity = latest.current.velocityAt({ element: under.element, clientX: e.clientX, clientY: e.clientY });
        play(e.pointerId, under.key, velocity, e.timeStamp);
      },
      onPointerMove(e) {
        if (!latest.current.slides) return;
        const held = fingers.current.get(e.pointerId);
        if (held === undefined) return;
        const under = keyUnder(e.clientX, e.clientY);
        if (!under || under.key === held) return;
        stop(e.pointerId, e.timeStamp);
        const velocity = latest.current.velocityAt({ element: under.element, clientX: e.clientX, clientY: e.clientY });
        play(e.pointerId, under.key, velocity, e.timeStamp);
      },
      onPointerUp(e) {
        stop(e.pointerId, e.timeStamp);
      },
      onPointerCancel(e) {
        stop(e.pointerId, e.timeStamp);
      },
    };
  }, [services]);
  return { handlers, lit };
}
