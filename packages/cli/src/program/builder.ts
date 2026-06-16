/**
 * Build the Commander `Command` instance used by the CLI.
 *
 * Pure wiring: option definitions, the `run` subcommand, and the writer
 * configuration. The action body lives in `runCommand.ts` so this file
 * stays scannable.
 */

import {HARNESS_IDS, PERMISSION_MODES} from '@dynobox/sdk';
import {Command} from 'commander';

import {readPackageVersion} from '../util/version.js';
import {
  discoverCommandAction,
  type DiscoverCommandFlags,
} from './discoverCommand.js';
import {DYNO_FILE_SUFFIXES} from './discoverDynos.js';
import type {ExecuteCliOptions, OutputWriter} from './execute.js';
import {initCommandAction, type InitCommandFlags} from './initCommand.js';
import {loginCommandAction} from './loginCommand.js';
import {logoutCommandAction} from './logoutCommand.js';
import {collectOption} from './options.js';
import {runCommandAction, type RunCommandFlags} from './runCommand.js';
import {
  validateCommandAction,
  type ValidateCommandFlags,
} from './validateCommand.js';
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
      `select harnesses for this run; repeat for multiple harnesses (values: ${HARNESS_IDS.join(', ')})`,
      collectOption,
      [] as string[],
    )
    .option(
      '--model <name>',
      'override selected harness models positionally; repeat or comma-separate',
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
    .option('--config <path>', 'path to dyno.config.json')
    .option('--save-run', 'upload a compact run summary after execution')
    .option(
      '--permission-mode <mode>',
      `override harness permission mode (values: ${PERMISSION_MODES.join(', ')})`,
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
    .command('validate')
    .argument(
      '[path]',
      'file or directory to validate; defaults to the current directory',
    )
    .description(
      `validate discovered *.dyno.{${DYNO_FILE_SUFFIXES}} files (or an explicit file path) without running harnesses`,
    )
    .option('--reporter <fmt>', 'output reporter format: text or json', 'text')
    .option('--config <path>', 'path to dyno.config.json')
    .action(
      async (
        configPath: string | undefined,
        commandFlags: ValidateCommandFlags,
      ) => {
        await validateCommandAction({
          configPath,
          commandFlags,
          options,
          writeStdout,
          writeStderr,
        });
      },
    );

  program
    .command('discover')
    .argument(
      '[path]',
      'file or directory to discover; defaults to the current directory',
    )
    .description(
      `print discovered *.dyno.{${DYNO_FILE_SUFFIXES}} files (or an explicit file path) without running harnesses`,
    )
    .option('--config <path>', 'path to dyno.config.json')
    .action(
      async (
        configPath: string | undefined,
        commandFlags: DiscoverCommandFlags,
      ) => {
        await discoverCommandAction({
          configPath,
          commandFlags,
          writeStdout,
          writeStderr,
        });
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
    .command('logout')
    .description('remove the saved Dynobox CLI token')
    .action(() => {
      logoutCommandAction({
        writeStdout,
        ...(options.env === undefined ? {} : {env: options.env}),
      });
    });

  program
    .command('init')
    .description(
      'scaffold a starter *.dyno.mjs (or .dyno.yaml) under ./dynobox/',
    )
    .option('--yaml', 'generate a YAML dyno instead of an MJS dyno')
    .option(
      '--harness <id>',
      `starter harness id (values: ${HARNESS_IDS.join(', ')})`,
      'claude-code',
    )
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
