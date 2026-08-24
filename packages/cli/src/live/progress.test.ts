import type {LocalRunnerJob} from '@dynobox/runner-local';
import {describe, expect, it} from 'vitest';

import {createRenderContext} from '../terminal/index.js';
import {type LiveJobState, renderLiveProgressEvent} from './progress.js';

describe('renderLiveProgressEvent', () => {
  it('fails the assertions row when CLI mock verification fails', () => {
    const state: LiveJobState = {
      setupCommandCount: 0,
      fixturesCount: 0,
      toolCount: 0,
      assertionCount: 2,
      phaseStartedAtMs: Date.now(),
    };

    const line = renderLiveProgressEvent(
      {
        type: 'assertions.completed',
        job: {} as LocalRunnerJob,
        assertionResults: [
          {
            assertionId: 'one',
            type: 'command.called',
            passed: true,
            message: 'passed',
          },
          {
            assertionId: 'two',
            type: 'command.called',
            passed: true,
            message: 'passed',
          },
        ],
        verificationFailed: true,
      },
      state,
      createRenderContext(),
    );

    expect(line.kind).toBe('commit');
    if (line.kind !== 'commit') throw new Error('Expected committed output.');
    expect(line.text).toContain('✗ assertions');
    expect(line.text).toContain('2 of 2 passed; verification failed');
    expect(line.text).not.toMatch(/\d+\.\d+s/);
  });

  it('omits the passing count for zero-assertion verification failures', () => {
    const state: LiveJobState = {
      setupCommandCount: 0,
      fixturesCount: 0,
      toolCount: 0,
      assertionCount: 0,
      phaseStartedAtMs: Date.now(),
    };

    const line = renderLiveProgressEvent(
      {
        type: 'assertions.completed',
        job: {} as LocalRunnerJob,
        assertionResults: [],
        verificationFailed: true,
      },
      state,
      createRenderContext(),
    );

    expect(line.kind).toBe('commit');
    if (line.kind !== 'commit') throw new Error('Expected committed output.');
    expect(line.text).toContain('verification failed');
    expect(line.text).not.toContain('0 of 0 passed');
  });
});
