import {mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';

import {afterAll, beforeAll, describe, expect, it} from 'vitest';

import {executeCli} from './execute.js';
import {telemetryFilePath} from './telemetry.js';

const ROOT = join(process.cwd(), '.tmp-dynobox-cli-tests-telemetry-command');

function homeDir(name: string): string {
  return join(ROOT, name);
}

beforeAll(() => {
  rmSync(ROOT, {force: true, recursive: true});
  mkdirSync(ROOT, {recursive: true});
});

afterAll(() => {
  rmSync(ROOT, {force: true, recursive: true});
});

describe('dynobox telemetry', () => {
  it('shows the status and saves enable and disable', async () => {
    const home = homeDir('command');

    const status = await executeCli(['telemetry'], {env: {HOME: home}});
    expect(status.stdout).toContain('Telemetry: enabled\n');
    expect(status.stdout).toContain('Install ID: none yet\n');

    const disabled = await executeCli(['telemetry', 'disable'], {
      env: {HOME: home},
    });
    expect(disabled.stdout).toBe('Telemetry disabled.\n');
    const saved = JSON.parse(
      readFileSync(telemetryFilePath({homeDir: home}), 'utf8'),
    ) as {enabled: boolean};
    expect(saved.enabled).toBe(false);

    const after = await executeCli(['telemetry', 'status'], {
      env: {HOME: home},
    });
    expect(after.stdout).toContain(
      'Telemetry: disabled (dynobox telemetry disable)\n',
    );
  });

  it('notes when the environment overrides the saved setting', async () => {
    const result = await executeCli(['telemetry', 'enable'], {
      env: {HOME: homeDir('override'), DO_NOT_TRACK: '1'},
    });

    expect(result.stdout).toBe(
      'Telemetry enabled.\nNote: DO_NOT_TRACK overrides this setting, so telemetry is still disabled.\n',
    );
  });

  it('explains an unreadable file and replaces it on enable', async () => {
    const home = homeDir('unreadable');
    const path = telemetryFilePath({homeDir: home});
    mkdirSync(dirname(path), {recursive: true});
    writeFileSync(path, 'not json');

    const status = await executeCli(['telemetry'], {env: {HOME: home}});
    expect(status.stdout).toContain(
      'Telemetry: disabled (~/.dynobox/telemetry.json could not be read',
    );

    await executeCli(['telemetry', 'enable'], {env: {HOME: home}});
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({enabled: true});
  });

  it('rejects unknown actions', async () => {
    const result = await executeCli(['telemetry', 'nope'], {
      env: {HOME: homeDir('unknown')},
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      'Allowed choices are status, enable, disable',
    );
  });
});
