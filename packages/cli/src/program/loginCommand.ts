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

async function readProcessStdin(): Promise<string> {
  const reader = createInterface({input: process.stdin, crlfDelay: Infinity});
  try {
    for await (const line of reader) return line;
    return '';
  } finally {
    reader.close();
  }
}
