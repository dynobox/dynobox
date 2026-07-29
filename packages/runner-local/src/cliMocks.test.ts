import {mkdtempSync, realpathSync, rmSync, statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';

import type {IrScenario} from '@dynobox/sdk/ir';
import {execa} from 'execa';
import {afterEach, describe, expect, it} from 'vitest';

import {type CliMockController, startCliMockController} from './cliMocks.js';

const workDirs: string[] = [];
const controllers: CliMockController[] = [];

afterEach(async () => {
  await Promise.all(
    controllers.splice(0).map((controller) => controller.stop()),
  );
  for (const workDir of workDirs.splice(0)) {
    rmSync(workDir, {force: true, recursive: true});
  }
});

describe('CLI mock controller', () => {
  it('runs static mocks and records exact output', async () => {
    const {controller, workDir} = await createController({
      vitest: {
        response: {exitCode: 7, stdout: 'output', stderr: 'warning'},
      },
    });

    const result = await runMock(controller, workDir, 'vitest', [
      'run',
      '--ui',
    ]);

    expect(result).toMatchObject({
      exitCode: 7,
      stdout: 'output',
      stderr: 'warning',
    });
    expect(controller.calls()).toEqual([
      expect.objectContaining({
        executable: 'vitest',
        argv: ['run', '--ui'],
        cwd: expect.stringMatching(/dynobox-cli-mocks-/),
        exitCode: 7,
        stdout: 'output',
        stderr: 'warning',
      }),
    ]);
    expect(controller.calls()[0]).not.toHaveProperty('env');
    expect(controller.failures()).toEqual([]);
  });

  it('applies sequential exhaustion policies independently', async () => {
    const {controller, workDir} = await createController({
      errors: {
        responses: [{exitCode: 0, stdout: 'first', stderr: ''}],
        onExhausted: 'error',
      },
      repeats: {
        responses: [{exitCode: 2, stdout: '', stderr: 'again'}],
        onExhausted: 'repeat-last',
      },
      fallback: {
        responses: [{exitCode: 1, stdout: '', stderr: 'retry'}],
        onExhausted: {exitCode: 0, stdout: 'ready', stderr: ''},
      },
    });

    expect(await runMock(controller, workDir, 'errors')).toMatchObject({
      exitCode: 0,
      stdout: 'first',
    });
    expect(await runMock(controller, workDir, 'errors')).toMatchObject({
      exitCode: 1,
      stderr: expect.stringContaining('exhausted its configured responses'),
    });
    expect(await runMock(controller, workDir, 'repeats')).toMatchObject({
      exitCode: 2,
      stderr: 'again',
    });
    expect(await runMock(controller, workDir, 'repeats')).toMatchObject({
      exitCode: 2,
      stderr: 'again',
    });
    expect(await runMock(controller, workDir, 'fallback')).toMatchObject({
      exitCode: 1,
      stderr: 'retry',
    });
    expect(await runMock(controller, workDir, 'fallback')).toMatchObject({
      exitCode: 0,
      stdout: 'ready',
    });
    expect(controller.failures()).toEqual([
      expect.objectContaining({
        executable: 'errors',
        message: expect.stringContaining('exhausted'),
      }),
    ]);
  });

  it('runs handlers with argv, cwd, and child environment', async () => {
    const {controller, workDir} = await createController({
      custom: {
        handler: async ({argv, cwd, env}) => ({
          exitCode: argv[0] === 'ok' ? 0 : 1,
          stdout: `${cwd}|${env.CUSTOM_VALUE}`,
        }),
      },
    });

    const result = await runMock(controller, workDir, 'custom', ['ok'], {
      CUSTOM_VALUE: 'available',
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`${realpathSync(workDir)}|available`);
    expect(controller.calls()[0]).toMatchObject({stdout: result.stdout});
  });

  it('records handler failures and preserves invocation order', async () => {
    let slowStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      slowStarted = resolve;
    });
    const {controller, workDir} = await createController({
      ordered: {
        handler: async ({argv}) => {
          if (argv[0] === 'slow') {
            slowStarted?.();
            await new Promise((resolve) => setTimeout(resolve, 30));
          }
          return {exitCode: 0, stdout: argv[0] ?? ''};
        },
      },
      throws: {
        handler: () => {
          throw new Error('broken handler');
        },
      },
      invalid: {
        handler: () => ({exitCode: 0, stdout: 42}) as never,
      },
    });

    const slow = runMock(controller, workDir, 'ordered', ['slow']);
    await started;
    const fast = runMock(controller, workDir, 'ordered', ['fast']);
    await Promise.all([slow, fast]);
    expect(
      controller
        .calls()
        .slice(0, 2)
        .map((call) => call.argv[0]),
    ).toEqual(['slow', 'fast']);

    expect(await runMock(controller, workDir, 'throws')).toMatchObject({
      exitCode: 1,
      stderr: expect.stringContaining('broken handler'),
    });
    expect(await runMock(controller, workDir, 'invalid')).toMatchObject({
      exitCode: 1,
      stderr: expect.stringContaining('stdout must be a string'),
    });
    expect(controller.failures()).toHaveLength(2);
  });

  it('installs private executable shims and cleans up the socket', async () => {
    const {controller, workDir} = await createController({
      vitest: {response: {exitCode: 0, stdout: '', stderr: ''}},
    });
    const env = controller.env(process.env.PATH ?? '');
    const socketPath = env.DYNOBOX_CLI_MOCK_SOCKET!;

    expect(statSync(dirname(socketPath)).mode & 0o777).toBe(0o700);
    expect(
      statSync(join(workDir, '.dynobox', 'cli-mocks', 'bin', 'vitest')).mode &
        0o777,
    ).toBe(0o700);

    await controller.stop();
    expect(() => statSync(socketPath)).toThrow();
    const unavailable = await runMock(controller, workDir, 'vitest');
    expect(unavailable).toMatchObject({
      exitCode: 1,
      stderr: expect.stringContaining('controller unavailable'),
    });
  });

  it('stops without waiting for a hanging handler', async () => {
    let handlerStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      handlerStarted = resolve;
    });
    const {controller, workDir} = await createController({
      hanging: {
        handler: async () => {
          handlerStarted?.();
          await new Promise(() => undefined);
          return {exitCode: 0};
        },
      },
    });

    const invocation = runMock(controller, workDir, 'hanging');
    await started;
    await controller.stop();

    await expect(invocation).resolves.toMatchObject({exitCode: 1});
  });
});

async function createController(mocks: IrScenario['cliMocks']): Promise<{
  controller: CliMockController;
  workDir: string;
}> {
  const workDir = mkdtempSync(join(tmpdir(), 'dynobox-cli-mocks-'));
  workDirs.push(workDir);
  const controller = await startCliMockController(mocks);
  controllers.push(controller);
  await controller.install(workDir);
  return {controller, workDir};
}

async function runMock(
  controller: CliMockController,
  workDir: string,
  executable: string,
  argv: string[] = [],
  extraEnv: Record<string, string> = {},
) {
  return execa(executable, argv, {
    cwd: workDir,
    env: {
      ...process.env,
      ...controller.env(process.env.PATH ?? ''),
      ...extraEnv,
    },
    reject: false,
  });
}
