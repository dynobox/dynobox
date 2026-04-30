import type {
  Harness,
  HarnessInput,
  HarnessResult,
  HarnessRunOutput,
  ToolEvent,
} from './types.js';

/**
 * A fake harness that returns configurable canned responses.
 * Used for contract tests and integration-style tests that should not
 * spawn a real agent process.
 */
export class FakeHarness implements Harness {
  // This is a tempoorary hard coded id value
  readonly id = 'claude-code' as const;

  private readonly response: HarnessRunOutput;
  private readonly toolEvents: ToolEvent[];

  constructor(
    response?: Partial<HarnessRunOutput>,
    options?: {toolEvents?: ToolEvent[]},
  ) {
    this.response = {
      exitCode: 0,
      stdout: 'fake output',
      stderr: '',
      durationMs: 100,
      ...response,
    };
    this.toolEvents = options?.toolEvents ?? [];
  }

  async run(_input: HarnessInput): Promise<HarnessRunOutput> {
    return this.response;
  }

  extractResult(raw: HarnessRunOutput): HarnessResult {
    return {
      exitCode: raw.exitCode,
      durationMs: raw.durationMs,
      transcript: raw.stdout,
      finalMessage: raw.stdout || undefined,
      toolEvents: this.toolEvents,
    };
  }
}
