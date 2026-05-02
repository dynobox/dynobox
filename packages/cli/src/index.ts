import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

import {
  ClaudeCodeHarness,
  type Harness,
  type LocalRunnerJob,
  type LocalRunnerResult,
  runJob,
  type RunJobOptions,
  type RunJobProgressEvent,
  type ToolEvent,
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
const GREEN = '\x1b[38;5;42m';
const RED = '\x1b[38;5;167m';
const YELLOW = '\x1b[38;5;220m';
const DIM = '\x1b[2m';
const ANSI_ESCAPE_PATTERN = new RegExp(
  `${String.fromCharCode(27)}\\[[0-9;]*m`,
  'g',
);
const CLI_VERSION = '0.0.3';
const DEFAULT_WIDTH = 72;
const SPINNER_FRAMES = [
  '⠋',
  '⠙',
  '⠹',
  '⠸',
  '⠼',
  '⠴',
  '⠦',
  '⠧',
  '⠇',
  '⠏',
] as const;
const SPINNER_INTERVAL_MS = 80;

export const placeholderExitCode = 1;
export const configErrorExitCode = 1;
export const runFailureExitCode = 1;

export type CliResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

type OutputWriter = (value: string) => void;
type RunOutputMode = 'default' | 'quiet' | 'verbose' | 'debug';

export type ExecuteCliOptions = {
  harnesses?: readonly Harness[];
  scratchRoot?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  writeStdout?: OutputWriter;
  writeStderr?: OutputWriter;
  mode?: RunOutputMode;
  color?: boolean;
  usePlainSymbols?: boolean;
  terminalWidth?: number;
  live?: boolean;
};

type RunCommandOptions = {
  quiet?: boolean;
  verbose?: boolean;
  debug?: boolean;
};

type RenderContext = {
  mode: RunOutputMode;
  color: boolean;
  usePlainSymbols: boolean;
  width: number;
};

type LiveJobState = {
  setupCommandCount: number;
  toolCount: number;
  assertionCount: number;
  phaseStartedAtMs: number;
};

type LiveRender = (frame: string, nowMs: number) => string;
type LiveLine =
  | {kind: 'update'; render: LiveRender}
  | {kind: 'commit'; text: string};

type LiveWriter = {
  beginJob: (headline: string) => void;
  emit: (line: LiveLine) => void;
  tick: (frame: string) => void;
  rewriteHeadline: (headline: string) => void;
  collapseToHeadline: (headline: string) => void;
  flush: () => void;
};

type Spinner = {
  start: () => void;
  stop: () => void;
};

type RunMatrixCell = {
  scenarioId: string;
  scenarioName: string;
  harness: string;
  iteration: number;
  passed: boolean;
  failedAssertions: string[];
  durationMs: number;
};

export type RunMatrix = {
  scenarios: string[];
  harnesses: string[];
  iterations: number[];
  cells: RunMatrixCell[];
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

export function renderRunHeader(
  configPath: string,
  jobs: readonly LocalRunnerJob[],
  ctx: RenderContext = createRenderContext(),
): string {
  const plan = renderPlan(jobs);
  const jobCount = formatCount(jobs.length, 'job');
  return `  ${style(ctx, 'dynobox', 'brand')}  ${CLI_VERSION}

  config   ${dim(ctx, configPath)}
  ${leftRight(`plan     ${plan}`, jobCount, ctx.width)}

`;
}

export function renderRunOutput(input: {
  configPath: string;
  jobs: readonly LocalRunnerJob[];
  results: readonly LocalRunnerResult[];
  ctx?: RenderContext;
}): string {
  const ctx = input.ctx ?? createRenderContext();
  if (ctx.mode === 'quiet') {
    return renderQuietRun(input.configPath, input.jobs, input.results, ctx);
  }

  const assertionById = assertionByIdForJobs(input.jobs);
  const lines: string[] = [renderRunHeader(input.configPath, input.jobs, ctx)];
  const expandAll = ctx.mode === 'verbose' || ctx.mode === 'debug';

  for (const [index, job] of input.jobs.entries()) {
    const result = input.results[index];
    if (result === undefined) continue;

    const expand = expandAll || !result.passed;
    const status: 'pass' | 'fail' = result.passed ? 'pass' : 'fail';
    const headline = renderHeadline(
      job,
      ctx,
      status,
      expand ? undefined : result.timing.totalMs,
    );
    lines.push(`${headline}\n`);
    if (expand) {
      lines.push(renderJobDetails(job, result, assertionById, ctx));
    }
  }

  lines.push(renderRunSummary(input.jobs, input.results, ctx));

  return lines.join('');
}

export function renderRunSummary(
  jobs: readonly LocalRunnerJob[],
  results: readonly LocalRunnerResult[],
  ctx: RenderContext = createRenderContext(),
): string {
  const assertionById = assertionByIdForJobs(jobs);
  const passedCount = results.filter((result) => result.passed).length;
  const failedCount = results.length - passedCount;
  const totalMs = results.reduce(
    (sum, result) => sum + result.timing.totalMs,
    0,
  );
  const summary = `${colorStatus(ctx, `${passedCount} passed`, passedCount === results.length ? 'pass' : 'plain')}   ${colorStatus(ctx, `${failedCount} failed`, failedCount === 0 ? 'plain' : 'fail')}`;
  const lines = [
    `
  ${separator(ctx)}
  ${leftRight(summary, formatDuration(totalMs), ctx.width)}
`,
  ];

  const failedResults = results.filter((result) => !result.passed);
  if (failedResults.length > 0) {
    lines.push('\n  failed scenarios:\n');
    for (const result of failedResults) {
      const job = jobs.find((candidate) => candidate.id === result.jobId);
      const failedAssertion = result.assertionResults.find(
        (assertionResult) => !assertionResult.passed,
      );
      const assertion =
        failedAssertion === undefined
          ? undefined
          : assertionById.get(failedAssertion.assertionId);
      lines.push(
        `    ${job?.scenario.name ?? result.scenarioId}   ${assertion === undefined ? (failedAssertion?.kind ?? result.status) : describeAssertion(assertion)}\n`,
      );
    }
  }

  return lines.join('');
}

export function renderRunConfigErrorMessage(
  configPath: string,
  message: string,
): string {
  return `dynobox run

config: ${configPath}
error: ${message}
`;
}

export function buildRunMatrix(
  jobs: readonly LocalRunnerJob[],
  results: readonly LocalRunnerResult[],
): RunMatrix {
  const scenarios = unique(jobs.map((job) => job.scenario.name));
  const harnesses = unique(jobs.map((job) => job.scenario.harness));
  const iterations = unique(jobs.map((job) => job.iteration + 1));
  const cells = jobs.flatMap((job, index): RunMatrixCell[] => {
    const result = results[index];
    if (result === undefined) return [];
    return [
      {
        scenarioId: job.scenario.id,
        scenarioName: job.scenario.name,
        harness: job.scenario.harness,
        iteration: job.iteration + 1,
        passed: result.passed,
        failedAssertions: result.assertionResults
          .filter((assertionResult) => !assertionResult.passed)
          .map((assertionResult) => assertionResult.assertionId),
        durationMs: result.timing.totalMs,
      },
    ];
  });

  return {scenarios, harnesses, iterations, cells};
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
  let stdout = '';
  let stderr = '';
  const writeStdout = (value: string): void => {
    stdout += value;
    options.writeStdout?.(value);
  };
  const writeStderr = (value: string): void => {
    stderr += value;
    options.writeStderr?.(value);
  };

  if (args.length === 0) {
    writeStderr(renderPlaceholderMessage());
    return {exitCode: placeholderExitCode, stdout, stderr};
  }

  let exitCode = 0;
  const program = new Command();

  program
    .name('dynobox')
    .exitOverride()
    .configureOutput({
      writeOut: (value) => {
        writeStdout(value);
      },
      writeErr: (value) => {
        writeStderr(value);
      },
    })
    .showHelpAfterError();

  program
    .command('run')
    .argument('<config>', 'path to dynobox config')
    .description('run a dynobox config')
    .option('--quiet', 'print compact CI-friendly output')
    .option('--verbose', 'expand scenario details even when passing')
    .option('--debug', 'include debug paths and artifacts')
    .action(async (configPath: string, commandOptions: RunCommandOptions) => {
      let ir: Ir;
      try {
        const moduleExport = await loadConfigModule(configPath);
        const config = resolveConfigModule(normalizeLoadedModule(moduleExport));
        ir = compile(config);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        writeStderr(renderRunConfigErrorMessage(configPath, message));
        throw new CommanderError(
          configErrorExitCode,
          'dynobox.config',
          message,
        );
      }

      const jobs = buildLocalRunnerJobs(ir);
      const runOptions = buildRunJobOptions(options);
      const results: LocalRunnerResult[] = [];
      const ctx = createRenderContext(options, commandOptions);

      if (shouldRenderLive(options, ctx)) {
        writeStdout(renderRunHeader(configPath, jobs, ctx));
        const assertionById = assertionByIdForJobs(jobs);
        const live = createLiveWriter(
          writeStdout,
          ctx.color,
          SPINNER_FRAMES[0],
        );
        const spinnerEnabled = ctx.color && !ctx.usePlainSymbols;
        const spinner = spinnerEnabled
          ? createSpinner((frame) => {
              live.tick(frame);
            })
          : undefined;
        const isExpanded = ctx.mode === 'verbose' || ctx.mode === 'debug';

        try {
          spinner?.start();
          for (const job of jobs) {
            const state: LiveJobState = {
              setupCommandCount: 0,
              toolCount: 0,
              assertionCount: 0,
              phaseStartedAtMs: Date.now(),
            };
            live.beginJob(renderHeadline(job, ctx, 'running', undefined));
            const result = await runJob(job, {
              ...runOptions,
              onProgress: (event) => {
                live.emit(renderLiveProgressEvent(event, state, ctx));
              },
            });
            results.push(result);
            live.flush();

            const finalStatus: 'pass' | 'fail' = result.passed
              ? 'pass'
              : 'fail';
            const collapseToOneLiner = result.passed && !isExpanded;
            const finalHeadline = renderHeadline(
              job,
              ctx,
              finalStatus,
              collapseToOneLiner ? result.timing.totalMs : undefined,
            );

            if (collapseToOneLiner) {
              live.collapseToHeadline(finalHeadline);
            } else {
              live.rewriteHeadline(finalHeadline);
              writeStdout(renderLiveJobResult(result, assertionById, ctx));
            }
          }
        } finally {
          spinner?.stop();
        }

        writeStdout(renderRunSummary(jobs, results, ctx));
      } else {
        for (const job of jobs) {
          results.push(await runJob(job, runOptions));
        }

        writeStdout(renderRunOutput({configPath, jobs, results, ctx}));
      }

      if (results.some((result) => !result.passed)) {
        exitCode = runFailureExitCode;
      }
    });

  try {
    await program.parseAsync(args, {from: 'user'});
    return {exitCode, stdout, stderr};
  } catch (error) {
    if (error instanceof CommanderError) {
      return {exitCode: error.exitCode, stdout, stderr};
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

function createRenderContext(
  options: ExecuteCliOptions = {},
  commandOptions: RunCommandOptions = {},
): RenderContext {
  return {
    mode: selectMode(options, commandOptions),
    color: options.color ?? false,
    usePlainSymbols: options.usePlainSymbols ?? false,
    width: options.terminalWidth ?? DEFAULT_WIDTH,
  };
}

function selectMode(
  options: Pick<ExecuteCliOptions, 'mode'>,
  commandOptions: RunCommandOptions,
): RunOutputMode {
  if (options.mode !== undefined) return options.mode;
  if (commandOptions.quiet) return 'quiet';
  if (commandOptions.debug) return 'debug';
  if (commandOptions.verbose) return 'verbose';
  return 'default';
}

function shouldUseLiveTerminalOutput(): boolean {
  return Boolean(
    process.stdout.isTTY &&
    process.env.CI === undefined &&
    !('NO_COLOR' in process.env),
  );
}

function shouldRenderLive(
  options: Pick<ExecuteCliOptions, 'live'>,
  ctx: RenderContext,
): boolean {
  return options.live === true && ctx.mode !== 'quiet';
}

function renderQuietRun(
  _configPath: string,
  jobs: readonly LocalRunnerJob[],
  results: readonly LocalRunnerResult[],
  ctx: RenderContext,
): string {
  const matrix = buildRunMatrix(jobs, results);
  const assertionById = assertionByIdForJobs(jobs);
  const marks = results.map((result) => (result.passed ? '.' : 'F')).join('');
  const lines = [
    `  dynobox  ${renderPlanFromMatrix(matrix)}\n\n`,
    `  ${marks}\n`,
  ];

  const failed = results
    .map((result, index) => ({result, job: jobs[index]}))
    .filter(
      (entry): entry is {result: LocalRunnerResult; job: LocalRunnerJob} =>
        Boolean(entry.job && !entry.result.passed),
    );
  if (failed.length > 0) {
    lines.push('\n');
    for (const {result, job} of failed) {
      lines.push(`  FAIL  ${job.scenario.name} [${job.scenario.harness}]\n`);
      for (const assertionResult of result.assertionResults.filter(
        (assertionResult) => !assertionResult.passed,
      )) {
        const assertion = assertionById.get(assertionResult.assertionId);
        lines.push(
          `        ${assertion === undefined ? assertionResult.kind : describeAssertion(assertion)}\n`,
        );
      }
    }
  }

  const passedCount = results.filter((result) => result.passed).length;
  const failedCount = results.length - passedCount;
  const totalMs = results.reduce(
    (sum, result) => sum + result.timing.totalMs,
    0,
  );
  lines.push(
    `\n  ${passedCount} passed, ${failedCount} failed in ${formatDuration(totalMs)}\n`,
  );
  return ctx.color ? colorStatus(ctx, lines.join(''), 'plain') : lines.join('');
}

function renderHeadline(
  job: LocalRunnerJob,
  ctx: RenderContext,
  status: 'pass' | 'fail' | 'running',
  durationMs: number | undefined,
): string {
  const icon = colorStatus(
    ctx,
    symbol(ctx, status),
    status === 'running' ? 'plain' : status,
  );
  const title = `${icon}  ${job.scenario.name}`;
  const meta = `${job.scenario.harness}  iter ${job.iteration + 1}`;
  const right =
    durationMs === undefined
      ? meta
      : `${meta}   ${formatDuration(durationMs)}`;
  return `  ${leftRight(title, right, ctx.width)}`;
}

function renderLiveProgressEvent(
  event: RunJobProgressEvent,
  state: LiveJobState,
  ctx: RenderContext,
): LiveLine {
  if (event.type === 'setup.started') {
    state.setupCommandCount = event.commandCount;
    state.phaseStartedAtMs = Date.now();
    const detail = formatCount(event.commandCount, 'command');
    return {
      kind: 'update',
      render: (frame, nowMs) =>
        renderPhaseRow(ctx, {
          status: 'running',
          label: 'setup',
          detail,
          spinnerFrame: frame,
          durationMs: nowMs - state.phaseStartedAtMs,
        }),
    };
  }

  if (event.type === 'setup.completed') {
    const status = event.setupResult.success ? 'pass' : 'fail';
    return {
      kind: 'commit',
      text: renderPhaseRow(ctx, {
        status,
        label: 'setup',
        detail: formatCount(state.setupCommandCount, 'command'),
        durationMs: setupDurationMs(event.setupResult),
      }),
    };
  }

  if (event.type === 'harness.started') {
    state.phaseStartedAtMs = Date.now();
    return {
      kind: 'update',
      render: (frame, nowMs) =>
        renderPhaseRow(ctx, {
          status: 'running',
          label: 'harness',
          detail: 'running prompt...',
          spinnerFrame: frame,
          durationMs: nowMs - state.phaseStartedAtMs,
        }),
    };
  }

  if (event.type === 'harness.tool') {
    state.toolCount = event.toolCount;
    const toolEvent = event.toolEvent;
    const toolCount = event.toolCount;
    return {
      kind: 'update',
      render: (frame, nowMs) =>
        renderPhaseRow(ctx, {
          status: 'running',
          label: 'harness',
          detail: `${describeToolEvent(toolEvent)} ${dim(ctx, formatCount(toolCount, 'tool'))}`,
          spinnerFrame: frame,
          durationMs: nowMs - state.phaseStartedAtMs,
        }),
    };
  }

  if (event.type === 'harness.completed') {
    state.toolCount = event.toolCount;
    const harnessDurationMs =
      event.durationMs ?? Date.now() - state.phaseStartedAtMs;
    return {
      kind: 'commit',
      text: renderPhaseRow(ctx, {
        status: event.success ? 'pass' : 'fail',
        label: 'harness',
        detail: event.success
          ? `ran prompt ${dim(ctx, formatCount(event.toolCount, 'tool'))}`
          : 'failed',
        durationMs: harnessDurationMs,
      }),
    };
  }

  if (event.type === 'assertions.started') {
    state.assertionCount = event.assertionCount;
    state.phaseStartedAtMs = Date.now();
    return {
      kind: 'update',
      render: (frame, nowMs) =>
        renderPhaseRow(ctx, {
          status: 'running',
          label: 'assertions',
          detail: 'evaluating...',
          spinnerFrame: frame,
          durationMs: nowMs - state.phaseStartedAtMs,
        }),
    };
  }

  const passedCount = event.assertionResults.filter(
    (assertionResult) => assertionResult.passed,
  ).length;
  const status =
    passedCount === event.assertionResults.length ? 'pass' : 'fail';
  return {
    kind: 'commit',
    text: renderPhaseRow(ctx, {
      status,
      label: 'assertions',
      detail: `${passedCount} of ${state.assertionCount} passed`,
      durationMs: Date.now() - state.phaseStartedAtMs,
    }),
  };
}

function createLiveWriter(
  write: (value: string) => void,
  supportsAnsi: boolean,
  initialFrame: string,
): LiveWriter {
  let hasPending = false;
  let headlineWritten = false;
  let linesSinceHeadline = 0;
  let currentRender: LiveRender | undefined;
  let currentFrame = initialFrame;

  const eraseLine = (): void => {
    if (supportsAnsi) write('\r\x1b[2K');
  };

  const clearPending = (): void => {
    if (hasPending) {
      eraseLine();
      hasPending = false;
    }
    currentRender = undefined;
  };

  return {
    beginJob(headline: string): void {
      clearPending();
      write(`${headline}\n`);
      headlineWritten = true;
      linesSinceHeadline = 0;
    },
    emit(line: LiveLine): void {
      if (line.kind === 'update') {
        currentRender = line.render;
        const text = line.render(currentFrame, Date.now());
        if (!supportsAnsi) {
          write(`${text}\n`);
          if (headlineWritten) linesSinceHeadline += 1;
          currentRender = undefined;
          return;
        }
        if (hasPending) eraseLine();
        write(text);
        hasPending = true;
        return;
      }
      currentRender = undefined;
      if (!supportsAnsi) {
        write(`${line.text}\n`);
        if (headlineWritten) linesSinceHeadline += 1;
        return;
      }
      if (hasPending) eraseLine();
      write(`${line.text}\n`);
      hasPending = false;
      if (headlineWritten) linesSinceHeadline += 1;
    },
    tick(frame: string): void {
      currentFrame = frame;
      if (!supportsAnsi || currentRender === undefined || !hasPending) return;
      eraseLine();
      const text = currentRender(frame, Date.now());
      write(text);
    },
    rewriteHeadline(headline: string): void {
      if (!headlineWritten) {
        return;
      }
      if (!supportsAnsi) {
        headlineWritten = false;
        return;
      }
      clearPending();
      const rowsUp = linesSinceHeadline + 1;
      write(`\x1b[${rowsUp}A\r\x1b[2K${headline}\x1b[${rowsUp}B\r`);
      headlineWritten = false;
    },
    collapseToHeadline(headline: string): void {
      if (!headlineWritten) return;
      if (!supportsAnsi) {
        write(`${headline}\n`);
        headlineWritten = false;
        linesSinceHeadline = 0;
        return;
      }
      clearPending();
      const rowsUp = linesSinceHeadline + 1;
      write(`\x1b[${rowsUp}A\r\x1b[J${headline}\n`);
      headlineWritten = false;
      linesSinceHeadline = 0;
    },
    flush(): void {
      if (hasPending) {
        if (supportsAnsi) {
          eraseLine();
        } else {
          write('\n');
        }
        hasPending = false;
      }
      currentRender = undefined;
    },
  };
}

function createSpinner(onTick: (frame: string) => void): Spinner {
  let timer: ReturnType<typeof setInterval> | undefined;
  let frameIndex = 0;
  return {
    start(): void {
      if (timer !== undefined) return;
      timer = setInterval(() => {
        frameIndex = (frameIndex + 1) % SPINNER_FRAMES.length;
        const frame = SPINNER_FRAMES[frameIndex] ?? SPINNER_FRAMES[0];
        onTick(frame);
      }, SPINNER_INTERVAL_MS);
      timer.unref?.();
    },
    stop(): void {
      if (timer === undefined) return;
      clearInterval(timer);
      timer = undefined;
      frameIndex = 0;
    },
  };
}

function renderLiveJobResult(
  result: LocalRunnerResult,
  assertionById: Map<string, IrAssertion>,
  ctx: RenderContext,
): string {
  const lines: string[] = [];
  if (result.status === 'setup_failed') {
    lines.push(renderSetupFailureDetails(result, ctx));
  } else if (result.status === 'harness_failed') {
    lines.push(renderHarnessFailureDetails(result, ctx));
  }
  if (
    result.assertionResults.length > 0 &&
    (result.status !== 'harness_failed' || result.harnessResult !== undefined)
  ) {
    lines.push(renderAssertionDetails(result, assertionById, ctx));
  }
  if (ctx.mode === 'debug') {
    lines.push(renderDebugDetails(undefined, result, ctx));
  }
  return lines.join('') + '\n';
}

function renderJobDetails(
  job: LocalRunnerJob,
  result: LocalRunnerResult,
  assertionById: Map<string, IrAssertion>,
  ctx: RenderContext,
): string {
  const omitIcons = result.passed;
  const lines = [
    renderSetupPhase(result, ctx, omitIcons),
    renderHarnessPhase(result, ctx, omitIcons),
    renderAssertionsPhase(result, ctx, omitIcons),
  ];

  if (result.status === 'setup_failed') {
    lines.push(renderSetupFailureDetails(result, ctx));
  } else if (result.status === 'harness_failed') {
    lines.push(renderHarnessFailureDetails(result, ctx));
  }

  if (
    result.assertionResults.length > 0 &&
    (result.status !== 'harness_failed' || result.harnessResult !== undefined)
  ) {
    lines.push(renderAssertionDetails(result, assertionById, ctx));
  }

  if (ctx.mode === 'debug') {
    lines.push(renderDebugDetails(job, result, ctx));
  }

  return `${lines.join('')}\n`;
}

function renderSetupPhase(
  result: LocalRunnerResult,
  ctx: RenderContext,
  omitIcon: boolean,
): string {
  const passed = result.setupResult.success;
  return `${renderPhaseRow(ctx, {
    status: passed ? 'pass' : 'fail',
    label: 'setup',
    detail: formatCount(result.setupResult.logs.length, 'command'),
    durationMs: result.timing.setupMs,
    omitIcon,
  })}\n`;
}

function renderHarnessPhase(
  result: LocalRunnerResult,
  ctx: RenderContext,
  omitIcon: boolean,
): string {
  if (result.status === 'setup_failed') {
    return `${renderPhaseRow(ctx, {
      status: 'skip',
      label: 'harness',
      detail: 'skipped',
    })}\n`;
  }

  if (result.status === 'harness_failed') {
    return `${renderPhaseRow(ctx, {
      status: 'fail',
      label: 'harness',
      detail: 'failed',
      durationMs: result.timing.harnessMs,
    })}\n`;
  }

  return `${renderPhaseRow(ctx, {
    status: 'pass',
    label: 'harness',
    detail: `ran prompt ${dim(ctx, formatToolCount(result))}`,
    durationMs: result.timing.harnessMs,
    omitIcon,
  })}\n`;
}

function renderAssertionsPhase(
  result: LocalRunnerResult,
  ctx: RenderContext,
  omitIcon: boolean,
): string {
  if (result.status === 'setup_failed' || result.status === 'harness_failed') {
    return `${renderPhaseRow(ctx, {
      status: 'skip',
      label: 'assertions',
      detail: 'skipped',
    })}\n`;
  }

  const passedCount = result.assertionResults.filter(
    (assertionResult) => assertionResult.passed,
  ).length;
  const totalCount = result.assertionResults.length;
  return `${renderPhaseRow(ctx, {
    status: passedCount === totalCount ? 'pass' : 'fail',
    label: 'assertions',
    detail: `${passedCount} of ${totalCount} passed`,
    durationMs: result.timing.assertionsMs,
    omitIcon,
  })}\n`;
}

function renderPhaseRow(
  ctx: RenderContext,
  input: {
    status: 'pass' | 'fail' | 'skip' | 'running';
    label: string;
    detail: string;
    durationMs?: number;
    spinnerFrame?: string;
    omitIcon?: boolean;
  },
): string {
  const labelText = input.label.padEnd(11);
  let inner: string;
  if (input.omitIcon === true) {
    inner = dim(ctx, `${labelText}${input.detail}`);
  } else {
    const iconText =
      input.status === 'running' && input.spinnerFrame !== undefined
        ? input.spinnerFrame
        : symbol(ctx, input.status);
    const icon = colorStatus(
      ctx,
      iconText,
      input.status === 'running' ? 'plain' : input.status,
    );
    inner = `${icon} ${labelText}${input.detail}`;
  }
  const left = `   ${inner}`;
  const formatter =
    input.status === 'running' ? formatLiveDuration : formatDuration;
  const right =
    input.durationMs === undefined
      ? ''
      : dim(ctx, formatter(input.durationMs));
  return `  ${leftRight(left, right, ctx.width)}`;
}

function renderSetupFailureDetails(
  result: LocalRunnerResult,
  ctx: RenderContext,
): string {
  const failed = result.setupResult.logs.find((log) => log.exitCode !== 0);
  if (failed === undefined) return '';

  const lines = [
    `        ${dim(ctx, `$ ${truncate(failed.command, 68)}`)}\n`,
    `          exit code ${failed.exitCode}\n`,
  ];
  const output = failed.stderr.trim() || failed.stdout.trim();
  if (output.length > 0) {
    lines.push(...output.split(/\r?\n/).map((line) => `          ${line}\n`));
  }
  return lines.join('');
}

function renderHarnessFailureDetails(
  result: LocalRunnerResult,
  ctx: RenderContext,
): string {
  if (result.diagnostics.length === 0) return '';
  return result.diagnostics
    .map((diagnostic) => `        ${colorStatus(ctx, diagnostic, 'fail')}\n`)
    .join('');
}

function renderAssertionDetails(
  result: LocalRunnerResult,
  assertionById: Map<string, IrAssertion>,
  ctx: RenderContext,
): string {
  if (result.assertionResults.length === 0) return '';

  const lines: string[] = [];
  for (const assertionResult of result.assertionResults) {
    const assertion = assertionById.get(assertionResult.assertionId);
    const status = assertionResult.passed ? 'pass' : 'fail';
    const label =
      assertion === undefined
        ? assertionResult.kind
        : describeAssertion(assertion);
    lines.push(
      `        ${colorStatus(ctx, symbol(ctx, status), status)} ${label}\n`,
    );

    if (!assertionResult.passed && assertion !== undefined) {
      lines.push(`           expected  ${describeExpectation(assertion)}\n`);
      lines.push(`           observed  ${assertionResult.message}\n`);
    }
  }

  if (shouldShowObservedShellCommands(result, assertionById, ctx)) {
    lines.push('\n        observed shell commands during this run:\n');
    const shellCommands = observedShellCommands(
      result.harnessResult?.toolEvents ?? [],
    );
    if (shellCommands.length === 0) {
      lines.push(`           ${dim(ctx, '(none)')}\n`);
    } else {
      for (const [index, command] of shellCommands.entries()) {
        lines.push(`           ${index + 1}. ${dim(ctx, command)}\n`);
      }
    }
  }

  return lines.join('');
}

function renderDebugDetails(
  _job: LocalRunnerJob | undefined,
  result: LocalRunnerResult,
  ctx: RenderContext,
): string {
  const lines = [`        ${dim(ctx, `work dir  ${result.workDir}`)}\n`];
  for (const artifact of result.artifacts) {
    lines.push(
      `        ${dim(ctx, `artifact  ${artifact.kind} ${artifact.path}`)}\n`,
    );
  }
  return lines.join('');
}

function shouldShowObservedShellCommands(
  result: LocalRunnerResult,
  assertionById: Map<string, IrAssertion>,
  ctx: RenderContext,
): boolean {
  if (ctx.mode === 'verbose' || ctx.mode === 'debug') {
    return (
      observedShellCommands(result.harnessResult?.toolEvents ?? []).length > 0
    );
  }

  return result.assertionResults.some((assertionResult) => {
    if (assertionResult.passed) return false;
    const assertion = assertionById.get(assertionResult.assertionId);
    return assertion?.kind === 'tool.called' && assertion.toolKind === 'shell';
  });
}

function observedShellCommands(toolEvents: readonly ToolEvent[]): string[] {
  return toolEvents.flatMap((event) => {
    if (event.kind !== 'shell') return [];
    const command = (event as {command?: unknown}).command;
    return typeof command === 'string' ? [command] : [];
  });
}

function describeToolEvent(toolEvent: ToolEvent): string {
  if (toolEvent.kind === 'shell') {
    const command = (toolEvent as {command?: unknown}).command;
    return typeof command === 'string'
      ? `${toolEvent.rawName}: ${truncate(command, 42)}`
      : toolEvent.rawName;
  }

  return toolEvent.rawName;
}

function setupDurationMs(
  setupResult: LocalRunnerResult['setupResult'],
): number {
  return setupResult.logs.reduce((total, log) => total + log.durationMs, 0);
}

function assertionByIdForJobs(
  jobs: readonly LocalRunnerJob[],
): Map<string, IrAssertion> {
  return new Map(
    jobs.flatMap((job) =>
      job.scenario.assertions.map((assertion) => [assertion.id, assertion]),
    ),
  );
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

function describeExpectation(assertion: IrAssertion): string {
  if (assertion.kind !== 'tool.called') return describeAssertion(assertion);
  if (assertion.matcher === undefined) return `${assertion.toolKind} tool call`;
  if ('equals' in assertion.matcher) {
    return `shell command equal to "${assertion.matcher.equals}"`;
  }
  if ('includes' in assertion.matcher) {
    return `shell command including "${assertion.matcher.includes}"`;
  }
  if ('startsWith' in assertion.matcher) {
    return `shell command starting with "${assertion.matcher.startsWith}"`;
  }
  return `shell command matching /${assertion.matcher.matches}/`;
}

function describeShellMatcher(matcher: ShellToolMatcher): string {
  if ('equals' in matcher) return `equals: ${matcher.equals}`;
  if ('includes' in matcher) return `includes: ${matcher.includes}`;
  if ('startsWith' in matcher) return `startsWith: ${matcher.startsWith}`;
  return `matches: ${matcher.matches}`;
}

function renderPlan(jobs: readonly LocalRunnerJob[]): string {
  return renderPlanFromMatrix(buildRunMatrix(jobs, []));
}

function renderPlanFromMatrix(
  matrix: Pick<RunMatrix, 'scenarios' | 'harnesses' | 'iterations'>,
): string {
  return `${formatCount(matrix.scenarios.length, 'scenario')} · ${formatCount(matrix.harnesses.length, 'harness')} · ${formatCount(matrix.iterations.length, 'iteration')}`;
}

function formatToolCount(result: LocalRunnerResult): string {
  return formatCount(result.harnessResult?.toolEvents.length ?? 0, 'tool');
}

function formatCount(count: number, singular: string): string {
  return `${count} ${count === 1 ? singular : `${singular}s`}`;
}

function formatDuration(durationMs: number): string {
  return `${(durationMs / 1000).toFixed(1)}s`;
}

function formatLiveDuration(durationMs: number): string {
  return `${Math.floor(durationMs / 1000)}s`;
}

function symbol(
  ctx: RenderContext,
  status: 'pass' | 'fail' | 'skip' | 'running',
): string {
  if (ctx.usePlainSymbols) {
    if (status === 'pass') return '[ ok ]';
    if (status === 'fail') return '[FAIL]';
    if (status === 'skip') return '[skip]';
    return '[ .. ]';
  }

  if (status === 'pass') return '✓';
  if (status === 'fail') return '✗';
  if (status === 'skip') return '–';
  return '◐';
}

function colorStatus(
  ctx: RenderContext,
  value: string,
  status: 'pass' | 'fail' | 'skip' | 'plain',
): string {
  if (status === 'pass') return style(ctx, value, 'pass');
  if (status === 'fail') return style(ctx, value, 'fail');
  if (status === 'skip') return style(ctx, value, 'skip');
  return value;
}

function style(
  ctx: Pick<RenderContext, 'color'>,
  value: string,
  kind: 'brand' | 'pass' | 'fail' | 'skip' | 'dim',
): string {
  if (!ctx.color) return value;
  const code =
    kind === 'brand'
      ? PURPLE
      : kind === 'pass'
        ? GREEN
        : kind === 'fail'
          ? RED
          : kind === 'skip'
            ? YELLOW
            : DIM;
  return `${code}${value}${RESET}`;
}

function dim(ctx: RenderContext, value: string): string {
  return style(ctx, value, 'dim');
}

function separator(ctx: RenderContext): string {
  return dim(ctx, '─'.repeat(Math.max(20, ctx.width - 2)));
}

function leftRight(left: string, right: string, width: number): string {
  if (right.length === 0) return left;
  const gap = width - visibleLength(left) - visibleLength(right);
  return gap <= 1 ? `${left} ${right}` : `${left}${' '.repeat(gap)}${right}`;
}

function visibleLength(value: string): number {
  return value.replace(ANSI_ESCAPE_PATTERN, '').length;
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}
