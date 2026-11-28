import {describe, expect, it} from 'vitest';

import {
  evaluateSequenceInOrder,
  evaluateToolCalledAssertion,
  evaluateToolNotCalledAssertion,
} from './toolAssertions.js';
import type {ToolEvent} from './types.js';

function webFetchEvent(
  url: string,
  status?: 'success' | 'failure',
  inputKey: 'url' | 'Url' = 'url',
): ToolEvent {
  return {
    kind: 'web_fetch',
    rawName: 'web_fetch',
    input: {[inputKey]: url},
    ...(status === undefined ? {} : {status}),
  };
}

describe('web_fetch URL and status matchers', () => {
  it('matches url and status on tool.called("web_fetch")', () => {
    const failedRead = webFetchEvent('https://past.dev/SKILL.md', 'failure');
    const otherRead = webFetchEvent(
      'https://past.dev/agent-setup/prompt.md',
      'success',
    );
    const successRead = webFetchEvent('https://past.dev/SKILL.md', 'success');

    const failOnError = evaluateToolCalledAssertion(
      {
        id: 'assertion.test.0',
        type: 'tool.called',
        tool: 'web_fetch',
        url: 'https://past.dev/SKILL.md',
        status: 'success',
      },
      [failedRead, otherRead],
    );
    expect(failOnError.passed).toBe(false);
    expect(failOnError.message).toContain('url "https://past.dev/SKILL.md"');
    expect(failOnError.message).toContain('status "success"');

    const passOnSuccess = evaluateToolCalledAssertion(
      {
        id: 'assertion.test.1',
        type: 'tool.called',
        tool: 'web_fetch',
        url: 'https://past.dev/SKILL.md',
        status: 'success',
      },
      [failedRead, successRead],
    );
    expect(passOnSuccess.passed).toBe(true);
    expect(passOnSuccess.evidence).toBe(successRead);
  });

  it('extracts case-insensitive URL fields such as Url and normalizes origins', () => {
    const event = webFetchEvent('https://past.dev', 'success', 'Url');

    const result = evaluateToolCalledAssertion(
      {
        id: 'assertion.test.2',
        type: 'tool.called',
        tool: 'web_fetch',
        url: 'https://past.dev/',
        status: 'success',
      },
      [event],
    );
    expect(result.passed).toBe(true);
  });

  it('supports url and status matchers on tool.notCalled and sequence.inOrder', () => {
    const events = [
      webFetchEvent('https://past.dev/SKILL.md', 'failure'),
      webFetchEvent('https://past.dev/agent-setup/prompt.md', 'success'),
    ];

    const notCalledPass = evaluateToolNotCalledAssertion(
      {
        id: 'assertion.test.3',
        type: 'tool.notCalled',
        tool: 'web_fetch',
        url: 'https://past.dev/SKILL.md',
        status: 'success',
      },
      events,
    );
    expect(notCalledPass.passed).toBe(true);

    const notCalledFail = evaluateToolNotCalledAssertion(
      {
        id: 'assertion.test.4',
        type: 'tool.notCalled',
        tool: 'web_fetch',
        url: 'https://past.dev/SKILL.md',
        status: 'failure',
      },
      events,
    );
    expect(notCalledFail.passed).toBe(false);

    const sequencePass = evaluateSequenceInOrder(
      {
        id: 'assertion.test.5',
        type: 'sequence.inOrder',
        steps: [
          {
            type: 'tool.called',
            tool: 'web_fetch',
            url: 'https://past.dev/SKILL.md',
            status: 'failure',
          },
          {
            type: 'tool.called',
            tool: 'web_fetch',
            url: 'https://past.dev/agent-setup/prompt.md',
            status: 'success',
          },
        ],
      },
      events,
    );
    expect(sequencePass.passed).toBe(true);
  });
});
