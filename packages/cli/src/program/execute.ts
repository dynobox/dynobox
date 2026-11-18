/**
 * CLI execution helpers: `executeCli` is testable and returns captured
 * stdout/stderr + exit code; `runCli` is process-coupled and writes directly
 * to `process.stdout`/`process.stderr`.
 *
 * Tests use `executeCli`; `bin.ts` uses `runCli`.
 */

import type {TelemetryEvent} from '@dynobox/run-schema';
import type {Harness} from '@dynobox/runner-local';
import {CommanderError} from 'commander';

import {renderPlaceholderMessage} from '../render/index.js';
import type {RunOutputMode} from '../terminal/index.js';
import {buildProgram} from './builder.js';
import {shouldUseLiveTerminalOutput} from './environment.js';
import {runFailureExitCode} from './exitCodes.js';
import {
  buildTelemetryBatch,
  type CompletedCommand,
  isTrackedCommand,
  startTelemetrySession,
  telemetryErrorCategory,
  type TelemetrySession,
} from './telemetry.js';

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
  /**
   * Starts a telemetry session for a tracked command. Only `runCli` sets
   * this, so tests and embedded callers send nothing unless they opt in.
   */
  telemetry?: () => TelemetrySession | undefined;
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
    writeStdout(renderPlaceholderMessage());
    return {exitCode: 0, stdout, stderr};
  }

  let runFailed = false;
  const runEvents: TelemetryEvent[] = [];
  const program = buildProgram({
    options,
    writeStdout,
    writeStderr,
    onRunFailure: () => {
      runFailed = true;
    },
    recordTelemetry: (events) => {
      runEvents.push(...events);
    },
  });

  // The session starts once Commander has picked a tracked command, so help,
  // version, and `dynobox telemetry` never show the notice or send anything.
  const startedAt = Date.now();
  let command: string | undefined;
  let session: TelemetrySession | undefined;
  program.hook('preAction', (_program, actionCommand) => {
    if (!isTrackedCommand(actionCommand.name())) return;
    command = actionCommand.name();
    session = options.telemetry?.();
  });
  const finish = async (
    exitCode: number,
    errorCategory: string | null,
  ): Promise<void> => {
    if (session === undefined || command === undefined) return;
    const completed: CompletedCommand = {
      command,
      exitCode,
      durationMs: Date.now() - startedAt,
      errorCategory,
    };
    const batch = buildTelemetryBatch(session, completed, runEvents);
    if (batch !== undefined) await session.deliver(batch);
  };

  try {
    await program.parseAsync(args, {from: 'user'});
  } catch (error) {
    if (error instanceof CommanderError) {
      await finish(error.exitCode, telemetryErrorCategory(error));
      return {exitCode: error.exitCode, stdout, stderr};
    }
    await finish(1, telemetryErrorCategory(error));
    throw error;
  }
  const exitCode = runFailed ? runFailureExitCode : 0;
  await finish(exitCode, null);
  return {exitCode, stdout, stderr};
}

export type RunCliOptions = ExecuteCliOptions & {
  /**
   * Sends usage telemetry for tracked commands. Only `bin.ts` sets it, so
   * tests and other callers never write telemetry state or send data.
   */
  sendTelemetry?: boolean;
};

/**
 * Process entry point. Wires `process.stdout`/`process.stderr` writers and
 * resolves color/live/plain-symbols defaults from the host terminal.
 */
export async function runCli(
  args = process.argv.slice(2),
  options: RunCliOptions = {},
): Promise<number> {
  const liveOutput = shouldUseLiveTerminalOutput();
  const terminalWidth = options.terminalWidth ?? process.stdout.columns;
  const writeStderr =
    options.writeStderr ??
    ((value: string) => void process.stderr.write(value));
  const result = await executeCli(args, {
    ...options,
    color: options.color ?? liveOutput,
    usePlainSymbols: options.usePlainSymbols ?? !liveOutput,
    live: options.live ?? liveOutput,
    ...(terminalWidth === undefined ? {} : {terminalWidth}),
    writeStdout:
      options.writeStdout ?? ((value) => void process.stdout.write(value)),
    writeStderr,
    ...(options.sendTelemetry === true && options.telemetry === undefined
      ? {
          telemetry: () =>
            startTelemetrySession({
              writeStderr,
              color: options.color ?? liveOutput,
              ...(options.env === undefined ? {} : {env: options.env}),
            }),
        }
      : {}),
  });
  return result.exitCode;
}

// Re-export exit codes here for internal tests and command wiring.
export {configErrorExitCode, runFailureExitCode} from './exitCodes.js';
