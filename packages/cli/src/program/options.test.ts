import {afterAll, beforeAll, describe, expect, it} from 'vitest';

import {createFixtureSet, PassingHarness} from '../test-utils.js';

import {executeCli} from './execute.js';
import {configErrorExitCode} from './exitCodes.js';

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
});
