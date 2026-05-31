/**
 * CLI execution helpers: `executeCli` is testable and returns captured
 * stdout/stderr + exit code; `runCli` is process-coupled and writes directly
 * to `process.stdout`/`process.stderr`.
 *
 * Tests use `executeCli`; `bin.ts` uses `runCli`.
 */

import type {Harness} from '@dynobox/runner-local';
import {CommanderError} from 'commander';

import {renderPlaceholderMessage} from '../render/index.js';
import type {RunOutputMode} from '../terminal/index.js';
import {buildProgram} from './builder.js';
import {shouldUseLiveTerminalOutput} from './environment.js';
import {placeholderExitCode, runFailureExitCode} from './exitCodes.js';

export type OutputWriter = (value: string) => void;

export type CliResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type ExecuteCliOptions = {
  harnesses?: readonly Harness[];
  scratchRoot?: string;
  env?: Record<string, string>;
  readStdin?: () => Promise<string>;
  timeoutMs?: number;
  writeStdout?: OutputWriter;
  writeStderr?: OutputWriter;
  mode?: RunOutputMode;
  color?: boolean;
  usePlainSymbols?: boolean;
  terminalWidth?: number;
  live?: boolean;
};

/**
 * Testable execution path. Captures all stdout/stderr the CLI would emit
 * (including any user-supplied writers) and returns it alongside the exit
 * code. Suitable for testing without spawning a subprocess.
 */
export async function executeCli(
  args: string[],
  options: ExecuteCliOptions = {},
): Promise<CliResult> {
  let stdout = '';
  let stderr = '';
  const writeStdout: OutputWriter = (value) => {
    stdout += value;
    options.writeStdout?.(value);
  };
  const writeStderr: OutputWriter = (value) => {
    stderr += value;
    options.writeStderr?.(value);
  };

  if (args.length === 0) {
    writeStderr(renderPlaceholderMessage());
    return {exitCode: placeholderExitCode, stdout, stderr};
  }

  let runFailed = false;
  const program = buildProgram({
    options,
    writeStdout,
    writeStderr,
    onRunFailure: () => {
      runFailed = true;
    },
  });

  try {
    await program.parseAsync(args, {from: 'user'});
    return {
      exitCode: runFailed ? runFailureExitCode : 0,
      stdout,
      stderr,
    };
  } catch (error) {
    if (error instanceof CommanderError) {
      return {exitCode: error.exitCode, stdout, stderr};
    }
    throw error;
  }
}

/**
 * Process entry point. Wires `process.stdout`/`process.stderr` writers and
 * resolves color/live/plain-symbols defaults from the host terminal.
 */
export async function runCli(
  args = process.argv.slice(2),
  options: ExecuteCliOptions = {},
): Promise<number> {
  const liveOutput = shouldUseLiveTerminalOutput();
  const result = await executeCli(args, {
    ...options,
    color: options.color ?? liveOutput,
    usePlainSymbols: options.usePlainSymbols ?? !liveOutput,
    live: options.live ?? liveOutput,
    writeStdout:
      options.writeStdout ?? ((value) => void process.stdout.write(value)),
    writeStderr:
      options.writeStderr ?? ((value) => void process.stderr.write(value)),
  });
  return result.exitCode;
}

// Re-export exit codes here for internal tests and command wiring.
export {
  configErrorExitCode,
  placeholderExitCode,
  runFailureExitCode,
} from './exitCodes.js';
