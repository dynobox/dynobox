/**
 * `LiveWriter` — the stateful terminal writer that drives in-place updates
 * during live mode. Owns cursor manipulation (ANSI) and falls back to
 * append-only writes when the host doesn't support escapes.
 *
 * The writer is intentionally dumb about content: it accepts pre-rendered
 * strings (or render closures for animated rows) and is responsible only for
 * placing them on the terminal correctly.
 */

export type LiveRender = (frame: string, nowMs: number) => string;

export type LiveLine =
  | {kind: 'update'; render: LiveRender}
  | {kind: 'commit'; text: string};

export type LiveWriter = {
  /** Begin a new job: prints the headline and resets internal counters. */
  beginJob: (headline: string) => void;
  /** Emit a transient (animated) or committed line. */
  emit: (line: LiveLine) => void;
  /** Re-render the current animated line with a new spinner frame. */
  tick: (frame: string) => void;
  /** Replace the most recent headline (e.g. `running` → `pass`). */
  rewriteHeadline: (headline: string) => void;
  /** Replace the headline AND erase all rows below it, leaving a one-liner. */
  collapseToHeadline: (headline: string) => void;
  /** Commit any pending animated row (call before printing static rows). */
  flush: () => void;
};

const ANSI_ERASE_LINE = '\r\x1b[2K';

export function createLiveWriter(
  write: (value: string) => void,
  supportsAnsi: boolean,
  initialFrame: string,
): LiveWriter {
  let hasPending = false;
  let headlineWritten = false;
  let linesSinceHeadline = 0;
  let currentRender: LiveRender | undefined;
  let currentFrame = initialFrame;

  const eraseLine = (): void => {
    if (supportsAnsi) write(ANSI_ERASE_LINE);
  };

  const clearPending = (): void => {
    if (hasPending) {
      eraseLine();
      hasPending = false;
    }
    currentRender = undefined;
  };

  return {
    beginJob(headline: string): void {
      clearPending();
      write(`${headline}\n`);
      headlineWritten = true;
      linesSinceHeadline = 0;
    },

    emit(line: LiveLine): void {
      if (line.kind === 'update') {
        currentRender = line.render;
        const text = line.render(currentFrame, Date.now());
        if (!supportsAnsi) {
          write(`${text}\n`);
          if (headlineWritten) linesSinceHeadline += 1;
          currentRender = undefined;
          return;
        }
        if (hasPending) eraseLine();
        write(text);
        hasPending = true;
        return;
      }

      currentRender = undefined;
      if (!supportsAnsi) {
        write(`${line.text}\n`);
        if (headlineWritten) linesSinceHeadline += 1;
        return;
      }
      if (hasPending) eraseLine();
      write(`${line.text}\n`);
      hasPending = false;
      if (headlineWritten) linesSinceHeadline += 1;
    },

    tick(frame: string): void {
      currentFrame = frame;
      if (!supportsAnsi || currentRender === undefined || !hasPending) return;
      eraseLine();
      const text = currentRender(frame, Date.now());
      write(text);
    },

    rewriteHeadline(headline: string): void {
      if (!headlineWritten) return;
      if (!supportsAnsi) {
        headlineWritten = false;
        return;
      }
      clearPending();
      const rowsUp = linesSinceHeadline + 1;
      write(`\x1b[${rowsUp}A\r\x1b[2K${headline}\x1b[${rowsUp}B\r`);
      headlineWritten = false;
    },

    collapseToHeadline(headline: string): void {
      if (!headlineWritten) return;
      if (!supportsAnsi) {
        write(`${headline}\n`);
        headlineWritten = false;
        linesSinceHeadline = 0;
        return;
      }
      clearPending();
      const rowsUp = linesSinceHeadline + 1;
      write(`\x1b[${rowsUp}A\r\x1b[J${headline}\n`);
      headlineWritten = false;
      linesSinceHeadline = 0;
    },

    flush(): void {
      if (hasPending) {
        if (supportsAnsi) {
          eraseLine();
        } else {
          write('\n');
        }
        hasPending = false;
      }
      currentRender = undefined;
    },
  };
}
