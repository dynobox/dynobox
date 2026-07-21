import {execa} from 'execa';

import type {HarnessInput, HarnessRunOutput, ToolEvent} from './types.js';

export type ParsedToolEventLine = {
  toolEvents: ToolEvent[];
};

export type RunStreamingHarnessOptions = {
  executable: string;
  args: readonly string[];
  input: HarnessInput;
  cwd?: string;
  stdin?: 'ignore';
  processInput?: string;
  parseLine: (line: string, lineNumber: number) => ParsedToolEventLine;
  shouldEmit?: (event: ToolEvent, line: string) => boolean;
};

export async function runStreamingHarness(
  options: RunStreamingHarnessOptions,
): Promise<HarnessRunOutput> {
  const input = options.input;
  const execaOptions = {
    cwd: options.cwd ?? input.workDir,
    env: {...process.env, ...input.env},
    reject: false,
    ...(options.stdin === undefined ? {} : {stdin: options.stdin}),
    ...(options.processInput === undefined
      ? {}
      : {input: options.processInput}),
    ...(input.timeoutMs === undefined ? {} : {timeout: input.timeoutMs}),
  };

  const subprocess = execa(options.executable, options.args, execaOptions);
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const streamParser = new ToolEventLineStream({
    parseLine: options.parseLine,
    onToolEvent: (toolEvent) => {
      input.onToolEvent?.(toolEvent);
    },
    ...(options.shouldEmit === undefined
      ? {}
      : {shouldEmit: options.shouldEmit}),
  });

  subprocess.stdout?.on('data', (chunk: Buffer | string) => {
    const text = chunk.toString();
    stdoutChunks.push(text);
    streamParser.write(text);
  });
  subprocess.stderr?.on('data', (chunk: Buffer | string) => {
    stderrChunks.push(chunk.toString());
  });

  const result = await subprocess;
  streamParser.flush();
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';

  return {
    exitCode: result.exitCode ?? 1,
    stdout: stdout.length === 0 ? stdoutChunks.join('') : stdout,
    stderr: stderr.length === 0 ? stderrChunks.join('') : stderr,
    durationMs: result.durationMs,
  };
}

export type ToolEventLineStreamOptions = {
  parseLine: (line: string, lineNumber: number) => ParsedToolEventLine;
  onToolEvent: (event: ToolEvent) => void;
  shouldEmit?: (event: ToolEvent, line: string) => boolean;
};

export class ToolEventLineStream {
  private buffer = '';
  private lineNumber = 0;

  constructor(private readonly options: ToolEventLineStreamOptions) {}

  write(chunk: string): void {
    this.buffer += chunk;

    while (true) {
      const newlineIndex = this.buffer.search(/\r?\n/);
      if (newlineIndex === -1) return;

      const line = this.buffer.slice(0, newlineIndex);
      const newlineLength =
        this.buffer[newlineIndex] === '\r' &&
        this.buffer[newlineIndex + 1] === '\n'
          ? 2
          : 1;
      this.buffer = this.buffer.slice(newlineIndex + newlineLength);
      this.parseLine(line);
    }
  }

  flush(): void {
    if (this.buffer.trim().length === 0) return;
    this.parseLine(this.buffer);
    this.buffer = '';
  }

  private parseLine(rawLine: string): void {
    const line = rawLine.trim();
    if (line.length === 0) return;

    this.lineNumber += 1;
    try {
      const parsed = this.options.parseLine(line, this.lineNumber);
      for (const toolEvent of parsed.toolEvents) {
        if (this.options.shouldEmit?.(toolEvent, line) === false) continue;
        this.options.onToolEvent(toolEvent);
      }
    } catch {
      // Final extraction reports malformed stdout with precise line numbers.
    }
  }
}
