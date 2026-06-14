import {afterAll, beforeAll, describe, expect, it} from 'vitest';

import {createFixtureSet, PassingHarness} from '../testUtils.js';
import {executeCli} from './execute.js';
import {configErrorExitCode} from './exitCodes.js';
import {
  validateIterations,
  validateModelOverrides,
  validateScenarioFilters,
} from './options.js';

const fixtures = createFixtureSet('options');

describe('--harness override validation', () => {
  beforeAll(fixtures.setup);
  afterAll(fixtures.teardown);

  it('accepts a valid harness id and runs in quiet mode', async () => {
    const result = await executeCli(
      ['run', fixtures.validConfigPath, '--harness', 'codex', '--quiet'],
      {harnesses: [new PassingHarness('codex')]},
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      'dynobox  1 scenario · 1 harness · 1 iteration',
    );
  });

  it('rejects an unknown harness id with the config-error exit code', async () => {
    const result = await executeCli([
      'run',
      fixtures.validConfigPath,
      '--harness',
      'nope',
    ]);

    expect(result.exitCode).toBe(configErrorExitCode);
    expect(result.stderr).toContain('Invalid harness "nope"');
  });

  it('accepts a permission mode override', async () => {
    const result = await executeCli(
      [
        'run',
        fixtures.validConfigPath,
        '--permission-mode',
        'dangerous',
        '--quiet',
      ],
      {harnesses: [new PassingHarness('claude-code')]},
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('1 scenario · 1 harness · 1 iteration');
  });

  it('rejects an unknown permission mode with the config-error exit code', async () => {
    const result = await executeCli([
      'run',
      fixtures.validConfigPath,
      '--permission-mode',
      'unsafe',
    ]);

    expect(result.exitCode).toBe(configErrorExitCode);
    expect(result.stderr).toContain('Invalid permission mode "unsafe"');
  });

  it('parses comma-separated model overrides positionally', () => {
    expect(
      validateModelOverrides(['sonnet,gpt-5.5'], ['claude-code', 'codex']),
    ).toEqual(['sonnet', 'gpt-5.5']);
  });

  it('requires --harness when --model is provided', () => {
    expect(() => validateModelOverrides(['gpt-5.5'], undefined)).toThrow(
      '--model requires --harness',
    );
  });

  it('requires one model per selected harness', () => {
    expect(() =>
      validateModelOverrides(['sonnet'], ['claude-code', 'codex']),
    ).toThrow('Expected one --model value per --harness value');
  });

  it('rejects an unknown reporter with the config-error exit code', async () => {
    const result = await executeCli([
      'run',
      fixtures.validConfigPath,
      '--reporter',
      'xml',
    ]);

    expect(result.exitCode).toBe(configErrorExitCode);
    expect(result.stderr).toContain('Invalid reporter "xml"');
  });

  it('parses repeated and comma-separated scenario filters', () => {
    expect(
      validateScenarioFilters(['lint*,deploy package', 'scenario.smoke']),
    ).toEqual(['lint*', 'deploy package', 'scenario.smoke']);
  });

  it('validates iteration counts', () => {
    expect(validateIterations(undefined)).toBe(1);
    expect(validateIterations('3')).toBe(3);
    expect(() => validateIterations('0')).toThrow(
      'Expected a positive integer',
    );
    expect(() => validateIterations('1.5')).toThrow(
      'Expected a positive integer',
    );
  });
});
