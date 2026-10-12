/**
 * One requestAnimationFrame loop for everything that animates outside React: playhead, meters,
 * the position display, drag previews. Callbacks run in registration order and must not throw.
 */
export type FrameCallback = (now: number) => void;

const callbacks = new Set<FrameCallback>();
let handle = 0;

function tick(now: number) {
  handle = 0;
  for (const cb of callbacks) {
    try {
      cb(now);
    } catch (err) {
      console.error('frame callback failed', err);
    }
  }
  if (callbacks.size > 0) handle = requestAnimationFrame(tick);
}

/** Runs `cb` every animation frame until the returned function is called. */
export function onFrame(cb: FrameCallback): () => void {
  callbacks.add(cb);
  if (!handle) handle = requestAnimationFrame(tick);
  return () => {
    callbacks.delete(cb);
  };
}
