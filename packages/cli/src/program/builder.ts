/**
 * Build the Commander `Command` instance used by the CLI.
 *
 * Pure wiring: option definitions, the `run` subcommand, and the writer
 * configuration. The action body lives in `runCommand.ts` so this file
 * stays scannable.
 */

import {Command} from 'commander';

import {readPackageVersion} from '../util/version.js';
import {DYNO_FILE_SUFFIXES} from './discoverDynos.js';
import type {ExecuteCliOptions, OutputWriter} from './execute.js';
import {initCommandAction, type InitCommandFlags} from './initCommand.js';
import {loginCommandAction} from './loginCommand.js';
import {collectOption} from './options.js';
import {runCommandAction, type RunCommandFlags} from './runCommand.js';
import {whoamiCommandAction} from './whoamiCommand.js';

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
    .version(readPackageVersion(), '-V, --version')
    .exitOverride()
    .configureOutput({
      writeOut: (value) => writeStdout(value),
      writeErr: (value) => writeStderr(value),
    })
    .showHelpAfterError();

  program
    .command('run')
    .argument(
      '[path]',
      'file or directory to run; defaults to the current directory',
    )
    .description(
      `run discovered *.dyno.{${DYNO_FILE_SUFFIXES}} files (or an explicit file path)`,
    )
    .option(
      '--harness <id>',
      'override config harnesses for this run; repeat for multiple harnesses',
      collectOption,
      [] as string[],
    )
    .option(
      '--scenario <pattern>',
      'run only scenarios whose name or id matches; repeat for multiple patterns',
      collectOption,
      [] as string[],
    )
    .option('--iterations <count>', 'run each scenario/harness pair N times')
    .option('--quiet', 'print compact CI-friendly output')
    .option('--verbose', 'expand scenario details even when passing')
    .option('--debug', 'include debug paths and artifacts')
    .option('--reporter <fmt>', 'output reporter format: text or json', 'text')
    .option(
      '--permission-mode <mode>',
      'override harness permission mode: default or dangerous',
    )
    .action(
      async (configPath: string | undefined, commandFlags: RunCommandFlags) => {
        const failed = await runCommandAction({
          configPath,
          commandFlags,
          options,
          writeStdout,
          writeStderr,
        });
        if (failed) onRunFailure();
      },
    );

  program
    .command('login')
    .description('save a Dynobox CLI token for authenticated runs')
    .action(async () => {
      await loginCommandAction({
        writeStdout,
        writeStderr,
        ...(options.env === undefined ? {} : {env: options.env}),
        ...(options.readStdin === undefined
          ? {}
          : {readStdin: options.readStdin}),
      });
    });

  program
    .command('whoami')
    .description('show the authenticated Dynobox CLI identity')
    .action(async () => {
      await whoamiCommandAction({
        writeStdout,
        writeStderr,
        ...(options.env === undefined ? {} : {env: options.env}),
      });
    });

  program
    .command('init')
    .description(
      'scaffold a starter *.dyno.mjs (or .dyno.yaml) under ./dynobox/',
    )
    .option('--yaml', 'generate a YAML dyno instead of an MJS dyno')
    .option('--harness <id>', 'starter harness id', 'claude-code')
    .option('--force', 'overwrite an existing starter file')
    .action(async (commandFlags: InitCommandFlags) => {
      await initCommandAction({
        commandFlags,
        writeStdout,
        writeStderr,
      });
    });

  return program;
}
