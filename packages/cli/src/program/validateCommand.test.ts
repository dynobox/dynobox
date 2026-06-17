import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {afterAll, afterEach, beforeAll, describe, expect, it} from 'vitest';

import {createFixtureSet} from '../testUtils.js';
import {displayPath} from '../util/displayPath.js';
import {executeCli} from './execute.js';
import {configErrorExitCode} from './exitCodes.js';

const fixtures = createFixtureSet('validateCommand');
const TEMP_ROOTS: string[] = [];

const VALID_DYNO = `import {defineDyno, tool} from '@dynobox/sdk';

export default defineDyno({
  name: 'validate fixture',
  scenarios: [
    {
      name: 'uses shell',
      prompt: 'Run pnpm test.',
      assertions: [tool.called('shell')],
    },
  ],
});
`;

const INVALID_DYNO = `import {defineDyno} from '@dynobox/sdk';

export default defineDyno({
  name: 'invalid validate fixture',
  scenarios: [
    {
      name: 'missing prompt',
      assertions: [],
    },
  ],
});
`;

function makeTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dynobox-cli-validate-'));
  TEMP_ROOTS.push(root);
  return root;
}

describe('dynobox validate', () => {
  beforeAll(fixtures.setup);
  afterAll(() => {
    fixtures.teardown();
    for (const root of TEMP_ROOTS) rmSync(root, {force: true, recursive: true});
  });
  afterEach(() => {
    for (const root of TEMP_ROOTS.splice(0)) {
      rmSync(root, {force: true, recursive: true});
    }
  });

  it('validates an explicit config path without running harnesses', async () => {
    await expect(
      executeCli(['validate', fixtures.validConfigPath]),
    ).resolves.toEqual({
      exitCode: 0,
      stdout: `  ✓  ${displayPath(fixtures.validConfigPath)}   1 scenario(s)\n\nValidated 1 dyno file(s).\n`,
      stderr: '',
    });
  });

  it('validates discovered dyno files in a directory', async () => {
    const root = makeTempRoot();
    mkdirSync(join(root, 'nested'), {recursive: true});
    const a = join(root, 'a.dyno.mjs');
    const b = join(root, 'nested', 'b.dyno.mjs');
    writeFileSync(a, VALID_DYNO);
    writeFileSync(b, VALID_DYNO);

    const result = await executeCli(['validate', root]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      `  ✓  ${displayPath(a)}   1 scenario(s)\n` +
        `  ✓  ${displayPath(b)}   1 scenario(s)\n` +
        '\nValidated 2 dyno file(s).\n',
    );
    expect(result.stderr).toBe('');
  });

  it('prints the resolved dyno.config.json under --verbose', async () => {
    const root = makeTempRoot();
    const config = join(root, 'dyno.config.json');
    const file = join(root, 'valid.dyno.mjs');
    writeFileSync(config, JSON.stringify({ignoredDirectories: []}));
    writeFileSync(file, VALID_DYNO);

    const result = await executeCli([
      'validate',
      root,
      '--config',
      config,
      '--verbose',
    ]);

    expect(result).toEqual({
      exitCode: 0,
      stdout:
        `path: ${root}\n` +
        `config: ${config}\n` +
        `  ✓  ${displayPath(file)}   1 scenario(s)\n\nValidated 1 dyno file(s).\n`,
      stderr: '',
    });
  });

  it('prints the absolute search path and config status for an empty verbose result', async () => {
    const root = makeTempRoot();

    const result = await executeCli(['validate', root, '--verbose']);

    expect(result).toEqual({
      exitCode: 0,
      stdout: `path: ${root}\nconfig: none\nValidated 0 dyno file(s).\n`,
      stderr: '',
    });
  });

  it('omits the config line without --verbose', async () => {
    const root = makeTempRoot();
    const config = join(root, 'dyno.config.json');
    const file = join(root, 'valid.dyno.mjs');
    writeFileSync(config, JSON.stringify({ignoredDirectories: []}));
    writeFileSync(file, VALID_DYNO);

    const result = await executeCli(['validate', root, '--config', config]);

    expect(result).toEqual({
      exitCode: 0,
      stdout: `  ✓  ${displayPath(file)}   1 scenario(s)\n\nValidated 1 dyno file(s).\n`,
      stderr: '',
    });
  });

  it('validates an empty directory as zero dyno files', async () => {
    const root = makeTempRoot();

    const result = await executeCli(['validate', root]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('Validated 0 dyno file(s).\n');
    expect(result.stderr).toBe('');
  });

  it('exits nonzero when config validation fails', async () => {
    const result = await executeCli(['validate', fixtures.invalidConfigPath]);

    expect(result.exitCode).toBe(configErrorExitCode);
    expect(result.stdout).toBe(
      `  ✗  ${displayPath(fixtures.invalidConfigPath)}   invalid\n\nValidated 0 dyno file(s); 1 failed.\n`,
    );
    expect(result.stderr).toContain('dynobox validate');
    expect(result.stderr).toContain(`config: ${fixtures.invalidConfigPath}`);
    expect(result.stderr).toContain('prompt');
  });

  it('prints mixed valid and invalid file statuses in discovery order', async () => {
    const root = makeTempRoot();
    const valid = join(root, 'a.dyno.mjs');
    const invalid = join(root, 'b.dyno.mjs');
    writeFileSync(valid, VALID_DYNO);
    writeFileSync(invalid, INVALID_DYNO);

    const result = await executeCli(['validate', root]);

    expect(result.exitCode).toBe(configErrorExitCode);
    expect(result.stdout).toBe(
      `  ✓  ${displayPath(valid)}   1 scenario(s)\n` +
        `  ✗  ${displayPath(invalid)}   invalid\n` +
        '\nValidated 1 dyno file(s); 1 failed.\n',
    );
    expect(result.stderr).toContain(`config: ${invalid}`);
  });

  it('emits JSON records for valid files', async () => {
    const result = await executeCli([
      'validate',
      fixtures.validConfigPath,
      '--reporter',
      'json',
    ]);
    const records = result.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      schema: 'dynobox.validate.v1',
      type: 'file',
      filePath: fixtures.validConfigPath,
      status: 'valid',
    });
    expect(records[1]).toMatchObject({
      type: 'summary',
      status: 'passed',
      totals: {files: 1, valid: 1, invalid: 0},
    });
  });

  it('emits JSON records for invalid files', async () => {
    const result = await executeCli([
      'validate',
      fixtures.invalidConfigPath,
      '--reporter',
      'json',
    ]);
    const records = result.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(result.exitCode).toBe(configErrorExitCode);
    expect(result.stderr).toBe('');
    expect(records[0]).toMatchObject({
      schema: 'dynobox.validate.v1',
      type: 'file',
      filePath: fixtures.invalidConfigPath,
      status: 'invalid',
    });
    expect(records[0]).toHaveProperty('error.message');
    expect(records[1]).toMatchObject({
      type: 'summary',
      status: 'failed',
      totals: {files: 1, valid: 0, invalid: 1},
    });
  });

  it('resolves @dynobox/sdk from the CLI package outside a project', async () => {
    const root = makeTempRoot();
    const file = join(root, 'remote.dyno.mjs');
    writeFileSync(file, VALID_DYNO);

    const result = await executeCli(['validate', file]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe(
      `  ✓  ${displayPath(file)}   1 scenario(s)\n\nValidated 1 dyno file(s).\n`,
    );
  });
});
