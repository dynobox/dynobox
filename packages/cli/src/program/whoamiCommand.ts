import {CommanderError} from 'commander';

import {
  authConfigDisplayPath,
  type AuthEnvironment,
  resolveAuthToken,
} from './auth.js';
import type {OutputWriter} from './execute.js';
import {configErrorExitCode} from './exitCodes.js';
import {fetchAuthenticatedIdentity, resolveApiUrl} from './identityApi.js';

export type WhoamiCommandActionInput = {
  writeStdout: OutputWriter;
  writeStderr: OutputWriter;
  env?: AuthEnvironment;
  homeDir?: string;
};

export async function whoamiCommandAction(
  input: WhoamiCommandActionInput,
): Promise<void> {
  const env = input.env ?? process.env;
  const token = resolveAuthToken({
    env,
    ...(input.homeDir === undefined ? {} : {homeDir: input.homeDir}),
  });

  if (token === null) {
    input.writeStderr('error: not authenticated; run `dynobox login` first\n');
    throw new CommanderError(
      configErrorExitCode,
      'dynobox.whoami',
      'not authenticated',
    );
  }

  const result = await fetchAuthenticatedIdentity({
    apiUrl: resolveApiUrl(env),
    token,
  });

  if (result.status === 'authenticated') {
    if (result.identity.email !== undefined) {
      input.writeStdout(`Authenticated as ${result.identity.email}\n`);
    } else {
      input.writeStdout(
        'Authenticated, but this token has no email metadata. Run `dynobox login` again to refresh it.\n',
      );
    }
    input.writeStdout(`${describeTokenSource(env)}\n`);
    return;
  }

  if (result.status === 'network_failure') {
    input.writeStderr(
      'error: could not verify identity; unable to reach the Dynobox API\n',
    );
  } else if (result.status === 'unauthorized') {
    input.writeStderr('error: invalid or revoked token\n');
  } else if (result.status === 'expired') {
    input.writeStderr(
      'error: token expired; run `dynobox login` again to re-authenticate\n',
    );
  } else {
    input.writeStderr(
      `error: could not verify identity; Dynobox API returned ${result.httpStatus}\n`,
    );
  }

  throw new CommanderError(
    configErrorExitCode,
    'dynobox.whoami',
    'identity verification failed',
  );
}

function describeTokenSource(env: AuthEnvironment): string {
  if ((env.DYNOBOX_TOKEN ?? '').trim().length > 0) {
    return 'Token loaded from the DYNOBOX_TOKEN environment variable';
  }
  return `Token loaded from ${authConfigDisplayPath()}`;
}
