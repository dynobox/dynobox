import {randomBytes} from 'node:crypto';
import {chmod, mkdtemp, rm} from 'node:fs/promises';
import {createServer, type Server, type Socket} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import type {CliMockCall} from '@dynobox/evaluators';
import type {IrScenario} from '@dynobox/sdk/ir';

import {
  type CliMockConfig,
  type CliMockFailure,
  type CliMockResponse,
  createCliMockResponseResolver,
  internalError,
  mockFailureMessage,
  normalizeHandlerResponse,
} from './cliMocks/responses.js';
import {type CliMockShims, installCliMockShims} from './cliMocks/shims.js';

const MAX_REQUEST_BYTES = 10 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export type {CliMockFailure} from './cliMocks/responses.js';

export type CliMockController = {
  readonly executableNames: readonly string[];
  install(): Promise<void>;
  beginPhase(): void;
  env(basePath: string, baseScriptShell?: string): Record<string, string>;
  calls(): CliMockCall[];
  failures(): CliMockFailure[];
  finalizePendingCalls(): Promise<void>;
  stop(): Promise<void>;
};

type CliMockRequest = {
  token: string;
  executable: string;
  argv: string[];
  cwd: string;
  env: Record<string, string>;
};

type PendingCall = {
  sequence: number;
  executable: string;
  argv: string[];
  cwd: string;
  timestamp: number;
  socket: Socket;
  response?: CliMockResponse;
};

/**
 * Starts a local socket controller that serves configured CLI mock responses
 * through temporary executable shims. Install it before an execution phase,
 * then call `beginPhase`, `env`, and `finalizePendingCalls` for each phase.
 */
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
  for (const executable of executableNames) {
    validateExecutableName(executable);
  }

  const socketDir = await mkdtemp(join(tmpdir(), 'dxb-mock-'));
  await chmod(socketDir, 0o700);
  const socketPath = join(socketDir, 'mock.sock');
  let activeToken: string | undefined = randomBytes(32).toString('hex');
  const mockByExecutable = new Map(Object.entries(mocks));
  const responseResolver = createCliMockResponseResolver(mocks);
  const pendingCalls: PendingCall[] = [];
  const failures: CliMockFailure[] = [];
  const sockets = new Set<Socket>();
  let nextSequence = 0;
  let shims: CliMockShims | undefined;
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
          socket,
        };
        pendingCalls.push(call);

        const assignment = responseResolver.reserve(
          request.executable,
          request.argv,
          config,
        );
        if ('failure' in assignment && assignment.failure !== undefined) {
          failures.push(assignment.failure);
        }
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
            if (call.response !== undefined) return;
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

        if (call.response === undefined) {
          call.response = response;
          sendResponse(socket, response);
        }
      },
      () => activeToken,
      mockByExecutable,
    );
  });

  try {
    await listen(server, socketPath);
  } catch (error) {
    await rm(socketDir, {force: true, recursive: true});
    throw error;
  }

  const finalizePendingCalls = async () => {
    if (activeToken !== undefined) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      activeToken = undefined;
    }
    for (const call of pendingCalls) {
      if (call.response !== undefined) continue;
      const message = mockFailureMessage(
        call.executable,
        call.argv,
        'did not complete before the execution phase ended',
      );
      failures.push({
        executable: call.executable,
        argv: [...call.argv],
        message,
      });
      call.response = internalError(message);
      sendResponse(call.socket, call.response);
    }
  };

  return {
    executableNames,
    async install() {
      if (stopped) throw new Error('CLI mock controller is already stopped.');

      shims = await installCliMockShims(
        join(socketDir, 'support'),
        executableNames,
      );
    },
    beginPhase() {
      if (stopped) throw new Error('CLI mock controller is already stopped.');
      if (activeToken !== undefined) {
        throw new Error('CLI mock execution phase is already active.');
      }
      activeToken = randomBytes(32).toString('hex');
    },
    env(basePath, baseScriptShell = '/bin/sh') {
      if (shims === undefined) {
        throw new Error('CLI mock shims have not been installed.');
      }
      if (activeToken === undefined) {
        throw new Error('CLI mock execution phase is not active.');
      }
      return shims.env({
        socketPath,
        token: activeToken,
        requestTimeoutMs,
        basePath,
        baseScriptShell,
      });
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
    finalizePendingCalls,
    async stop() {
      if (stopped) return;
      stopped = true;
      await finalizePendingCalls();
      for (const socket of sockets) socket.destroy();
      await closeServer(server);
      await rm(socketDir, {force: true, recursive: true});
    },
  };
}

/** Reads and validates one newline-delimited request from a shim socket. */
function receiveRequest(
  socket: Socket,
  onRequest: (request: CliMockRequest) => void | Promise<void>,
  activeToken: () => string | undefined,
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
      const request = parseRequest(
        buffer.slice(0, newlineIndex),
        activeToken(),
        mocks,
      );
      void Promise.resolve(onRequest(request)).catch((error) => {
        sendResponse(socket, internalError(errorMessage(error)));
      });
    } catch (error) {
      sendResponse(socket, internalError(errorMessage(error)));
    }
  });
}

/** Parses the shim request and verifies it belongs to the active execution phase. */
function parseRequest(
  payload: string,
  activeToken: string | undefined,
  mocks: ReadonlyMap<string, CliMockConfig>,
): CliMockRequest {
  const value: unknown = JSON.parse(payload);
  if (!isRecord(value)) throw new Error('Malformed CLI mock request.');
  if (typeof value.token !== 'string') {
    throw new Error('Invalid CLI mock token.');
  }
  if (activeToken === undefined || value.token !== activeToken) {
    throw new Error('Invalid CLI mock token.');
  }
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
