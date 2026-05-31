import {createInterface} from 'node:readline/promises';

import {CommanderError} from 'commander';

import {
  authConfigDisplayPath,
  writeAuthConfig,
  type AuthEnvironment,
} from './auth.js';
import type {OutputWriter} from './execute.js';
import {configErrorExitCode} from './exitCodes.js';

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
  const dashboardUrl = normalizeDashboardUrl(env.DYNOBOX_DASHBOARD_URL);

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

  writeAuthConfig({
    token,
    env,
    ...(input.homeDir === undefined ? {} : {homeDir: input.homeDir}),
  });
  input.writeStdout(`Saved token to ${authConfigDisplayPath()}\n`);
}

function normalizeDashboardUrl(value: string | undefined): string {
  const raw = value?.trim() || DEFAULT_DASHBOARD_URL;
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
