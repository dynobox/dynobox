export type LiveRender = (frame: string, nowMs: number) => string;

export type LiveLine =
  | {kind: 'update'; render: LiveRender}
  | {kind: 'commit'; text: string}
  | {kind: 'skip'};

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
  initialFrame: string,
  options: {stderr?: Pick<NodeJS.WriteStream, 'write'>} = {},
): LiveDashboard {
  let blocks: DashboardBlockState[] = [];
  let renderedLineCount = 0;
  let frame = initialFrame;
  let stderrLineOpen = false;
  let restoreStderr: (() => void) | undefined;
  const stderr = options.stderr ?? process.stderr;

  const renderBlock = (block: DashboardBlockState, nowMs: number): string[] => {
    const lines = block.headline.split('\n');
    if (block.phase !== undefined) {
      lines.push(
        typeof block.phase === 'string'
          ? block.phase
          : block.phase(frame, nowMs),
      );
    }
    return lines;
  };

  const erase = (): void => {
    if (renderedLineCount > 0) {
      write(`\x1b[${renderedLineCount}A\r\x1b[J`);
    }
    renderedLineCount = 0;
  };

  const redraw = (): void => {
    if (stderrLineOpen) return;
    const lines = blocks.flatMap((block) => renderBlock(block, Date.now()));
    erase();
    if (lines.length > 0) write(`${lines.join('\n')}\n`);
    renderedLineCount = lines.length;
  };

  const watchStderr = (): void => {
    if (restoreStderr !== undefined) return;
    const originalWrite = stderr.write;
    let writing = false;
    const writeStderr = function (this: unknown, ...args: unknown[]): boolean {
      const [chunk, encoding] = args;
      const bytes =
        typeof chunk === 'string'
          ? Buffer.from(
              chunk,
              typeof encoding === 'string'
                ? (encoding as BufferEncoding)
                : undefined,
            )
          : chunk instanceof Uint8Array
            ? chunk
            : undefined;
      if (writing || bytes === undefined || bytes.length === 0)
        return Reflect.apply(originalWrite, this, args) as boolean;

      writing = true;
      try {
        // Third-party console errors bypass CLI writers. Remove the live
        // region before printing, then anchor it below the complete message.
        erase();
        const accepted = Reflect.apply(originalWrite, this, args) as boolean;
        stderrLineOpen = bytes[bytes.length - 1] !== 0x0a;
        return accepted;
      } finally {
        writing = false;
        redraw();
      }
    };
    stderr.write = writeStderr;
    restoreStderr = () => {
      if (stderr.write === writeStderr) stderr.write = originalWrite;
    };
  };

  return {
    start(nextBlocks): void {
      blocks = nextBlocks.map((block) => ({headline: block.headline}));
      watchStderr();
      redraw();
    },

    setHeadline(index, headline, clearPhase = false): void {
      const block = blocks[index];
      if (block === undefined) return;
      block.headline = headline;
      if (clearPhase) delete block.phase;
      redraw();
    },

    emit(index, line): void {
      if (line.kind === 'skip') return;
      const block = blocks[index];
      if (block === undefined) return;
      block.phase = line.kind === 'commit' ? line.text : line.render;
      redraw();
    },

    tick(nextFrame): void {
      frame = nextFrame;
      if (blocks.some((block) => typeof block.phase === 'function')) {
        redraw();
      }
    },

    clear(): void {
      try {
        erase();
        if (stderrLineOpen) write('\n');
      } finally {
        blocks = [];
        renderedLineCount = 0;
        stderrLineOpen = false;
        restoreStderr?.();
        restoreStderr = undefined;
      }
    },
  };
}
