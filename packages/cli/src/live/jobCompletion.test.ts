import type {LocalRunnerResult} from '@dynobox/runner-local';
import {describe, expect, it} from 'vitest';

import {createRenderContext} from '../terminal/index.js';
import {renderLiveJobCompletion} from './jobCompletion.js';

describe('renderLiveJobCompletion', () => {
  it('renders diagnostics for verification failures', () => {
    const result: LocalRunnerResult = {
      jobId: 'job.test.0',
      scenarioId: 'scenario.test',
      harness: 'claude-code',
      harnessVersion: null,
      iteration: 0,
      status: 'assertion_failed',
      passed: false,
      workDir: '/tmp/work',
      setupResult: {success: true, logs: []},
      httpEvents: [],
      harnessCliMockCallCount: 1,
      cliMockCalls: [
        {
          executable: 'vitest',
          argv: ['run'],
          cwd: '/tmp/work',
          timestamp: 1,
          exitCode: 0,
          stdout: '',
          stderr: '',
        },
      ],
      artifacts: [],
      assertionResults: [],
      verificationFailed: true,
      diagnostics: ['CLI mock handler failed.\n\u001b[2J'],
      warnings: [],
      timing: {setupMs: 0, harnessMs: 0, assertionsMs: 0, totalMs: 0},
    };

    const output = renderLiveJobCompletion(
      result,
      new Map(),
      createRenderContext(),
      {configuredCliMockNames: ['vitest']},
    );

    expect(output).toContain('CLI mock handler failed.');
    expect(output).toContain('\\n\\u001b[2J');
    expect(output).not.toContain('\u001b');
    expect(output).toContain('cli mocks: vitest');
    expect(output).toContain('cli mock: vitest run -> exit 0');
    expect(output.indexOf('cli mocks: vitest')).toBeLessThan(
      output.indexOf('CLI mock handler failed.'),
    );
  });
});
