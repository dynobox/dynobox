import {createInterface} from 'node:readline/promises';

import {CommanderError} from 'commander';

import {
  authConfigDisplayPath,
  type AuthEnvironment,
  writeAuthConfig,
} from './auth.js';
import type {OutputWriter} from './execute.js';
import {configErrorExitCode} from './exitCodes.js';

const DEFAULT_DASHBOARD_URL = 'https://dash.dynobox.xyz';
const DEFAULT_API_URL = 'https://api.dynobox.xyz';
const LOGIN_TOKEN_VALIDATION_TIMEOUT_MS = 10_000;

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
  const apiUrl = normalizeUrl(env.DYNOBOX_API_URL, DEFAULT_API_URL);

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
  let response: Response;
  try {
    response = await fetch(`${input.apiUrl}/auth/identity`, {
      headers: {authorization: `Bearer ${input.token}`},
      method: 'GET',
      signal: AbortSignal.timeout(LOGIN_TOKEN_VALIDATION_TIMEOUT_MS),
    });
  } catch {
    input.writeStderr(
      'error: could not validate token; unable to reach the Dynobox API\n',
    );
    throw new CommanderError(
      configErrorExitCode,
      'dynobox.login',
      'token validation failed',
    );
  }

  if (response.ok) return;

  if (response.status === 401) {
    input.writeStderr('error: invalid or revoked token\n');
  } else {
    input.writeStderr(
      `error: could not validate token; Dynobox API returned ${response.status}\n`,
    );
  }
  throw new CommanderError(
    configErrorExitCode,
    'dynobox.login',
    'token validation failed',
  );
}

function normalizeUrl(value: string | undefined, fallback: string): string {
  const raw = value?.trim() || fallback;
  return raw.replace(/\/+$/, '');
}

async function readProcessStdin(): Promise<string> {
  const reader = createInterface({input: process.stdin, crlfDelay: Infinity});
  try {
    for await (const line of reader) return line;
    return '';
  } finally {
    reader.close();
  }
}
