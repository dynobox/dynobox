import {describe, expect, it, vi} from 'vitest';

import {renderRunConfigErrorMessage} from '../render/configError.js';
import {reportConfigError} from './reportConfigError.js';

describe('reportConfigError', () => {
  it('returns the validator result when validation succeeds', () => {
    const writeStderr = vi.fn();

    const result = reportConfigError(
      './config.ts',
      writeStderr,
      renderRunConfigErrorMessage,
      () => ['claude-code'],
    );

    expect(result).toEqual(['claude-code']);
    expect(writeStderr).not.toHaveBeenCalled();
  });

  it('renders the config error and rethrows when validation fails', () => {
    const writeStderr = vi.fn();
    const error = new Error('bad harness');

    expect(() =>
      reportConfigError(
        './config.ts',
        writeStderr,
        renderRunConfigErrorMessage,
        () => {
          throw error;
        },
      ),
    ).toThrow(error);

    expect(writeStderr).toHaveBeenCalledWith(
      renderRunConfigErrorMessage('./config.ts', 'bad harness'),
    );
  });

  it('stringifies non-Error throws before rendering', () => {
    const writeStderr = vi.fn();

    expect(() =>
      reportConfigError(
        './config.ts',
        writeStderr,
        renderRunConfigErrorMessage,
        () => {
          throw 'bad harness';
        },
      ),
    ).toThrow('bad harness');

    expect(writeStderr).toHaveBeenCalledWith(
      renderRunConfigErrorMessage('./config.ts', 'bad harness'),
    );
  });
});