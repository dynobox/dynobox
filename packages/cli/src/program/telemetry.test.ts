import {existsSync, mkdirSync, readFileSync, rmSync} from 'node:fs';
import {join} from 'node:path';

import {TelemetryBatch} from '@dynobox/run-schema';
import {afterAll, beforeAll, describe, expect, it, vi} from 'vitest';

import {createFixtureSet, createPassingHarness} from '../testUtils.js';
import {executeCli} from './execute.js';
import {
  resolveTelemetryStatus,
  setTelemetryEnabled,
  startTelemetrySession,
  telemetryFilePath,
  type TelemetrySession,
} from './telemetry.js';

const ROOT = join(process.cwd(), '.tmp-dynobox-cli-tests-telemetry');
const fixtures = createFixtureSet('telemetry');

function homeDir(name: string): string {
  return join(ROOT, name);
}

/** A session that records batches instead of sending them. */
function recordingSession(firstRun = false) {
  const batches: TelemetryBatch[] = [];
  const session: TelemetrySession = {
    context: {
      installId: '0b6f8d0e-3c1a-4f7e-8b2d-5a9c4e1f7d23',
      cliVersion: '0.18.0',
      os: 'darwin',
      arch: 'arm64',
      nodeVersion: '22.20.0',
      ci: false,
    },
    firstRun,
    deliver: (batch) => {
      batches.push(batch);
      return Promise.resolve();
    },
  };
  const start = vi.fn(() => session);
  return {batches, start};
}

beforeAll(() => {
  rmSync(ROOT, {force: true, recursive: true});
  mkdirSync(ROOT, {recursive: true});
  fixtures.setup();
});

afterAll(() => {
  rmSync(ROOT, {force: true, recursive: true});
  fixtures.teardown();
});

describe('resolveTelemetryStatus', () => {
  it.each([
    [{}, true, 'default'],
    [{CI: 'true'}, false, 'CI'],
    [{CI: 'false'}, true, 'default'],
    [{CI: 'true', DYNOBOX_TELEMETRY: '1'}, true, 'DYNOBOX_TELEMETRY'],
    [{DYNOBOX_TELEMETRY: 'off'}, false, 'DYNOBOX_TELEMETRY'],
    [{DO_NOT_TRACK: '1', DYNOBOX_TELEMETRY: '1'}, false, 'DO_NOT_TRACK'],
    [{DO_NOT_TRACK: '0'}, true, 'default'],
  ])('%j → enabled %s from %s', (env, enabled, source) => {
    const status = resolveTelemetryStatus({
      env: {HOME: homeDir('no-state'), ...env},
    });
    expect(status).toMatchObject({enabled, source, installId: null});
  });

  it('lets the saved setting override the CI default but not the env', () => {
    const home = homeDir('saved-setting');
    setTelemetryEnabled(true, {homeDir: home});

    expect(
      resolveTelemetryStatus({env: {HOME: home, CI: 'true'}}),
    ).toMatchObject({enabled: true, source: 'config'});
    expect(
      resolveTelemetryStatus({env: {HOME: home, DYNOBOX_TELEMETRY: '0'}}),
    ).toMatchObject({enabled: false, source: 'DYNOBOX_TELEMETRY'});
  });
});

describe('startTelemetrySession', () => {
  it('creates the install ID and shows the notice only once', () => {
    const env = {HOME: homeDir('first-run')};
    let stderr = '';
    const writeStderr = (value: string) => {
      stderr += value;
    };

    const first = startTelemetrySession({env, writeStderr});
    expect(first?.firstRun).toBe(true);
    expect(stderr).toContain('dynobox telemetry disable');

    stderr = '';
    const second = startTelemetrySession({env, writeStderr});
    expect(second?.firstRun).toBe(false);
    expect(second?.context.installId).toBe(first?.context.installId);
    expect(stderr).toBe('');
  });

  it('does nothing when telemetry is off', () => {
    const env = {HOME: homeDir('opted-out'), DO_NOT_TRACK: '1'};
    const writeStderr = vi.fn();

    expect(startTelemetrySession({env, writeStderr})).toBeUndefined();
    expect(writeStderr).not.toHaveBeenCalled();
    expect(existsSync(telemetryFilePath({env}))).toBe(false);
  });

  it('posts batches to the API and swallows delivery errors', async () => {
    const send = vi.fn<typeof fetch>(() =>
      Promise.reject(new Error('offline')),
    );
    const session = startTelemetrySession({
      env: {HOME: homeDir('deliver'), DYNOBOX_API_URL: 'http://api.test/'},
      writeStderr: () => {},
      fetch: send,
    })!;
    const batch = {schemaVersion: 1, context: session.context, events: []};

    await expect(
      session.deliver(batch as unknown as TelemetryBatch),
    ).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledWith(
      'http://api.test/telemetry',
      expect.objectContaining({method: 'POST', body: JSON.stringify(batch)}),
    );
  });

  it('prints batches instead of sending them in debug mode', async () => {
    const send = vi.fn<typeof fetch>();
    let stderr = '';
    const session = startTelemetrySession({
      env: {HOME: homeDir('debug'), DYNOBOX_TELEMETRY_DEBUG: '1'},
      writeStderr: (value) => {
        stderr += value;
      },
      fetch: send,
    })!;
    stderr = '';

    await session.deliver({
      schemaVersion: 1,
      context: session.context,
      events: [],
    } as unknown as TelemetryBatch);

    expect(send).not.toHaveBeenCalled();
    expect(stderr).toMatch(/^\[telemetry\] \{"schemaVersion":1/);
  });
});

describe('executeCli telemetry', () => {
  it('sends a command, run, and harness_run event for a run', async () => {
    const {batches, start} = recordingSession(true);

    const result = await executeCli(['run', fixtures.validConfigPath], {
      harnesses: [createPassingHarness()],
      telemetry: start,
    });

    expect(result.exitCode).toBe(0);
    expect(batches).toHaveLength(1);
    const batch = batches[0]!;
    expect(TelemetryBatch.safeParse(batch).success).toBe(true);
    const [command, run, harnessRun] = batch.events;
    expect(command).toMatchObject({
      type: 'command',
      command: 'run',
      exitCode: 0,
      errorCategory: null,
      firstRun: true,
    });
    expect(run).toEqual({
      type: 'run',
      runId: expect.any(String),
      dynos: 1,
      scenarios: 1,
      jobs: 1,
      iterations: 1,
      passed: true,
      configFormats: ['ts'],
      features: [],
    });
    expect(harnessRun).toMatchObject({
      type: 'harness_run',
      runId: run?.type === 'run' ? run.runId : undefined,
      harness: 'claude-code',
      model: null,
      jobs: 1,
      passed: 1,
      unknownToolEvents: 0,
    });
  });

  it('reports a config error category', async () => {
    const {batches, start} = recordingSession();

    const result = await executeCli(['run', fixtures.invalidConfigPath], {
      telemetry: start,
    });

    expect(result.exitCode).toBe(1);
    expect(batches[0]?.events).toEqual([
      expect.objectContaining({
        type: 'command',
        command: 'run',
        exitCode: 1,
        errorCategory: 'config',
      }),
    ]);
  });

  it.each([['--help'], ['--version'], ['telemetry', 'status']])(
    'does not start a session for %s',
    async (...args) => {
      const {batches, start} = recordingSession();

      await executeCli(args, {
        env: {HOME: homeDir('untracked')},
        telemetry: start,
      });

      expect(start).not.toHaveBeenCalled();
      expect(batches).toHaveLength(0);
    },
  );
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
