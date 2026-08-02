import {mkdir, writeFile} from 'node:fs/promises';
import {delimiter, join} from 'node:path';

/** Creates executable shims that forward mocked CLI calls to the controller. */

const SOCKET_ENV = 'DYNOBOX_CLI_MOCK_SOCKET';
const TOKEN_ENV = 'DYNOBOX_CLI_MOCK_TOKEN';
const NODE_EXECUTABLE_ENV = 'DYNOBOX_CLI_MOCK_NODE';
const CLIENT_ENV = 'DYNOBOX_CLI_MOCK_CLIENT';
const BIN_ENV = 'DYNOBOX_CLI_MOCK_BIN';
const TIMEOUT_ENV = 'DYNOBOX_CLI_MOCK_TIMEOUT_MS';
const SCRIPT_SHELL_ENV = 'DYNOBOX_CLI_MOCK_SCRIPT_SHELL';
const CLIENT_TIMEOUT_GRACE_MS = 1_000;

export type CliMockShims = {
  env(options: {
    socketPath: string;
    token: string;
    requestTimeoutMs: number;
    basePath: string;
    baseScriptShell?: string;
  }): Record<string, string>;
};

/**
 * Installs launcher binaries and the Node socket client in an isolated
 * directory, returning the environment needed to activate them.
 */
export async function installCliMockShims(
  rootDir: string,
  executableNames: readonly string[],
): Promise<CliMockShims> {
  const binDir = join(rootDir, 'bin');
  const clientPath = join(rootDir, 'client.mjs');
  const scriptShellPath = join(rootDir, 'script-shell');
  await mkdir(binDir, {recursive: true});
  await writeFile(clientPath, CLIENT_SOURCE, {mode: 0o600});
  await writeFile(scriptShellPath, SCRIPT_SHELL_SOURCE, {mode: 0o700});
  for (const executable of executableNames) {
    await writeFile(join(binDir, executable), LAUNCHER_SOURCE, {mode: 0o700});
  }

  return {
    env({
      socketPath,
      token,
      requestTimeoutMs,
      basePath,
      baseScriptShell = '/bin/sh',
    }) {
      return {
        PATH: `${binDir}${delimiter}${basePath}`,
        [SOCKET_ENV]: socketPath,
        [TOKEN_ENV]: token,
        [NODE_EXECUTABLE_ENV]: process.execPath,
        [CLIENT_ENV]: clientPath,
        [BIN_ENV]: binDir,
        [TIMEOUT_ENV]: String(requestTimeoutMs + CLIENT_TIMEOUT_GRACE_MS),
        [SCRIPT_SHELL_ENV]: baseScriptShell,
        npm_config_script_shell: scriptShellPath,
        NPM_CONFIG_SCRIPT_SHELL: scriptShellPath,
      };
    },
  };
}

const LAUNCHER_SOURCE = `#!/bin/sh
exec "$${NODE_EXECUTABLE_ENV}" "$${CLIENT_ENV}" "$0" "$@"
`;

const SCRIPT_SHELL_SOURCE = `#!/bin/sh
export PATH="\${${BIN_ENV}:?missing internal configuration}:$PATH"
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
