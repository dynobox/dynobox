import type {LiveLine, LiveRender} from './writer.js';

export type LiveDashboardBlock = {
  headline: string;
};

export type LiveDashboard = {
  start: (blocks: readonly LiveDashboardBlock[]) => void;
  setHeadline: (index: number, headline: string, clearPhase?: boolean) => void;
  emit: (index: number, line: LiveLine) => void;
  tick: (frame: string) => void;
  clear: () => void;
};

type DashboardBlockState = {
  headline: string;
  phase?: string | LiveRender;
};

/** Redraw all active harness blocks as one terminal region. */
export function createLiveDashboard(
  write: (value: string) => void,
  supportsAnsi: boolean,
  initialFrame: string,
): LiveDashboard {
  let blocks: DashboardBlockState[] = [];
  let renderedLineCount = 0;
  let frame = initialFrame;

  const renderBlock = (block: DashboardBlockState, nowMs: number): string[] => {
    const lines = [block.headline];
    if (block.phase !== undefined) {
      lines.push(
        typeof block.phase === 'string'
          ? block.phase
          : block.phase(frame, nowMs),
      );
    }
    return lines;
  };

  const redraw = (): void => {
    const lines = blocks.flatMap((block) => renderBlock(block, Date.now()));
    if (supportsAnsi && renderedLineCount > 0) {
      write(`\x1b[${renderedLineCount}A\r\x1b[J`);
    }
    if (lines.length > 0) write(`${lines.join('\n')}\n`);
    renderedLineCount = lines.length;
  };

  return {
    start(nextBlocks): void {
      blocks = nextBlocks.map((block) => ({headline: block.headline}));
      if (supportsAnsi) {
        redraw();
      } else if (blocks.length > 0) {
        write(`${blocks.map((block) => block.headline).join('\n')}\n`);
      }
    },

    setHeadline(index, headline, clearPhase = false): void {
      const block = blocks[index];
      if (block === undefined) return;
      block.headline = headline;
      if (clearPhase) delete block.phase;
      if (supportsAnsi) redraw();
    },

    emit(index, line): void {
      if (line.kind === 'skip') return;
      const block = blocks[index];
      if (block === undefined) return;
      block.phase = line.kind === 'commit' ? line.text : line.render;
      if (supportsAnsi) {
        redraw();
      } else {
        const text =
          typeof block.phase === 'string'
            ? block.phase
            : block.phase(frame, Date.now());
        write(`${text}\n`);
      }
    },

    tick(nextFrame): void {
      frame = nextFrame;
      if (
        supportsAnsi &&
        blocks.some((block) => typeof block.phase === 'function')
      ) {
        redraw();
      }
    },

    clear(): void {
      if (supportsAnsi && renderedLineCount > 0) {
        write(`\x1b[${renderedLineCount}A\r\x1b[J`);
      }
      blocks = [];
      renderedLineCount = 0;
    },
  };
}
