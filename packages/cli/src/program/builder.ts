/**
 * Build the Commander `Command` instance used by the CLI.
 *
 * Pure wiring: option definitions, the `run` subcommand, and the writer
 * configuration. The action body lives in `runCommand.ts` so this file
 * stays scannable.
 */

import {Command} from 'commander';

import type {ExecuteCliOptions, OutputWriter} from './execute.js';
import {collectOption} from './options.js';
import {runCommandAction, type RunCommandFlags} from './runCommand.js';

export type BuildProgramInput = {
  options: ExecuteCliOptions;
  writeStdout: OutputWriter;
  writeStderr: OutputWriter;
  /**
   * Called after a successful `run` if any job failed. Lets the caller set
   * the run-failure exit code without sharing mutable state with the
   * Commander action.
   */
  onRunFailure: () => void;
};

export function buildProgram(input: BuildProgramInput): Command {
  const {options, writeStdout, writeStderr, onRunFailure} = input;

  const program = new Command();
  program
    .name('dynobox')
    .exitOverride()
    .configureOutput({
      writeOut: (value) => writeStdout(value),
      writeErr: (value) => writeStderr(value),
    })
    .showHelpAfterError();

  program
    .command('run')
    .argument('<config>', 'path to dynobox config')
    .description('run a dynobox config')
    .option(
      '--harness <id>',
      'override config harnesses for this run; repeat for multiple harnesses',
      collectOption,
      [] as string[],
    )
    .option('--quiet', 'print compact CI-friendly output')
    .option('--verbose', 'expand scenario details even when passing')
    .option('--debug', 'include debug paths and artifacts')
    .action(async (configPath: string, commandFlags: RunCommandFlags) => {
      const failed = await runCommandAction({
        configPath,
        commandFlags,
        options,
        writeStdout,
        writeStderr,
      });
      if (failed) onRunFailure();
    });

  return program;
}
