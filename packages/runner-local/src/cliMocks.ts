import {randomBytes} from 'node:crypto';
import {chmod, mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {createServer, type Server, type Socket} from 'node:net';
import {tmpdir} from 'node:os';
import {delimiter, join} from 'node:path';

import type {IrScenario} from '@dynobox/sdk/ir';

import type {CliMockCall} from './runTypes.js';

const MAX_REQUEST_BYTES = 10 * 1024 * 1024;
const SOCKET_ENV = 'DYNOBOX_CLI_MOCK_SOCKET';
const TOKEN_ENV = 'DYNOBOX_CLI_MOCK_TOKEN';
const NODE_ENV = 'DYNOBOX_CLI_MOCK_NODE';
const CLIENT_ENV = 'DYNOBOX_CLI_MOCK_CLIENT';
const BIN_ENV = 'DYNOBOX_CLI_MOCK_BIN';
const TIMEOUT_ENV = 'DYNOBOX_CLI_MOCK_TIMEOUT_MS';
const SCRIPT_SHELL_ENV = 'DYNOBOX_CLI_MOCK_SCRIPT_SHELL';
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const CLIENT_TIMEOUT_GRACE_MS = 1_000;

type CliMockConfig = IrScenario['cliMocks'][string];

export type CliMockFailure = {
  executable: string;
  argv: string[];
  message: string;
};

export type CliMockController = {
  readonly executableNames: readonly string[];
  install(workDir: string): Promise<void>;
  env(basePath: string, baseScriptShell?: string): Record<string, string>;
  calls(): CliMockCall[];
  failures(): CliMockFailure[];
  stop(): Promise<void>;
};

type CliMockRequest = {
  token: string;
  executable: string;
  argv: string[];
  cwd: string;
  env: Record<string, string>;
};

type CliMockResponse = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

type PendingCall = {
  sequence: number;
  executable: string;
  argv: string[];
  cwd: string;
  timestamp: number;
  response?: CliMockResponse;
};

export async function startCliMockController(
  mocks: IrScenario['cliMocks'],
  options: {requestTimeoutMs?: number} = {},
): Promise<CliMockController> {
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    throw new Error('CLI mocks currently require macOS or Linux.');
  }
  const requestTimeoutMs =
    options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw new Error('CLI mock request timeout must be a positive integer.');
  }
  const executableNames = Object.keys(mocks);
  for (const [executable, config] of Object.entries(mocks)) {
    validateExecutableName(executable);
    validateConfiguredResponses(executable, config);
  }

  const socketDir = await mkdtemp(join(tmpdir(), 'dxb-mock-'));
  await chmod(socketDir, 0o700);
  const socketPath = join(socketDir, 'mock.sock');
  const token = randomBytes(32).toString('hex');
  const mockByExecutable = new Map(Object.entries(mocks));
  const responseIndexes = new Map<string, number>();
  const pendingCalls: PendingCall[] = [];
  const failures: CliMockFailure[] = [];
  const sockets = new Set<Socket>();
  let nextSequence = 0;
  let binDir: string | undefined;
  let clientPath: string | undefined;
  let scriptShellPath: string | undefined;
  let stopped = false;

  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => socket.destroy());
    socket.once('close', () => sockets.delete(socket));
    receiveRequest(
      socket,
      async (request) => {
        const config = mockByExecutable.get(request.executable);
        if (config === undefined) {
          sendResponse(socket, internalError('Unknown CLI mock executable.'));
          return;
        }

        const call: PendingCall = {
          sequence: nextSequence++,
          executable: request.executable,
          argv: [...request.argv],
          cwd: request.cwd,
          timestamp: Date.now(),
        };
        pendingCalls.push(call);

        const assignment = reserveResponse(
          request.executable,
          request.argv,
          config,
          responseIndexes,
          failures,
        );
        let response: CliMockResponse;
        if ('response' in assignment) {
          response = assignment.response;
        } else {
          try {
            response = normalizeHandlerResponse(
              await withTimeout(
                Promise.resolve(
                  assignment.handler({
                    argv: [...request.argv],
                    cwd: request.cwd,
                    env: {...request.env},
                  }),
                ),
                requestTimeoutMs,
              ),
            );
          } catch (error) {
            const reason =
              error instanceof Error && error.message.length > 0
                ? error.message
                : String(error);
            const message = mockFailureMessage(
              request.executable,
              request.argv,
              `handler failed: ${reason}`,
            );
            failures.push({
              executable: request.executable,
              argv: [...request.argv],
              message,
            });
            response = internalError(message);
          }
        }

        call.response = response;
        sendResponse(socket, response);
      },
      token,
      mockByExecutable,
    );
  });

  try {
    await listen(server, socketPath);
  } catch (error) {
    await rm(socketDir, {force: true, recursive: true});
    throw error;
  }

  return {
    executableNames,
    async install(workDir) {
      if (stopped) throw new Error('CLI mock controller is already stopped.');

      const rootDir = join(workDir, '.dynobox', 'cli-mocks');
      const nextBinDir = join(rootDir, 'bin');
      const nextClientPath = join(rootDir, 'client.mjs');
      const nextScriptShellPath = join(rootDir, 'script-shell');
      await mkdir(nextBinDir, {recursive: true});
      await writeFile(nextClientPath, CLIENT_SOURCE, {mode: 0o600});
      await writeFile(nextScriptShellPath, SCRIPT_SHELL_SOURCE, {mode: 0o700});
      for (const executable of executableNames) {
        await writeFile(join(nextBinDir, executable), LAUNCHER_SOURCE, {
          mode: 0o700,
        });
      }
      binDir = nextBinDir;
      clientPath = nextClientPath;
      scriptShellPath = nextScriptShellPath;
    },
    env(basePath, baseScriptShell = '/bin/sh') {
      if (
        binDir === undefined ||
        clientPath === undefined ||
        scriptShellPath === undefined
      ) {
        throw new Error('CLI mock shims have not been installed.');
      }
      return {
        PATH: `${binDir}${delimiter}${basePath}`,
        [SOCKET_ENV]: socketPath,
        [TOKEN_ENV]: token,
        [NODE_ENV]: process.execPath,
        [CLIENT_ENV]: clientPath,
        [BIN_ENV]: binDir,
        [TIMEOUT_ENV]: String(requestTimeoutMs + CLIENT_TIMEOUT_GRACE_MS),
        [SCRIPT_SHELL_ENV]: baseScriptShell,
        npm_config_script_shell: scriptShellPath,
      };
    },
    calls() {
      return pendingCalls
        .filter(
          (call): call is PendingCall & {response: CliMockResponse} =>
            call.response !== undefined,
        )
        .sort((left, right) => left.sequence - right.sequence)
        .map(({executable, argv, cwd, timestamp, response}) => ({
          executable,
          argv: [...argv],
          cwd,
          timestamp,
          ...response,
        }));
    },
    failures() {
      return failures.map((failure) => ({
        ...failure,
        argv: [...failure.argv],
      }));
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      for (const socket of sockets) socket.destroy();
      await closeServer(server);
      await rm(socketDir, {force: true, recursive: true});
    },
  };
}

function receiveRequest(
  socket: Socket,
  onRequest: (request: CliMockRequest) => void | Promise<void>,
  token: string,
  mocks: ReadonlyMap<string, CliMockConfig>,
): void {
  let buffer = '';
  let handled = false;
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    if (handled) return;
    buffer += chunk;
    if (Buffer.byteLength(buffer) > MAX_REQUEST_BYTES) {
      handled = true;
      sendResponse(socket, internalError('CLI mock request was too large.'));
      return;
    }
    const newlineIndex = buffer.indexOf('\n');
    if (newlineIndex === -1) return;
    handled = true;

    try {
      const request = parseRequest(buffer.slice(0, newlineIndex), token, mocks);
      void Promise.resolve(onRequest(request)).catch((error) => {
        sendResponse(socket, internalError(errorMessage(error)));
      });
    } catch (error) {
      sendResponse(socket, internalError(errorMessage(error)));
    }
  });
}

function parseRequest(
  payload: string,
  token: string,
  mocks: ReadonlyMap<string, CliMockConfig>,
): CliMockRequest {
  const value: unknown = JSON.parse(payload);
  if (!isRecord(value)) throw new Error('Malformed CLI mock request.');
  if (value.token !== token) throw new Error('Invalid CLI mock token.');
  if (typeof value.executable !== 'string' || !mocks.has(value.executable)) {
    throw new Error('Unknown CLI mock executable.');
  }
  if (
    !Array.isArray(value.argv) ||
    !value.argv.every((argument) => typeof argument === 'string')
  ) {
    throw new Error('Malformed CLI mock argv.');
  }
  if (typeof value.cwd !== 'string') throw new Error('Malformed CLI mock cwd.');
  if (
    !isRecord(value.env) ||
    !Object.values(value.env).every((entry) => typeof entry === 'string')
  ) {
    throw new Error('Malformed CLI mock environment.');
  }
  return {
    token: value.token,
    executable: value.executable,
    argv: value.argv,
    cwd: value.cwd,
    env: value.env as Record<string, string>,
  };
}

function reserveResponse(
  executable: string,
  argv: string[],
  config: CliMockConfig,
  responseIndexes: Map<string, number>,
  failures: CliMockFailure[],
):
  | {response: CliMockResponse}
  | {
      handler: Extract<CliMockConfig, {handler: unknown}>['handler'];
    } {
  if ('response' in config) return {response: config.response};
  if ('handler' in config) return {handler: config.handler};

  const index = responseIndexes.get(executable) ?? 0;
  responseIndexes.set(executable, index + 1);
  if (index < config.responses.length) {
    return {response: config.responses[index]!};
  }
  if (config.onExhausted === 'repeat-last') {
    return {response: config.responses.at(-1)!};
  }
  if (config.onExhausted !== 'error') {
    return {response: config.onExhausted};
  }

  const message = mockFailureMessage(
    executable,
    argv,
    'exhausted its configured responses',
  );
  failures.push({executable, argv: [...argv], message});
  return {response: internalError(message)};
}

function normalizeHandlerResponse(value: unknown): CliMockResponse {
  if (!isRecord(value)) {
    throw new Error('returned an invalid response');
  }
  assertProcessExitCode(value.exitCode, 'returned an invalid response');
  if (value.stdout !== undefined && typeof value.stdout !== 'string') {
    throw new Error('returned an invalid response: stdout must be a string');
  }
  if (value.stderr !== undefined && typeof value.stderr !== 'string') {
    throw new Error('returned an invalid response: stderr must be a string');
  }
  return {
    exitCode: value.exitCode as number,
    stdout: (value.stdout as string | undefined) ?? '',
    stderr: (value.stderr as string | undefined) ?? '',
  };
}

function validateConfiguredResponses(
  executable: string,
  config: CliMockConfig,
): void {
  if ('handler' in config) return;
  const responses =
    'response' in config
      ? [config.response]
      : [
          ...config.responses,
          ...(typeof config.onExhausted === 'object'
            ? [config.onExhausted]
            : []),
        ];
  for (const response of responses) {
    assertProcessExitCode(
      response.exitCode,
      `Invalid CLI mock response for ${JSON.stringify(executable)}`,
    );
  }
}

function assertProcessExitCode(
  value: unknown,
  context: string,
): asserts value is number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > 255
  ) {
    throw new Error(
      `${context}: exitCode must be an integer between 0 and 255`,
    );
  }
}

function validateExecutableName(executable: string): void {
  if (
    executable.length === 0 ||
    executable === '.' ||
    executable === '..' ||
    executable.includes('/') ||
    executable.includes('\\') ||
    executable.includes('\0')
  ) {
    throw new Error(
      `Invalid CLI mock executable name: ${JSON.stringify(executable)}.`,
    );
  }
}

function mockFailureMessage(
  executable: string,
  argv: readonly string[],
  reason: string,
): string {
  const command = [executable, ...argv].join(' ');
  return `Dynobox CLI mock "${command}" ${reason}.`;
}

function internalError(message: string): CliMockResponse {
  return {
    exitCode: 1,
    stdout: '',
    stderr: message.startsWith('Dynobox')
      ? `${message}\n`
      : `Dynobox CLI mock error: ${message}\n`,
  };
}

function sendResponse(socket: Socket, response: CliMockResponse): void {
  if (socket.destroyed) return;
  try {
    socket.end(`${JSON.stringify(response)}\n`);
  } catch {
    socket.destroy();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  return String(error);
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`timed out after ${timeoutMs} milliseconds`)),
      timeoutMs,
    );
    timer.unref();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function listen(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(socketPath);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error !== undefined) reject(error);
      else resolve();
    });
  });
}

const LAUNCHER_SOURCE = `#!/bin/sh
exec "$${NODE_ENV}" "$${CLIENT_ENV}" "$0" "$@"
`;

const SCRIPT_SHELL_SOURCE = `#!/bin/sh
export PATH="$${BIN_ENV}:$PATH"
exec "$${SCRIPT_SHELL_ENV}" "$@"
`;

const CLIENT_SOURCE = `import net from 'node:net';
import {basename} from 'node:path';

const socketPath = process.env.${SOCKET_ENV};
const token = process.env.${TOKEN_ENV};
const requestTimeoutMs = Number.parseInt(process.env.${TIMEOUT_ENV} ?? '', 10);
const executable = basename(process.argv[2] ?? '');
const argv = process.argv.slice(3);

function fail(message) {
  process.stderr.write('Dynobox CLI mock error: ' + message + '\\n');
  process.exitCode = 1;
}

if (
  !socketPath ||
  !token ||
  !Number.isSafeInteger(requestTimeoutMs) ||
  requestTimeoutMs <= 0 ||
  !executable
) {
  fail('missing internal configuration.');
} else {
  await new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    let buffer = '';
    let settled = false;

    function finish() {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve();
    }

    socket.setEncoding('utf8');
    socket.setTimeout(requestTimeoutMs);
    socket.once('timeout', () => {
      fail('request timed out after ' + requestTimeoutMs + ' milliseconds.');
      finish();
    });
    socket.once('connect', () => {
      socket.write(JSON.stringify({
        token,
        executable,
        argv,
        cwd: process.cwd(),
        env: process.env,
      }) + '\\n');
    });
    socket.on('data', (chunk) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf('\\n');
      if (newlineIndex === -1) return;
      try {
        const response = JSON.parse(buffer.slice(0, newlineIndex));
        if (
          !Number.isInteger(response.exitCode) ||
          typeof response.stdout !== 'string' ||
          typeof response.stderr !== 'string'
        ) {
          throw new Error('malformed response.');
        }
        process.stdout.write(response.stdout);
        process.stderr.write(response.stderr);
        process.exitCode = response.exitCode;
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
      }
      finish();
    });
    socket.once('error', (error) => {
      fail('controller unavailable: ' + error.message);
      finish();
    });
    socket.once('end', () => {
      if (!settled) {
        fail('controller returned no response.');
        finish();
      }
    });
  });
}
`;
