import type {IrScenario} from '@dynobox/sdk/ir';
import {describe, expect, it} from 'vitest';

import {
  createCliMockResponseResolver,
  normalizeHandlerResponse,
} from './responses.js';

describe('CLI mock response resolver', () => {
  it('reserves sequential responses and returns exhaustion failures', () => {
    const mocks = {
      vitest: {
        responses: [{exitCode: 1, stdout: '', stderr: 'retry'}],
        onExhausted: 'error',
      },
    } satisfies IrScenario['cliMocks'];
    const resolver = createCliMockResponseResolver(mocks);

    expect(resolver.reserve('vitest', ['run'], mocks.vitest)).toEqual({
      response: {exitCode: 1, stdout: '', stderr: 'retry'},
    });
    expect(resolver.reserve('vitest', ['run'], mocks.vitest)).toEqual({
      response: {
        exitCode: 1,
        stdout: '',
        stderr:
          'Dynobox CLI mock "vitest run" exhausted its configured responses.\n',
      },
      failure: {
        executable: 'vitest',
        argv: ['run'],
        message:
          'Dynobox CLI mock "vitest run" exhausted its configured responses.',
      },
    });
  });

  it('defaults malformed missing exhaustion behavior to an error', () => {
    const mocks = {
      vitest: {
        responses: [{exitCode: 0, stdout: '', stderr: ''}],
      },
    } as unknown as IrScenario['cliMocks'];
    const resolver = createCliMockResponseResolver(mocks);

    resolver.reserve('vitest', [], mocks.vitest!);
    const exhausted = resolver.reserve('vitest', [], mocks.vitest!);

    expect(exhausted).toMatchObject({
      response: {exitCode: 1},
      failure: {executable: 'vitest'},
    });
  });

  it('validates configured and handler response exit codes', () => {
    expect(() =>
      createCliMockResponseResolver({
        vitest: {response: {exitCode: 256, stdout: '', stderr: ''}},
      } as unknown as IrScenario['cliMocks']),
    ).toThrow('between 0 and 255');
    expect(() => normalizeHandlerResponse({exitCode: 256})).toThrow(
      'between 0 and 255',
    );
  });
});
