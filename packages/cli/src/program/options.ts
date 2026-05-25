/**
 * Option parsing helpers for the `run` subcommand: collecting repeated flags,
 * validating ids against the SDK's allowlist, and translating
 * `ExecuteCliOptions` into the local runner's `RunJobOptions`.
 */

import {
  ClaudeCodeHarness,
  CodexHarness,
  type RunJobOptions,
} from '@dynobox/runner-local';
import {
  HARNESS_IDS,
  type HarnessId,
  PERMISSION_MODES,
  type PermissionMode,
} from '@dynobox/sdk';
import {CommanderError} from 'commander';

import {unique} from '../util/unique.js';
import type {ExecuteCliOptions} from './execute.js';
import {configErrorExitCode} from './exitCodes.js';

export type ReporterFormat = 'text' | 'json';

/** Collect repeated/comma-separated option values into a flat list. */
export function collectOption(value: string, previous: string[]): string[] {
  return [...previous, value];
}

/**
 * Parse a list of raw `--harness` values into validated `HarnessId`s, or
 * `undefined` if no overrides were supplied.
 *
 * Throws `CommanderError(configErrorExitCode)` for unknown ids so the
 * top-level executor can map it to the documented exit code.
 */
export function validateHarnessOverrides(
  values: readonly string[] | undefined,
): HarnessId[] | undefined {
  const harnesses = values?.flatMap((value) =>
    value
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.length > 0),
  );
  if (harnesses === undefined || harnesses.length === 0) return undefined;

  const validHarnesses = new Set<string>(HARNESS_IDS);
  const invalid = harnesses.find((harness) => !validHarnesses.has(harness));
  if (invalid !== undefined) {
    throw new CommanderError(
      configErrorExitCode,
      'dynobox.harness',
      `Invalid harness "${invalid}". Expected one of: ${HARNESS_IDS.join(', ')}`,
    );
  }

  return unique(harnesses) as HarnessId[];
}

export function validatePermissionModeOverride(
  value: string | undefined,
): PermissionMode | undefined {
  if (value === undefined) return undefined;
  const validModes = new Set<string>(PERMISSION_MODES);
  if (!validModes.has(value)) {
    throw new CommanderError(
      configErrorExitCode,
      'dynobox.permissionMode',
      `Invalid permission mode "${value}". Expected one of: ${PERMISSION_MODES.join(', ')}`,
    );
  }
  return value as PermissionMode;
}

export function validateReporterFormat(
  value: string | undefined,
): ReporterFormat {
  if (value === undefined) return 'text';
  if (value === 'text' || value === 'json') return value;
  throw new CommanderError(
    configErrorExitCode,
    'dynobox.reporter',
    `Invalid reporter "${value}". Expected one of: text, json`,
  );
}

export function validateIterations(value: string | undefined): number {
  if (value === undefined) return 1;
  const iterations = Number(value);
  if (!Number.isInteger(iterations) || iterations < 1) {
    throw new CommanderError(
      configErrorExitCode,
      'dynobox.iterations',
      `Invalid iterations "${value}". Expected a positive integer.`,
    );
  }
  return iterations;
}

export function validateScenarioFilters(
  values: readonly string[] | undefined,
): string[] | undefined {
  const patterns = values?.flatMap((value) =>
    value
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.length > 0),
  );
  if (patterns === undefined || patterns.length === 0) return undefined;
  return unique(patterns);
}

/**
 * Translate the options passed to `executeCli` into the shape expected by
 * `runJob`. Defaults the harness list to the two real harnesses; tests
 * override with `FakeHarness`.
 */
export function buildRunJobOptions(options: ExecuteCliOptions): RunJobOptions {
  const runOptions: RunJobOptions = {
    harnesses: options.harnesses ?? [
      new ClaudeCodeHarness(),
      new CodexHarness(),
    ],
  };

  if (options.scratchRoot !== undefined)
    runOptions.scratchRoot = options.scratchRoot;
  if (options.env !== undefined) runOptions.env = options.env;
  if (options.timeoutMs !== undefined) runOptions.timeoutMs = options.timeoutMs;

  return runOptions;
}
