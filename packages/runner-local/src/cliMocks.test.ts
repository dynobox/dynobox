import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import {createConnection} from 'node:net';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';

import type {IrScenario} from '@dynobox/sdk/ir';
import {execa} from 'execa';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {type CliMockController, startCliMockController} from './cliMocks.js';

const workDirs: string[] = [];
const controllers: CliMockController[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
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

  it.each([
    {packageManager: 'npm', args: ['run', 'test', '--silent']},
    {packageManager: 'pnpm', args: ['--silent', 'run', 'test']},
  ])(
    'keeps mocks ahead of local binaries in $packageManager scripts',
    async ({packageManager, args}) => {
      const {controller, workDir} = await createController({
        vitest: {
          response: {exitCode: 0, stdout: 'mocked', stderr: ''},
        },
      });
      const localBin = join(workDir, 'node_modules', '.bin');
      mkdirSync(localBin, {recursive: true});
      writeFileSync(
        join(workDir, 'package.json'),
        JSON.stringify({scripts: {test: 'vitest run'}}),
      );
      writeFileSync(join(localBin, 'vitest'), '#!/bin/sh\nprintf real', {
        mode: 0o700,
      });

      const result = await execa(packageManager, args, {
        cwd: workDir,
        env: {...process.env, ...controller.env(process.env.PATH ?? '')},
        reject: false,
      });

      expect(result).toMatchObject({exitCode: 0, stdout: 'mocked'});
      expect(controller.calls()).toEqual([
        expect.objectContaining({executable: 'vitest', argv: ['run']}),
      ]);
    },
  );

  it('preserves a configured package script shell', async () => {
    const {controller, workDir} = await createController({
      vitest: {
        response: {exitCode: 0, stdout: 'mocked', stderr: ''},
      },
    });
    const localBin = join(workDir, 'node_modules', '.bin');
    const scriptShell = join(workDir, 'custom-shell');
    const marker = join(workDir, 'custom-shell-used');
    mkdirSync(localBin, {recursive: true});
    writeFileSync(
      join(workDir, 'package.json'),
      JSON.stringify({scripts: {test: 'vitest run'}}),
    );
    writeFileSync(join(localBin, 'vitest'), '#!/bin/sh\nprintf real', {
      mode: 0o700,
    });
    writeFileSync(
      scriptShell,
      '#!/bin/sh\nprintf used > "$CUSTOM_SHELL_MARKER"\nexec /bin/sh "$@"',
      {mode: 0o700},
    );

    const result = await execa('npm', ['run', 'test', '--silent'], {
      cwd: workDir,
      env: {
        ...process.env,
        ...controller.env(process.env.PATH ?? '', scriptShell),
        CUSTOM_SHELL_MARKER: marker,
      },
      reject: false,
    });

    expect(result).toMatchObject({exitCode: 0, stdout: 'mocked'});
    expect(readFileSync(marker, 'utf8')).toBe('used');
  });

  it('sets both npm script-shell environment casings', async () => {
    const {controller} = await createController({
      vitest: {response: {exitCode: 0, stdout: '', stderr: ''}},
    });

    const env = controller.env(process.env.PATH ?? '');

    expect(env.NPM_CONFIG_SCRIPT_SHELL).toBe(env.npm_config_script_shell);
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
      invalidExitCode: {
        handler: () => ({exitCode: 256}),
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
    expect(await runMock(controller, workDir, 'invalidExitCode')).toMatchObject(
      {
        exitCode: 1,
        stderr: expect.stringContaining('between 0 and 255'),
      },
    );
    expect(controller.failures()).toHaveLength(3);
  });

  it.each([
    {response: {exitCode: -1, stdout: '', stderr: ''}},
    {
      responses: [{exitCode: 256, stdout: '', stderr: ''}],
      onExhausted: 'error' as const,
    },
    {
      responses: [{exitCode: 0, stdout: '', stderr: ''}],
      onExhausted: {exitCode: 256, stdout: '', stderr: ''},
    },
  ])(
    'rejects configured exit codes outside the process range',
    async (config) => {
      await expect(
        startCliMockController({invalid: config} as IrScenario['cliMocks']),
      ).rejects.toThrow('between 0 and 255');
    },
  );

  it('installs private executable shims outside the workdir and cleans them up', async () => {
    const {controller, workDir} = await createController({
      vitest: {response: {exitCode: 0, stdout: '', stderr: ''}},
    });
    const env = controller.env(process.env.PATH ?? '');
    const socketPath = env.DYNOBOX_CLI_MOCK_SOCKET!;
    const binDir = env.DYNOBOX_CLI_MOCK_BIN!;

    expect(statSync(dirname(socketPath)).mode & 0o777).toBe(0o700);
    expect(statSync(join(binDir, 'vitest')).mode & 0o777).toBe(0o700);
    expect(() => statSync(join(workDir, '.dynobox'))).toThrow();

    await controller.stop();
    expect(() => statSync(socketPath)).toThrow();
    expect(() => statSync(binDir)).toThrow();
  });

  it('rejects unsupported platforms with an actionable diagnostic', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');

    await expect(
      startCliMockController({
        vitest: {response: {exitCode: 0, stdout: '', stderr: ''}},
      }),
    ).rejects.toThrow('CLI mocks currently require macOS or Linux');
  });

  it('times out handlers that do not return a response', async () => {
    const {controller, workDir} = await createController(
      {
        hanging: {
          handler: async () => {
            await new Promise(() => undefined);
            return {exitCode: 0};
          },
        },
      },
      {requestTimeoutMs: 20},
    );

    const result = await runMock(controller, workDir, 'hanging');

    expect(result).toMatchObject({
      exitCode: 1,
      stderr: expect.stringContaining('timed out after 20 milliseconds'),
    });
    expect(controller.failures()).toEqual([
      expect.objectContaining({message: expect.stringContaining('timed out')}),
    ]);
  });

  it('survives clients disconnecting before a response is ready', async () => {
    let markHandlerStarted: (() => void) | undefined;
    const handlerStarted = new Promise<void>((resolve) => {
      markHandlerStarted = resolve;
    });
    let releaseHandler: (() => void) | undefined;
    const {controller, workDir} = await createController({
      delayed: {
        handler: async () => {
          markHandlerStarted?.();
          await new Promise<void>((resolve) => {
            releaseHandler = resolve;
          });
          return {exitCode: 0};
        },
      },
    });
    const env = controller.env(process.env.PATH ?? '');
    const client = createConnection(env.DYNOBOX_CLI_MOCK_SOCKET!);
    client.on('error', () => undefined);
    await new Promise<void>((resolve) => client.once('connect', resolve));
    client.write(
      `${JSON.stringify({
        token: env.DYNOBOX_CLI_MOCK_TOKEN,
        executable: 'delayed',
        argv: [],
        cwd: workDir,
        env: {},
      })}\n`,
    );
    await handlerStarted;

    client.destroy();
    releaseHandler?.();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(controller.calls()).toEqual([
      expect.objectContaining({executable: 'delayed', exitCode: 0}),
    ]);
  });

  it('finalizes pending calls as failed evidence', async () => {
    let handlerStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      handlerStarted = resolve;
    });
    let releaseHandler: (() => void) | undefined;
    const {controller, workDir} = await createController({
      delayed: {
        handler: async () => {
          handlerStarted?.();
          await new Promise<void>((resolve) => {
            releaseHandler = resolve;
          });
          throw new Error('late handler failure');
        },
      },
    });

    const invocation = runMock(controller, workDir, 'delayed');
    await started;
    expect(controller.calls()).toEqual([]);

    await controller.finalizePendingCalls();
    await expect(invocation).resolves.toMatchObject({
      exitCode: 1,
      stderr: expect.stringContaining('did not complete'),
    });
    expect(controller.calls()).toEqual([
      expect.objectContaining({executable: 'delayed', exitCode: 1}),
    ]);
    expect(controller.failures()).toEqual([
      expect.objectContaining({
        message: expect.stringContaining('did not complete'),
      }),
    ]);

    releaseHandler?.();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(controller.failures()).toHaveLength(1);
  });

  it('rejects retired phase tokens without mutating finalized evidence', async () => {
    const {controller, workDir} = await createController({
      delayed: {response: {exitCode: 0, stdout: 'unexpected', stderr: ''}},
    });
    const retiredEnv = controller.env(process.env.PATH ?? '');
    await controller.finalizePendingCalls();
    controller.beginPhase();

    const result = await runMock(
      controller,
      workDir,
      'delayed',
      [],
      retiredEnv,
    );

    expect(result).toMatchObject({
      exitCode: 1,
      stderr: expect.stringContaining('Invalid CLI mock token'),
    });
    expect(controller.calls()).toEqual([]);
    expect(controller.failures()).toEqual([]);
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

async function createController(
  mocks: IrScenario['cliMocks'],
  options?: Parameters<typeof startCliMockController>[1],
): Promise<{
  controller: CliMockController;
  workDir: string;
}> {
  const workDir = mkdtempSync(join(tmpdir(), 'dynobox-cli-mocks-'));
  workDirs.push(workDir);
  const controller = await startCliMockController(mocks, options);
  controllers.push(controller);
  await controller.install();
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
