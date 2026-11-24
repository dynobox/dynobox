import type {LocalRunnerResult} from '@dynobox/runner-local';
import {describe, expect, it} from 'vitest';

import {createRenderContext, visibleLength} from '../terminal/index.js';
import {stripAnsi} from '../testUtils.js';
import {renderHttpMockDetails} from './jobDetails.js';

function resultWithHttpEvent(status?: number): LocalRunnerResult {
  return {
    jobId: 'job.http-mock',
    scenarioId: 'scenario.http-mock',
    harness: 'claude-code',
    harnessVersion: null,
    iteration: 0,
    status: 'passed',
    passed: true,
    workDir: '/tmp/work',
    setupResult: {success: true, logs: []},
    httpEvents: [
      {
        endpointId: null,
        method: 'GET',
        host: 'api.example.test',
        url: `https://api.example.test/v1/ingest/${'a'.repeat(150)}?token=secret`,
        timestamp: '2026-11-23T00:00:00.000Z',
        mocked: true,
        ...(status === undefined ? {} : {status}),
      },
    ],
    harnessCliMockCallCount: 0,
    cliMockCalls: [],
    artifacts: [],
    assertionResults: [],
    verificationFailed: false,
    diagnostics: [],
    warnings: [],
    timing: {setupMs: 0, harnessMs: 0, assertionsMs: 0, totalMs: 0},
  };
}

describe('renderHttpMockDetails', () => {
  it.each([200, 404, undefined])(
    'keeps status %s visible when truncating a long path',
    (status) => {
      const output = renderHttpMockDetails(
        resultWithHttpEvent(status),
        createRenderContext({color: true, terminalWidth: 80}),
      );
      const line = stripAnsi(output).trimEnd();

      expect(line).toHaveLength(80);
      expect(line).toContain('http mock: GET api.example.test/v1/ingest/');
      expect(line.endsWith(`... -> ${status ?? 'no response'}`)).toBe(true);
      expect(line).not.toContain('token=secret');
    },
  );

  it.each([8, 12, 24, 40])(
    'keeps the output within a %i-column terminal',
    (terminalWidth) => {
      const output = renderHttpMockDetails(
        resultWithHttpEvent(),
        createRenderContext({color: true, terminalWidth}),
      );

      expect(visibleLength(output.trimEnd())).toBeLessThanOrEqual(
        terminalWidth,
      );
    },
  );
});
