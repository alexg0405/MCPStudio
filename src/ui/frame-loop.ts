/**
 * One requestAnimationFrame loop for everything that animates outside React: playhead, meters,
 * the position display, drag previews. Callbacks run in registration order and must not throw.
 */
export type FrameCallback = (now: number) => void;

const callbacks = new Set<FrameCallback>();
let handle = 0;

/**
 * Optional timing of the JS work done per animation frame (all callbacks together), for performance
 * checks (`window.__ag.perf.frames` in dev). Off unless `recording` is set: then every frame's cost in
 * ms is pushed to `samples`.
 */
export const frameStats = { recording: false, samples: [] as number[] };

function tick(now: number) {
  handle = 0;
  const t0 = frameStats.recording ? performance.now() : 0;
  for (const cb of callbacks) {
    try {
      cb(now);
    } catch (err) {
      console.error('frame callback failed', err);
    }
  }
  if (frameStats.recording) frameStats.samples.push(performance.now() - t0);
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
