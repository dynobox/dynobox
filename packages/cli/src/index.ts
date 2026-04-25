import {Command, CommanderError} from 'commander';

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const PURPLE = '\x1b[38;5;141m';
const DIM = '\x1b[2m';

export const placeholderExitCode = 1;
export const runScaffoldExitCode = 1;

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
 * Renders the scaffolded `dynobox run` message before config loading exists.
 *
 * @param configPath The explicit config path supplied by the user.
 * @returns The formatted message for the scaffolded run command.
 */
export function renderRunScaffoldMessage(configPath: string): string {
  return `dynobox run

config: ${configPath}

Config loading is not implemented yet.
`;
}

/**
 * Executes CLI command routing without touching process streams.
 *
 * @param args The CLI arguments after the executable name.
 * @returns Captured stdout, stderr, and exit code.
 */
export function executeCli(args: string[]): CliResult {
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
    .action((configPath: string) => {
      stderr += renderRunScaffoldMessage(configPath);
      throw new CommanderError(
        runScaffoldExitCode,
        'dynobox.scaffold',
        'Config loading is not implemented yet.',
      );
    });

  try {
    program.parse(args, {from: 'user'});
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
 * @returns The exit code for the placeholder CLI process.
 */
export function runCli(args = process.argv.slice(2)): number {
  const result = executeCli(args);
  if (result.stdout.length > 0) process.stdout.write(result.stdout);
  if (result.stderr.length > 0) process.stderr.write(result.stderr);
  return result.exitCode;
}
