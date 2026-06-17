/** Action handler for `dynobox discover [path]`. */

import {resolve} from 'node:path';

import {CommanderError} from 'commander';

import {displayPath} from '../util/displayPath.js';
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
  verbose?: boolean;
  debug?: boolean;
};

export async function discoverCommandAction(
  input: DiscoverCommandActionInput,
): Promise<void> {
  const {configPath, commandFlags, writeStdout, writeStderr} = input;
  const inputLabel = configPath ?? '.';
  const resolvedInputPath = resolve(inputLabel);

  try {
    const result = await discoverDynos(configPath, {
      ...(commandFlags.config === undefined
        ? {}
        : {configPath: commandFlags.config}),
    });
    writeStdout(
      renderDiscoverOutput(
        result.files,
        resolvedInputPath,
        result.configPath,
        commandFlags,
      ),
    );
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

function renderDiscoverOutput(
  filePaths: readonly string[],
  searchPath: string,
  configPath: string | undefined,
  flags: DiscoverCommandFlags,
): string {
  const lines = filePaths.map((filePath) => displayPath(filePath));
  if (flags.verbose || flags.debug) {
    lines.unshift(`config: ${configPath ?? 'none'}`);
    lines.unshift(`path: ${searchPath}`);
  }
  if (lines.length === 0) return '';
  return lines.join('\n') + '\n';
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
