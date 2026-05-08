/**
 * Render context: the small, immutable bag of presentation flags every
 * rendering function takes. Built once per CLI invocation in
 * `program/runCommand.ts`.
 */

import {DEFAULT_WIDTH} from './layout.js';

export type RunOutputMode = 'default' | 'quiet' | 'verbose' | 'debug';

export type RenderContext = {
  mode: RunOutputMode;
  color: boolean;
  usePlainSymbols: boolean;
  width: number;
};

type ContextOptions = {
  mode?: RunOutputMode;
  color?: boolean;
  usePlainSymbols?: boolean;
  terminalWidth?: number;
};

type CommandFlags = {
  quiet?: boolean;
  verbose?: boolean;
  debug?: boolean;
};

export function createRenderContext(
  options: ContextOptions = {},
  commandOptions: CommandFlags = {},
): RenderContext {
  return {
    mode: selectMode(options, commandOptions),
    color: options.color ?? false,
    usePlainSymbols: options.usePlainSymbols ?? false,
    width: options.terminalWidth ?? DEFAULT_WIDTH,
  };
}

function selectMode(
  options: ContextOptions,
  commandOptions: CommandFlags,
): RunOutputMode {
  if (options.mode !== undefined) return options.mode;
  if (commandOptions.quiet === true) return 'quiet';
  if (commandOptions.debug === true) return 'debug';
  if (commandOptions.verbose === true) return 'verbose';
  return 'default';
}
