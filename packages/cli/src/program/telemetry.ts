/**
 * Anonymous CLI usage telemetry.
 *
 * On by default with a one-time notice, off in CI, and off when
 * `DO_NOT_TRACK`, `DYNOBOX_TELEMETRY=0`, or `dynobox telemetry disable` says
 * so. State lives in `~/.dynobox/telemetry.json`, separate from the auth
 * config that `login`/`logout` rewrite. Delivery never fails a command.
 */

import {randomUUID} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {extname, join} from 'node:path';

import {
  TELEMETRY_COMMANDS,
  TELEMETRY_LIMITS,
  TELEMETRY_SCHEMA_VERSION,
  TelemetryBatch,
  type TelemetryContext,
  type TelemetryEvent,
  type TelemetryHarnessRunEvent,
} from '@dynobox/run-schema';
import type {LocalRunnerJob, LocalRunnerResult} from '@dynobox/runner-local';
import {CommanderError} from 'commander';

import {unique} from '../util/unique.js';
import {readPackageVersion} from '../util/version.js';
import {DYNOBOX_CONFIG_DIR} from './auth.js';
import type {OutputWriter} from './execute.js';
import {resolveApiUrl} from './identityApi.js';

export const TELEMETRY_FILE = 'telemetry.json';
export const TELEMETRY_DOCS_URL = 'https://docs.dynobox.xyz/telemetry';
const DELIVERY_TIMEOUT_MS = 1_500;

export type TelemetryEnvironment = Record<string, string | undefined>;

export type TelemetryPaths = {
  env?: TelemetryEnvironment;
  homeDir?: string;
};

type TelemetryState = {installId: string; enabled?: boolean};

export type TelemetryStatus = {
  enabled: boolean;
  /** What decided `enabled`, in precedence order. */
  source: 'DO_NOT_TRACK' | 'DYNOBOX_TELEMETRY' | 'config' | 'CI' | 'default';
  installId: string | null;
  debug: boolean;
};

export type TelemetrySession = {
  context: TelemetryContext;
  firstRun: boolean;
  /** Sends (or, in debug mode, prints) a batch. Never throws. */
  deliver: (batch: TelemetryBatch) => Promise<void>;
};

export function telemetryFilePath(input: TelemetryPaths = {}): string {
  const home =
    input.homeDir ?? input.env?.HOME ?? process.env.HOME ?? homedir();
  return join(home, DYNOBOX_CONFIG_DIR, TELEMETRY_FILE);
}

export function resolveTelemetryStatus(
  input: TelemetryPaths = {},
): TelemetryStatus {
  const env = input.env ?? process.env;
  const state = readState(input);
  const base = {
    installId: state?.installId ?? null,
    debug: isTruthy(env.DYNOBOX_TELEMETRY_DEBUG),
  };

  if (isTruthy(env.DO_NOT_TRACK)) {
    return {...base, enabled: false, source: 'DO_NOT_TRACK'};
  }
  const override = parseSwitch(env.DYNOBOX_TELEMETRY);
  if (override !== undefined) {
    return {...base, enabled: override, source: 'DYNOBOX_TELEMETRY'};
  }
  if (state?.enabled !== undefined) {
    return {...base, enabled: state.enabled, source: 'config'};
  }
  if (env.CI !== undefined && parseSwitch(env.CI) !== false) {
    return {...base, enabled: false, source: 'CI'};
  }
  return {...base, enabled: true, source: 'default'};
}

/** Saves `enabled` and returns the file path. Keeps the install ID. */
export function setTelemetryEnabled(
  enabled: boolean,
  input: TelemetryPaths = {},
): string {
  const state = readState(input) ?? {installId: randomUUID()};
  return writeState({...state, enabled}, input);
}

/**
 * Starts a session for a tracked command, or returns undefined when
 * telemetry is off. The first session creates the install ID and prints the
 * notice, so the notice always comes before anything is sent.
 */
export function startTelemetrySession(
  input: TelemetryPaths & {
    writeStderr: OutputWriter;
    fetch?: typeof fetch;
  },
): TelemetrySession | undefined {
  const status = resolveTelemetryStatus(input);
  if (!status.enabled) return undefined;

  let installId = status.installId;
  const firstRun = installId === null;
  if (installId === null) {
    installId = randomUUID();
    try {
      writeState({installId}, input);
    } catch {
      // An unwritable home directory would show the notice on every run.
      return undefined;
    }
    input.writeStderr(renderTelemetryNotice());
  }

  const env = input.env ?? process.env;
  const apiUrl = resolveApiUrl(env);
  const send = input.fetch ?? fetch;
  return {
    context: {
      installId,
      cliVersion: readPackageVersion(),
      os: process.platform,
      arch: process.arch,
      nodeVersion: process.versions.node,
      ci: env.CI !== undefined,
    },
    firstRun,
    deliver: async (batch) => {
      if (status.debug) {
        input.writeStderr(`[telemetry] ${JSON.stringify(batch)}\n`);
        return;
      }
      try {
        await send(`${apiUrl}/telemetry`, {
          method: 'POST',
          headers: {'content-type': 'application/json'},
          body: JSON.stringify(batch),
          signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
        });
      } catch {
        // Offline, slow, or blocked: telemetry is best effort.
      }
    },
  };
}

export function renderTelemetryNotice(): string {
  return [
    'dynobox collects anonymous usage data: commands, harnesses, models, pass and fail counts, and timings.',
    'It never collects prompts, file paths, dyno or scenario names, or repository names.',
    `Turn it off with \`dynobox telemetry disable\` or DYNOBOX_TELEMETRY=0. Details: ${TELEMETRY_DOCS_URL}`,
    '',
  ].join('\n');
}

export function isTrackedCommand(name: string): boolean {
  return (TELEMETRY_COMMANDS as readonly string[]).includes(name);
}

/** Maps a thrown CommanderError to a telemetry error category. */
export function telemetryErrorCategory(error: unknown): string {
  if (!(error instanceof CommanderError)) return 'internal';
  switch (error.code) {
    case 'dynobox.auth':
    case 'dynobox.login':
    case 'dynobox.whoami':
      return 'auth';
    case 'dynobox.cancelled':
      return 'cancelled';
    default:
      return 'config';
  }
}

export type CompletedCommand = {
  command: string;
  exitCode: number;
  durationMs: number;
  errorCategory: string | null;
};

/**
 * Builds the batch for one command plus any run events, or returns undefined
 * if it would not validate (the API would reject it anyway).
 */
export function buildTelemetryBatch(
  session: TelemetrySession,
  completed: CompletedCommand,
  runEvents: readonly TelemetryEvent[],
): TelemetryBatch | undefined {
  const commandEvent: TelemetryEvent = {
    type: 'command',
    ...completed,
    firstRun: session.firstRun,
  };
  const events = [commandEvent, ...runEvents].slice(
    0,
    TELEMETRY_LIMITS.eventsPerBatch,
  );
  const parsed = TelemetryBatch.safeParse({
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    context: session.context,
    events,
  });
  return parsed.success ? parsed.data : undefined;
}

export type RunTelemetryInput = {
  dynos: ReadonlyArray<{filePath: string; jobs: readonly LocalRunnerJob[]}>;
  results: readonly LocalRunnerResult[];
  iterations: number;
  passed: boolean;
  saveRun: boolean;
};

/**
 * One `run` event plus one `harness_run` event per harness and model. The
 * run ID is random and used only to join these events; it is not the saved
 * run's ID, so telemetry cannot be linked to an uploaded run.
 */
export function buildRunTelemetryEvents(
  input: RunTelemetryInput,
): TelemetryEvent[] {
  const runId = randomUUID();
  const dynos = input.dynos.filter((dyno) => dyno.jobs.length > 0);
  const jobs = dynos.flatMap((dyno) => dyno.jobs);
  const scenarios = dynos.flatMap((dyno) =>
    unique(dyno.jobs.map((job) => job.scenario)),
  );

  const features = new Set<string>();
  if (input.saveRun) features.add('save_run');
  for (const scenario of scenarios) {
    if (Object.keys(scenario.cliMocks).length > 0) features.add('cli_mocks');
    if (scenario.mcpMocks !== undefined) features.add('mcp_mocks');
    if (scenario.endpoints.length > 0) features.add('http');
  }

  const harnessRuns = new Map<string, TelemetryHarnessRunEvent>();
  for (const result of input.results) {
    const model = result.model?.slice(0, TELEMETRY_LIMITS.modelLength) ?? null;
    const key = `${result.harness}\0${model ?? ''}`;
    const event = harnessRuns.get(key) ?? {
      type: 'harness_run',
      runId,
      harness: result.harness,
      harnessVersion: null,
      model,
      jobs: 0,
      passed: 0,
      assertionFailed: 0,
      harnessFailed: 0,
      setupFailed: 0,
      // The CLI sets no job timeout yet, so no job can time out.
      timedOut: 0,
      wallMs: 0,
      // Harness-reported durations are not parsed yet.
      reportedMs: null,
      unknownToolEvents: 0,
    };
    event.harnessVersion ??=
      result.harnessVersion?.slice(0, TELEMETRY_LIMITS.versionLength) ?? null;
    event.jobs += 1;
    if (result.status === 'passed') event.passed += 1;
    if (result.status === 'assertion_failed') event.assertionFailed += 1;
    if (result.status === 'harness_failed') event.harnessFailed += 1;
    if (result.status === 'setup_failed') event.setupFailed += 1;
    event.wallMs += Math.round(result.timing.totalMs);
    event.unknownToolEvents +=
      result.harnessResult?.toolEvents.filter(
        (toolEvent) => toolEvent.kind === 'unknown',
      ).length ?? 0;
    harnessRuns.set(key, event);
  }

  return [
    {
      type: 'run',
      runId,
      dynos: dynos.length,
      scenarios: scenarios.length,
      jobs: jobs.length,
      iterations: input.iterations,
      passed: input.passed,
      configFormats: unique(dynos.map((dyno) => configFormat(dyno.filePath))),
      features: [...features],
    },
    ...harnessRuns.values(),
  ];
}

function configFormat(filePath: string): string {
  const extension = extname(filePath).toLowerCase();
  if (extension === '.yaml' || extension === '.yml') return 'yaml';
  if (extension === '.ts' || extension === '.mts' || extension === '.cts') {
    return 'ts';
  }
  return 'js';
}

function readState(input: TelemetryPaths): TelemetryState | null {
  const path = telemetryFilePath(input);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    const {installId, enabled} = parsed as Record<string, unknown>;
    if (typeof installId !== 'string') return null;
    return typeof enabled === 'boolean' ? {installId, enabled} : {installId};
  } catch {
    return null;
  }
}

function writeState(state: TelemetryState, input: TelemetryPaths): string {
  const path = telemetryFilePath(input);
  mkdirSync(join(path, '..'), {recursive: true});
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
  return path;
}

function isTruthy(value: string | undefined): boolean {
  return value !== undefined && value !== '' && parseSwitch(value) !== false;
}

/** `1/true/on` → true, `0/false/off` → false, anything else → undefined. */
function parseSwitch(value: string | undefined): boolean | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 'on') {
    return true;
  }
  if (normalized === '0' || normalized === 'false' || normalized === 'off') {
    return false;
  }
  return undefined;
}
