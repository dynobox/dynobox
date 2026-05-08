/**
 * Spinner: a small interval-driven ticker that emits a frame string every
 * ~80ms. Owns the `setInterval` so the rest of live mode can stay pure.
 */

export const SPINNER_FRAMES = [
  '⠋',
  '⠙',
  '⠹',
  '⠸',
  '⠼',
  '⠴',
  '⠦',
  '⠧',
  '⠇',
  '⠏',
] as const;

export const SPINNER_INTERVAL_MS = 80;

export type Spinner = {
  start: () => void;
  stop: () => void;
};

export function createSpinner(onTick: (frame: string) => void): Spinner {
  let timer: ReturnType<typeof setInterval> | undefined;
  let frameIndex = 0;
  return {
    start(): void {
      if (timer !== undefined) return;
      timer = setInterval(() => {
        frameIndex = (frameIndex + 1) % SPINNER_FRAMES.length;
        const frame = SPINNER_FRAMES[frameIndex] ?? SPINNER_FRAMES[0];
        onTick(frame);
      }, SPINNER_INTERVAL_MS);
      timer.unref?.();
    },
    stop(): void {
      if (timer === undefined) return;
      clearInterval(timer);
      timer = undefined;
      frameIndex = 0;
    },
  };
}
