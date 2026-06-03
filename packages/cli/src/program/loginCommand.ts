import {createInterface} from 'node:readline/promises';

import {CommanderError} from 'commander';

import {
  authConfigDisplayPath,
  type AuthEnvironment,
  writeAuthConfig,
} from './auth.js';
import type {OutputWriter} from './execute.js';
import {configErrorExitCode} from './exitCodes.js';
import {
  fetchAuthenticatedIdentity,
  normalizeUrl,
  resolveApiUrl,
} from './identityApi.js';

const DEFAULT_DASHBOARD_URL = 'https://dash.dynobox.xyz';

// Control bytes received from a TTY in raw mode.
const CTRL_C = 0x03; // cancel
const CTRL_D = 0x04; // end of transmission
const BACKSPACE = 0x08;
const DELETE = 0x7f;

export type LoginCommandActionInput = {
  writeStdout: OutputWriter;
  writeStderr: OutputWriter;
  env?: AuthEnvironment;
  homeDir?: string;
  readStdin?: () => Promise<string>;
};

export async function loginCommandAction(
  input: LoginCommandActionInput,
): Promise<void> {
  const env = input.env ?? process.env;
  const dashboardUrl = normalizeUrl(
    env.DYNOBOX_DASHBOARD_URL,
    DEFAULT_DASHBOARD_URL,
  );
  const apiUrl = resolveApiUrl(env);

  input.writeStdout(
    `Open this URL to create a Dynobox CLI token:\n${dashboardUrl}/cli-auth\n\nPaste your Dynobox token:\n`,
  );

  const rawToken = await (input.readStdin ?? readProcessStdin)();
  const token = rawToken.trim();
  if (token.length === 0) {
    input.writeStderr('error: token cannot be empty\n');
    throw new CommanderError(
      configErrorExitCode,
      'dynobox.login',
      'token cannot be empty',
    );
  }

  await validateLoginToken({
    apiUrl,
    token,
    writeStderr: input.writeStderr,
  });

  writeAuthConfig({
    token,
    env,
    ...(input.homeDir === undefined ? {} : {homeDir: input.homeDir}),
  });
  input.writeStdout(`Saved token to ${authConfigDisplayPath()}\n`);
}

async function validateLoginToken(input: {
  apiUrl: string;
  token: string;
  writeStderr: OutputWriter;
}): Promise<void> {
  const result = await fetchAuthenticatedIdentity(input);

  if (result.status === 'authenticated') return;

  if (result.status === 'network_failure') {
    input.writeStderr(
      'error: could not validate token; unable to reach the Dynobox API\n',
    );
    throw new CommanderError(
      configErrorExitCode,
      'dynobox.login',
      'token validation failed',
    );
  }

  if (result.status === 'unauthorized') {
    input.writeStderr('error: invalid or revoked token\n');
  } else if (result.status === 'expired') {
    input.writeStderr(
      'error: token expired; run `dynobox login` again to re-authenticate\n',
    );
  } else {
    input.writeStderr(
      `error: could not validate token; Dynobox API returned ${result.httpStatus}\n`,
    );
  }
  throw new CommanderError(
    configErrorExitCode,
    'dynobox.login',
    'token validation failed',
  );
}

/**
 * Read a single line from stdin. On a TTY we suppress echo so the pasted token
 * never lands on screen or in scrollback; piped/non-TTY input (e.g. CI doing
 * `echo "$TOKEN" | dynobox login`) falls back to a plain line read.
 */
async function readProcessStdin(): Promise<string> {
  if (process.stdin.isTTY) return readSecretFromTty();

  const reader = createInterface({input: process.stdin, crlfDelay: Infinity});
  try {
    for await (const line of reader) return line;
    return '';
  } finally {
    reader.close();
  }
}

/**
 * Read one line from a TTY without echoing keystrokes. Raw mode disables the
 * terminal's own echo and signal handling, so we accumulate bytes ourselves:
 * Enter and Ctrl-D submit, Ctrl-C cancels (surfacing as an empty token), and
 * Backspace/Delete edits the buffer.
 */
function readSecretFromTty(): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw ?? false;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    let token = '';
    const finish = (value: string): void => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
      process.stdout.write('\n');
      resolve(value);
    };
    const onData = (chunk: string): void => {
      for (const char of chunk) {
        const code = char.charCodeAt(0);
        if (char === '\n' || char === '\r' || code === CTRL_D) {
          finish(token);
          return;
        }
        if (code === CTRL_C) {
          finish('');
          return;
        }
        if (code === BACKSPACE || code === DELETE) {
          token = token.slice(0, -1);
          continue;
        }
        token += char;
      }
    };
    stdin.on('data', onData);
  });
}
