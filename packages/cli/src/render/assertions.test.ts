import type {LocalRunnerJob, LocalRunnerResult} from '@dynobox/runner-local';
import {describe, expect, it} from 'vitest';

import {assertionByIdForJobs} from '../jobs.js';
import {createRenderContext} from '../terminal/index.js';
import {renderAssertionDetails} from './assertions.js';

describe('renderAssertionDetails', () => {
  it('shows assertion labels before assertion descriptions', () => {
    const job = {
      id: 'job.1',
      scenario: {
        id: 'scenario.labels',
        name: 'labels',
        prompt: 'p',
        harnesses: [{id: 'claude-code'}],
        setup: [],
        endpoints: [],
        assertions: [
          {
            id: 'assertion.labels.reads-package',
            label: 'reads package.json',
            kind: 'tool.called',
            toolKind: 'shell',
          },
        ],
      },
      harness: 'claude-code',
      iteration: 0,
    } satisfies LocalRunnerJob;
    const result = {
      assertionResults: [
        {
          assertionId: 'assertion.labels.reads-package',
          kind: 'tool.called',
          passed: true,
          message: 'Observed tool "shell".',
        },
      ],
      harnessResult: {toolEvents: []},
    } as unknown as LocalRunnerResult;

    expect(
      renderAssertionDetails(
        result,
        assertionByIdForJobs([job]),
        createRenderContext({usePlainSymbols: true}, {verbose: true}),
      ),
    ).toContain('[ ok ] reads package.json  tool.called(shell)');
  });
});
