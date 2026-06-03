import {
  authConfigDisplayPath,
  type AuthEnvironment,
  deleteAuthConfig,
} from './auth.js';
import type {OutputWriter} from './execute.js';

export type LogoutCommandActionInput = {
  writeStdout: OutputWriter;
  env?: AuthEnvironment;
  homeDir?: string;
};

export function logoutCommandAction(input: LogoutCommandActionInput): void {
  const env = input.env ?? process.env;
  const removed = deleteAuthConfig({
    env,
    ...(input.homeDir === undefined ? {} : {homeDir: input.homeDir}),
  });

  if (removed) {
    input.writeStdout(`Removed saved token from ${authConfigDisplayPath()}\n`);
  } else {
    input.writeStdout(
      `Not logged in; no saved token at ${authConfigDisplayPath()}\n`,
    );
  }

  if ((env.DYNOBOX_TOKEN ?? '').trim().length > 0) {
    input.writeStdout(
      'Note: DYNOBOX_TOKEN is still set in your environment and will be used for authenticated commands.\n',
    );
  }
}
