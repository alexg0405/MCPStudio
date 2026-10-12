// A steady 25 ms tick from a Worker: main-thread timers get throttled in background tabs.
const scope = self as unknown as {
  onmessage: ((e: MessageEvent<{ cmd: 'start' | 'stop'; interval?: number }>) => void) | null;
  postMessage(message: unknown): void;
};

let timer: ReturnType<typeof setInterval> | undefined;

scope.onmessage = (e) => {
  if (timer !== undefined) clearInterval(timer);
  timer = undefined;
  if (e.data.cmd === 'start') timer = setInterval(() => scope.postMessage(0), e.data.interval ?? 25);
};
