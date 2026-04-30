import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

import {
  ClaudeCodeHarness,
  type Harness,
  type LocalRunnerJob,
  type LocalRunnerResult,
  runJob,
  type RunJobOptions,
} from '@dynobox/runner-local';
import {
  compile,
  type Ir,
  type IrAssertion,
  resolveConfigModule,
  type ShellToolMatcher,
} from '@dynobox/sdk';
import {Command, CommanderError} from 'commander';
import {tsImport} from 'tsx/esm/api';

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const PURPLE = '\x1b[38;5;141m';
const DIM = '\x1b[2m';

export const placeholderExitCode = 1;
export const configErrorExitCode = 1;
export const runFailureExitCode = 1;

export type CliResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type ExecuteCliOptions = {
  harnesses?: readonly Harness[];
  scratchRoot?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
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

export function renderRunHeader(configPath: string, jobCount: number): string {
  return `dynobox run

config: ${configPath}
jobs: ${jobCount}

`;
}

export function renderRunJobLine(
  index: number,
  total: number,
  job: LocalRunnerJob,
  result: LocalRunnerResult,
): string {
  return `[${index}/${total}] ${job.scenario.name} ${job.scenario.harness} iter ${job.iteration + 1} ${result.passed ? 'PASS' : 'FAIL'}\n`;
}

export function renderAssertionResults(
  jobs: readonly LocalRunnerJob[],
  results: readonly LocalRunnerResult[],
): string {
  const assertionById = new Map(
    jobs.flatMap((job) =>
      job.scenario.assertions.map((assertion) => [assertion.id, assertion]),
    ),
  );
  const assertionResults = results.flatMap((result) => result.assertionResults);

  if (assertionResults.length === 0) {
    return `
Assertions:
(none)
`;
  }

  const lines = assertionResults.map((result) => {
    const assertion = assertionById.get(result.assertionId);
    const label =
      assertion === undefined
        ? result.assertionId
        : describeAssertion(assertion);
    return `${result.passed ? 'PASS' : 'FAIL'} ${label}`;
  });

  return `
Assertions:
${lines.join('\n')}
`;
}

export function renderRunDiagnostics(
  results: readonly LocalRunnerResult[],
): string {
  const lines = results.flatMap((result) =>
    result.diagnostics.map((diagnostic) => `${result.jobId}: ${diagnostic}`),
  );

  if (lines.length === 0) return '';

  return `Diagnostics:
${lines.join('\n')}
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
export async function executeCli(
  args: string[],
  options: ExecuteCliOptions = {},
): Promise<CliResult> {
  if (args.length === 0) {
    return {
      exitCode: placeholderExitCode,
      stdout: '',
      stderr: renderPlaceholderMessage(),
    };
  }

  let stdout = '';
  let stderr = '';
  let exitCode = 0;
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
      let ir: Ir;
      try {
        const moduleExport = await loadConfigModule(configPath);
        const config = resolveConfigModule(normalizeLoadedModule(moduleExport));
        ir = compile(config);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        stderr += renderRunConfigErrorMessage(configPath, message);
        throw new CommanderError(
          configErrorExitCode,
          'dynobox.config',
          message,
        );
      }

      const jobs = buildLocalRunnerJobs(ir);
      const runOptions = buildRunJobOptions(options);
      const results: LocalRunnerResult[] = [];

      stdout += renderRunHeader(configPath, jobs.length);
      for (const [index, job] of jobs.entries()) {
        const result = await runJob(job, runOptions);
        results.push(result);
        stdout += renderRunJobLine(index + 1, jobs.length, job, result);
      }

      stdout += renderAssertionResults(jobs, results);
      stderr += renderRunDiagnostics(results);

      if (results.some((result) => !result.passed)) {
        exitCode = runFailureExitCode;
      }
    });

  try {
    await program.parseAsync(args, {from: 'user'});
    return {exitCode, stdout, stderr};
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
export async function runCli(
  args = process.argv.slice(2),
  options: ExecuteCliOptions = {},
): Promise<number> {
  const result = await executeCli(args, options);
  if (result.stdout.length > 0) process.stdout.write(result.stdout);
  if (result.stderr.length > 0) process.stderr.write(result.stderr);
  return result.exitCode;
}

export function buildLocalRunnerJobs(ir: Ir): LocalRunnerJob[] {
  return ir.scenarios.map((scenario) => ({
    id: `${scenario.id}.iteration.0`,
    scenario,
    iteration: 0,
  }));
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

function buildRunJobOptions(options: ExecuteCliOptions): RunJobOptions {
  const runOptions: RunJobOptions = {
    harnesses: options.harnesses ?? [new ClaudeCodeHarness()],
  };

  if (options.scratchRoot !== undefined)
    runOptions.scratchRoot = options.scratchRoot;
  if (options.env !== undefined) runOptions.env = options.env;
  if (options.timeoutMs !== undefined) runOptions.timeoutMs = options.timeoutMs;

  return runOptions;
}

function describeAssertion(assertion: IrAssertion): string {
  if (assertion.kind === 'tool.called') {
    if (assertion.matcher === undefined) {
      return `tool.called(${assertion.toolKind})`;
    }

    return `tool.called(${assertion.toolKind}, ${describeShellMatcher(assertion.matcher)})`;
  }

  if (assertion.kind === 'http.called') {
    if (assertion.status === undefined) {
      return `http.called(${assertion.endpointId})`;
    }

    return `http.called(${assertion.endpointId}, status: ${assertion.status})`;
  }

  return `http.notCalled(${assertion.endpointId})`;
}

function describeShellMatcher(matcher: ShellToolMatcher): string {
  if ('equals' in matcher) return `equals: ${matcher.equals}`;
  if ('includes' in matcher) return `includes: ${matcher.includes}`;
  if ('startsWith' in matcher) return `startsWith: ${matcher.startsWith}`;
  return `matches: ${matcher.matches}`;
}
