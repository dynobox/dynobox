import {describe, expect, it} from 'vitest';

import {
  evaluateSequenceInOrder,
  evaluateToolCalledAssertion,
  evaluateToolNotCalledAssertion,
} from './toolAssertions.js';
import type {ToolEvent} from './types.js';

function webFetchEvent(url: string, extra: object = {}): ToolEvent {
  return {
    kind: 'web_fetch',
    rawName: 'web_fetch',
    input: {url, ...extra},
  };
}

describe('web_fetch URL matcher', () => {
  it('matches the normalized top-level url on tool.called("web_fetch")', () => {
    const skillRead = webFetchEvent('https://past.dev/SKILL.md');

    const pass = evaluateToolCalledAssertion(
      {
        id: 'assertion.test.0',
        type: 'tool.called',
        tool: 'web_fetch',
        url: 'https://PAST.dev/SKILL.md',
      },
      [webFetchEvent('https://past.dev/agent-setup/prompt.md'), skillRead],
    );
    expect(pass.passed).toBe(true);
    expect(pass.evidence).toBe(skillRead);

    const fail = evaluateToolCalledAssertion(
      {
        id: 'assertion.test.1',
        type: 'tool.called',
        tool: 'web_fetch',
        url: 'https://past.dev/missing.md',
      },
      [skillRead],
    );
    expect(fail.passed).toBe(false);
    expect(fail.message).toContain('url "https://past.dev/missing.md"');
  });

  it('matches the exact URL, not other paths or nested result URLs', () => {
    const events = [
      webFetchEvent('https://docs.example/a', {
        results: [{url: 'https://evil.example/'}],
      }),
      webFetchEvent('https://evil.example/payload'),
    ];

    const result = evaluateToolNotCalledAssertion(
      {
        id: 'assertion.test.2',
        type: 'tool.notCalled',
        tool: 'web_fetch',
        url: 'https://evil.example/',
      },
      events,
    );
    expect(result.passed).toBe(true);
  });

  it('supports url matchers on tool.notCalled and sequence.inOrder', () => {
    const events = [
      webFetchEvent('https://past.dev/SKILL.md'),
      webFetchEvent('https://past.dev/agent-setup/prompt.md'),
    ];

    const notCalledFail = evaluateToolNotCalledAssertion(
      {
        id: 'assertion.test.3',
        type: 'tool.notCalled',
        tool: 'web_fetch',
        url: 'https://past.dev/SKILL.md',
      },
      events,
    );
    expect(notCalledFail.passed).toBe(false);

    const sequencePass = evaluateSequenceInOrder(
      {
        id: 'assertion.test.4',
        type: 'sequence.inOrder',
        steps: [
          {
            type: 'tool.called',
            tool: 'web_fetch',
            url: 'https://past.dev/SKILL.md',
          },
          {
            type: 'tool.called',
            tool: 'web_fetch',
            url: 'https://past.dev/agent-setup/prompt.md',
          },
        ],
      },
      events,
    );
    expect(sequencePass.passed).toBe(true);

    const sequenceFail = evaluateSequenceInOrder(
      {
        id: 'assertion.test.5',
        type: 'sequence.inOrder',
        steps: [
          {
            type: 'tool.called',
            tool: 'web_fetch',
            url: 'https://past.dev/agent-setup/prompt.md',
          },
          {
            type: 'tool.called',
            tool: 'web_fetch',
            url: 'https://past.dev/SKILL.md',
          },
        ],
      },
      events,
    );
    expect(sequenceFail.passed).toBe(false);
  });
});
