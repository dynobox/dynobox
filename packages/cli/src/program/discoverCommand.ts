/** Action handler for `dynobox discover [path]`. */

import {relative, resolve} from 'node:path';

import {CommanderError} from 'commander';

import {discoverDynos, DynoPathNotFoundError} from './discoverDynos.js';
import type {OutputWriter} from './execute.js';
import {configErrorExitCode} from './exitCodes.js';

export type DiscoverCommandActionInput = {
  /** Optional file/directory; falls back to the current working directory. */
  configPath: string | undefined;
  commandFlags: DiscoverCommandFlags;
  writeStdout: OutputWriter;
  writeStderr: OutputWriter;
};

export type DiscoverCommandFlags = {
  config?: string;
};

export async function discoverCommandAction(
  input: DiscoverCommandActionInput,
): Promise<void> {
  const {configPath, commandFlags, writeStdout, writeStderr} = input;
  const inputLabel = configPath ?? '.';
  const resolvedInputPath = resolve(inputLabel);

  try {
    const filePaths = await discoverDynos(configPath, {
      ...(commandFlags.config === undefined
        ? {}
        : {configPath: commandFlags.config}),
    });
    writeStdout(renderDiscoverOutput(filePaths));
  } catch (error) {
    const label = configPath ?? resolvedInputPath;
    writeStderr(renderDiscoverError(label, discoveryErrorMessage(error)));
    throw new CommanderError(
      configErrorExitCode,
      'dynobox.config',
      'discovery failed',
    );
  }
}

function renderDiscoverOutput(filePaths: readonly string[]): string {
  if (filePaths.length === 0) return '';
  return filePaths.map((filePath) => displayPath(filePath)).join('\n') + '\n';
}

function displayPath(filePath: string): string {
  const rel = relative(process.cwd(), filePath);
  return rel === '' || rel.startsWith('..') ? filePath : rel;
}

function renderDiscoverError(configPath: string, message: string): string {
  return `dynobox discover

config: ${configPath}
error: ${message}
`;
}

function discoveryErrorMessage(error: unknown): string {
  if (error instanceof DynoPathNotFoundError) {
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}
