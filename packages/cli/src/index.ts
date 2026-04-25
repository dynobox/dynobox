import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

import {compile, resolveConfigModule} from '@dynobox/sdk';
import {Command, CommanderError} from 'commander';
import {tsImport} from 'tsx/esm/api';

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const PURPLE = '\x1b[38;5;141m';
const DIM = '\x1b[2m';

export const placeholderExitCode = 1;
export const configErrorExitCode = 1;

export type CliResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

/**
 * Renders the current placeholder CLI message with ANSI styling.
 *
 * @returns The formatted message written by the placeholder CLI.
 */
export function renderPlaceholderMessage(): string {
  return `
  ${BOLD}${PURPLE}dynobox${RESET}

  Cross-harness testing for multi-step agent flows.

  ${DIM}This package is a placeholder. Dynobox is under active development.${RESET}

  Follow along:  ${PURPLE}https://dynobox.dev${RESET}
  GitHub:        ${PURPLE}https://github.com/dynobox/dynobox${RESET}
`;
}

/**
 * Renders the compiled `dynobox run` preview before runner execution exists.
 *
 * @param configPath The explicit config path supplied by the user.
 * @param preview The summary of the compiled IR.
 * @returns The formatted message for the compile-preview run command.
 */
export function renderRunPreviewMessage(
  configPath: string,
  preview: {scenarios: number; assertions: number; harnesses: number},
): string {
  return `dynobox run

config: ${configPath}
scenarios: ${preview.scenarios}
harnesses: ${preview.harnesses}
assertions: ${preview.assertions}
`;
}

/**
 * Renders a concise config load/compile error for `dynobox run`.
 *
 * @param configPath The explicit config path supplied by the user.
 * @param message The error message to display.
 * @returns The formatted error message.
 */
export function renderRunConfigErrorMessage(
  configPath: string,
  message: string,
): string {
  return `dynobox run

config: ${configPath}
error: ${message}
`;
}

/**
 * Executes CLI command routing without touching process streams.
 *
 * @param args The CLI arguments after the executable name.
 * @returns Captured stdout, stderr, and exit code.
 */
export async function executeCli(args: string[]): Promise<CliResult> {
  if (args.length === 0) {
    return {
      exitCode: placeholderExitCode,
      stdout: '',
      stderr: renderPlaceholderMessage(),
    };
  }

  let stdout = '';
  let stderr = '';
  const program = new Command();

  program
    .name('dynobox')
    .exitOverride()
    .configureOutput({
      writeOut: (value) => {
        stdout += value;
      },
      writeErr: (value) => {
        stderr += value;
      },
    })
    .showHelpAfterError();

  program
    .command('run')
    .argument('<config>', 'path to dynobox config')
    .description('run a dynobox config')
    .action(async (configPath: string) => {
      try {
        const moduleExport = await loadConfigModule(configPath);
        const config = resolveConfigModule(normalizeLoadedModule(moduleExport));
        const ir = compile(config);
        const assertionCount = ir.scenarios.reduce(
          (count, scenario) => count + scenario.assertions.length,
          0,
        );
        const harnessCount = new Set(
          ir.scenarios.map((scenario) => scenario.harness),
        ).size;

        stdout += renderRunPreviewMessage(configPath, {
          scenarios: ir.scenarios.length,
          assertions: assertionCount,
          harnesses: harnessCount,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        stderr += renderRunConfigErrorMessage(configPath, message);
        throw new CommanderError(
          configErrorExitCode,
          'dynobox.config',
          message,
        );
      }
    });

  try {
    await program.parseAsync(args, {from: 'user'});
    return {exitCode: 0, stdout, stderr};
  } catch (error) {
    if (error instanceof CommanderError) {
      return {
        exitCode: error.exitCode,
        stdout,
        stderr,
      };
    }
    throw error;
  }
}

/**
 * Executes CLI behavior and writes captured output to process streams.
 *
 * @param args The CLI arguments after the executable name.
 * @returns The exit code for the CLI process.
 */
export async function runCli(args = process.argv.slice(2)): Promise<number> {
  const result = await executeCli(args);
  if (result.stdout.length > 0) process.stdout.write(result.stdout);
  if (result.stderr.length > 0) process.stderr.write(result.stderr);
  return result.exitCode;
}

async function loadConfigModule(configPath: string): Promise<unknown> {
  const configUrl = pathToFileURL(resolve(configPath)).href;
  return tsImport(configUrl, import.meta.url);
}

function normalizeLoadedModule(moduleExport: unknown): unknown {
  if (
    isRecord(moduleExport) &&
    isRecord(moduleExport.default) &&
    'default' in moduleExport.default
  ) {
    return moduleExport.default;
  }
  return moduleExport;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
