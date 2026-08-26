import type {LocalRunnerJob} from '@dynobox/runner-local';
import {describe, expect, it} from 'vitest';

import {createRenderContext} from '../terminal/index.js';
import {renderRunHeader} from './header.js';

function job(overrides: Partial<LocalRunnerJob> = {}): LocalRunnerJob {
  return {
    id: 'scenario.test.claude-code.iteration.0',
    iteration: 0,
    harness: 'claude-code',
    scenario: {
      id: 'scenario.test',
      name: 'test',
      prompt: 'Run a test.',
      harnesses: [{id: 'claude-code'}],
      setup: [],
      fixtures: [],
      cliMocks: {},
      endpoints: [],
      assertions: [],
    },
    ...overrides,
  };
}

describe('renderRunHeader', () => {
  it('shows the discovery summary with a single harness label', () => {
    const header = renderRunHeader([
      {path: 'example/example.dyno.ts', jobs: [job()]},
    ]);

    expect(header).toContain('■ dynobox');
    expect(header).toContain(
      'discovered 1 dyno · 1 scenario · harness: claude-code',
    );
    expect(header).not.toContain('iterations:');
  });

  it('includes model and permission mode in the harness label', () => {
    const header = renderRunHeader(
      [
        {
          path: 'example/example.dyno.ts',
          jobs: [job({model: 'gpt-5.4-mini', permissionMode: 'dangerous'})],
        },
      ],
      createRenderContext({terminalWidth: 120}),
    );

    expect(header).toContain(
      'harness: claude-code · model: gpt-5.4-mini · mode: dangerous',
    );
  });

  it('lists multiple harness labels and pluralizes correctly', () => {
    const header = renderRunHeader([
      {
        path: 'example/example.dyno.ts',
        jobs: [
          job(),
          job({id: 'scenario.test.codex.iteration.0', harness: 'codex'}),
        ],
      },
    ]);

    expect(header).toContain('harnesses: claude-code, codex');
    expect(header).not.toContain('harnesss');
  });

  it('falls back to a harness count when labels exceed the width', () => {
    const ctx = createRenderContext({terminalWidth: 40});
    const header = renderRunHeader(
      [
        {
          path: 'example/example.dyno.ts',
          jobs: [
            job({model: 'sonnet', permissionMode: 'dangerous'}),
            job({
              id: 'scenario.test.codex.iteration.0',
              harness: 'codex',
              model: 'gpt-5.4-mini',
              permissionMode: 'dangerous',
            }),
          ],
        },
      ],
      ctx,
    );

    expect(header).toContain('harnesses: 2');
    expect(header).not.toContain('harnesses: claude-code');
  });

  it('falls back to a harness count when one label exceeds the width', () => {
    const ctx = createRenderContext({terminalWidth: 40});
    const header = renderRunHeader(
      [
        {
          path: 'example/example.dyno.ts',
          jobs: [job({model: 'sonnet', permissionMode: 'dangerous'})],
        },
      ],
      ctx,
    );

    expect(header).toContain('harnesses: 1');
    expect(header).not.toContain(
      'harness: claude-code · model: sonnet · mode: dangerous',
    );
  });

  it('shows the iteration count for multi-iteration runs', () => {
    const header = renderRunHeader([
      {
        path: 'example/example.dyno.ts',
        jobs: [
          job(),
          job({id: 'scenario.test.claude-code.iteration.1', iteration: 1}),
        ],
      },
    ]);

    expect(header).toContain('harness: claude-code · iterations: 2');
  });
});
