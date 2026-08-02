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
      cliMockCalls: [],
      artifacts: [],
      assertionResults: [],
      diagnostics: ['CLI mock handler failed.'],
      warnings: [],
      timing: {setupMs: 0, harnessMs: 0, assertionsMs: 0, totalMs: 0},
    };

    const output = renderLiveJobCompletion(
      result,
      new Map(),
      createRenderContext(),
    );

    expect(output).toContain('CLI mock handler failed.');
  });
});
