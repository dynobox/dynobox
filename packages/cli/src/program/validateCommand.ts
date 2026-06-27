/** Action handler for `dynobox validate [path]`. */

import {resolve} from 'node:path';

import {CommanderError} from 'commander';

import {
  renderConfigErrorMessage,
  renderJsonValidateOutput,
} from '../render/index.js';
import {
  colorStatus,
  createRenderContext,
  type RenderContext,
  symbol,
} from '../terminal/index.js';
import {displayPath} from '../util/displayPath.js';
import {reportConfigError} from '../util/reportConfigError.js';
import {compileDynos, type CompileDynosResult} from './compileDynos.js';
import {discoverDynos, DynoPathNotFoundError} from './discoverDynos.js';
import type {ExecuteCliOptions, OutputWriter} from './execute.js';
import {configErrorExitCode} from './exitCodes.js';
import {validateReporterFormat} from './options.js';

export type ValidateCommandFlags = {
  reporter?: string;
  config?: string;
  verbose?: boolean;
  debug?: boolean;
};

export type ValidateCommandActionInput = {
  /** Optional file/directory; falls back to the current working directory. */
  configPath: string | undefined;
  commandFlags: ValidateCommandFlags;
  options?: Pick<
    ExecuteCliOptions,
    'color' | 'mode' | 'terminalWidth' | 'usePlainSymbols'
  >;
  writeStdout: OutputWriter;
  writeStderr: OutputWriter;
};

export async function validateCommandAction(
  input: ValidateCommandActionInput,
): Promise<void> {
  const {configPath, commandFlags, options, writeStdout, writeStderr} = input;
  const inputLabel = configPath ?? '.';
  const resolvedInputPath = resolve(inputLabel);
  const reporter = validateReporter(
    commandFlags.reporter,
    inputLabel,
    writeStderr,
  );

  const {files: filePaths, configPath: appliedConfigPath} =
    await discoverForValidate({
      configPath,
      resolvedInputPath,
      ...(commandFlags.config === undefined
        ? {}
        : {configFilePath: commandFlags.config}),
      reporter,
      writeStdout,
      writeStderr,
    });
  const result = await compileDynos(filePaths);

  if (reporter === 'json') {
    writeStdout(renderJsonValidateOutput(result, filePaths));
  } else {
    for (const error of result.errors) {
      writeStderr(
        renderConfigErrorMessage('validate', error.filePath, error.message),
      );
    }
    const ctx = createRenderContext(options, commandFlags);
    if (
      appliedConfigPath !== undefined &&
      (ctx.mode === 'verbose' || ctx.mode === 'debug')
    ) {
      writeStdout(
        renderVerboseValidateMetadata(resolvedInputPath, appliedConfigPath),
      );
    } else if (ctx.mode === 'verbose' || ctx.mode === 'debug') {
      writeStdout(renderVerboseValidateMetadata(resolvedInputPath, undefined));
    }
    writeStdout(renderTextValidateOutput(result, filePaths, ctx));
  }

  if (result.errors.length > 0) {
    throw new CommanderError(
      configErrorExitCode,
      'dynobox.config',
      'validation failed',
    );
  }
}

type DiscoverForValidateInput = {
  configPath: string | undefined;
  resolvedInputPath: string;
  configFilePath?: string;
  reporter: ReturnType<typeof validateReporterFormat>;
  writeStdout: OutputWriter;
  writeStderr: OutputWriter;
};

async function discoverForValidate(
  input: DiscoverForValidateInput,
): Promise<{files: readonly string[]; configPath?: string}> {
  const {configPath, resolvedInputPath, reporter, writeStdout, writeStderr} =
    input;
  try {
    const result = await discoverDynos(configPath, {
      ...(input.configFilePath === undefined
        ? {}
        : {configPath: input.configFilePath}),
    });
    return result;
  } catch (error) {
    const label = configPath ?? resolvedInputPath;
    const message = discoveryErrorMessage(error);
    if (reporter === 'json') {
      writeStdout(
        renderJsonValidateOutput(
          {compiled: [], errors: [{filePath: label, message}]},
          [label],
        ),
      );
    } else {
      writeStderr(renderConfigErrorMessage('validate', label, message));
    }
    throw new CommanderError(
      configErrorExitCode,
      'dynobox.config',
      'discovery failed',
    );
  }
}

function renderVerboseValidateMetadata(
  searchPath: string,
  configPath: string | undefined,
): string {
  return `path: ${searchPath}\nconfig: ${configPath ?? 'none'}\n`;
}

function validateReporter(
  rawReporter: string | undefined,
  inputLabel: string,
  writeStderr: OutputWriter,
) {
  return reportConfigError(
    inputLabel,
    writeStderr,
    (label, message) => renderConfigErrorMessage('validate', label, message),
    () => validateReporterFormat(rawReporter),
  );
}

function discoveryErrorMessage(error: unknown): string {
  if (error instanceof DynoPathNotFoundError) {
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

function renderTextValidateOutput(
  result: CompileDynosResult,
  filePaths: readonly string[],
  ctx: RenderContext,
): string {
  const valid = result.compiled.length;
  const invalid = result.errors.length;
  const summary =
    invalid === 0
      ? `Validated ${valid} dyno file(s).\n`
      : `Validated ${valid} dyno file(s); ${invalid} failed.\n`;
  if (filePaths.length === 0) return summary;

  const compiledByPath = new Map(
    result.compiled.map((entry) => [entry.filePath, entry]),
  );
  const rows = filePaths.map((filePath) => {
    const compiled = compiledByPath.get(filePath);
    const status = compiled === undefined ? 'fail' : 'pass';
    const detail =
      compiled === undefined
        ? 'invalid'
        : `${compiled.ir.scenarios.length} scenario(s)`;
    const icon = colorStatus(ctx, symbol(ctx, status), status);
    return `  ${icon}  ${displayPath(filePath)}   ${detail}\n`;
  });

  return `${rows.join('')}\n${summary}`;
}
