import type {
  Harness,
  HarnessInput,
  HarnessResult,
  HarnessRunOutput,
} from './types.js';

/**
 * A fake harness that returns configurable canned responses.
 * Used for contract tests and integration-style tests that should not
 * spawn a real agent process.
 */
export class FakeHarness implements Harness {
  readonly id = 'claude-code' as const;

  private readonly response: HarnessRunOutput;

  constructor(response?: Partial<HarnessRunOutput>) {
    this.response = {
      exitCode: 0,
      stdout: 'fake output',
      stderr: '',
      durationMs: 100,
      ...response,
    };
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
    };
  }
}
