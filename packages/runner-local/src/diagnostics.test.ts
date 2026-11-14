import {describe, expect, it} from 'vitest';

import {harnessExitDiagnostic} from './diagnostics.js';

describe('harnessExitDiagnostic', () => {
  it('uses a structured harness error when stderr is empty', () => {
    expect(
      harnessExitDiagnostic(
        {
          exitCode: 1,
          durationMs: 10,
          transcript: '{"type":"error"}',
          finalMessage: undefined,
          toolEvents: [],
          errorMessage: 'Model fake/model was not found.',
        },
        {exitCode: 1, stdout: '', stderr: '', durationMs: 10},
      ),
    ).toBe('Harness exited with code 1: Model fake/model was not found.');
  });

  it('puts a structured harness error before stderr', () => {
    expect(
      harnessExitDiagnostic(
        {
          exitCode: 1,
          durationMs: 10,
          transcript: '',
          finalMessage: undefined,
          toolEvents: [],
          errorMessage: 'Structured error',
        },
        {exitCode: 1, stdout: '', stderr: 'Process error', durationMs: 10},
      ),
    ).toBe('Harness exited with code 1: Structured error\nProcess error');
  });

  it('uses stderr alone when there is no structured error', () => {
    expect(
      harnessExitDiagnostic(
        {
          exitCode: 1,
          durationMs: 10,
          transcript: '',
          finalMessage: undefined,
          toolEvents: [],
        },
        {exitCode: 1, stdout: '', stderr: 'Process error', durationMs: 10},
      ),
    ).toBe('Harness exited with code 1: Process error');
  });
});
