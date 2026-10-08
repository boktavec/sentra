/**
 * Runs `tick` on an interval without overlapping: a beat is skipped while the previous tick is
 * still working. `stop` waits for an in-flight tick. Shared by the background loops in the API.
 */
export function createPoller(tick: () => Promise<unknown>) {
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<unknown> | undefined;
  return {
    start(intervalMs: number) {
      timer = setInterval(() => {
        running ??= tick().finally(() => (running = undefined));
      }, intervalMs);
      timer.unref();
    },
    async stop() {
      clearInterval(timer);
      await running;
    },
  };
}
