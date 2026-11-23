import {z} from 'zod';

/**
 * Anonymous CLI usage telemetry. The CLI sends one batch per command. Old CLI
 * versions keep sending old batches, so the API accepts every version it has
 * shipped, and new fields within a version stay optional.
 *
 * Batches never carry prompts, paths, dyno or scenario names, repository
 * names, or assertion content.
 */
export const TELEMETRY_SCHEMA_VERSION = 1 as const;

export const TELEMETRY_LIMITS = {
  /** Upper bound on a request body, checked before parsing. */
  bodyBytes: 32_768,
  eventsPerBatch: 50,
  identifierLength: 64,
  versionLength: 128,
  modelLength: 128,
  listItems: 20,
} as const;

/**
 * Values the CLI sends today. The schema accepts any identifier so a newer
 * CLI's values still validate against an older API.
 */
export const TELEMETRY_COMMANDS = [
  'run',
  'validate',
  'discover',
  'init',
  'login',
  'logout',
  'whoami',
] as const;
export const TELEMETRY_ERROR_CATEGORIES = [
  'config',
  'harness',
  'auth',
  'network',
  'cancelled',
  'internal',
] as const;
export const TELEMETRY_CONFIG_FORMATS = ['js', 'ts', 'yaml'] as const;
export const TELEMETRY_FEATURES = [
  'save_run',
  'cli_mocks',
  'mcp_mocks',
  'http_mocks',
  'http',
  'multi_turn',
] as const;

const count = z.number().int().nonnegative();
const durationMs = z.number().int().nonnegative();
const identifier = z
  .string()
  .min(1)
  .max(TELEMETRY_LIMITS.identifierLength)
  .regex(/^[a-z0-9][a-z0-9._-]*$/);
const identifierList = z.array(identifier).max(TELEMETRY_LIMITS.listItems);
const version = z.string().min(1).max(TELEMETRY_LIMITS.versionLength);

export const TelemetryContext = z.object({
  /** Random UUID stored in the user's Dynobox config; not tied to an account. */
  installId: z.uuid(),
  cliVersion: version,
  /** `process.platform`, for example `darwin`. */
  os: identifier,
  /** `process.arch`, for example `arm64`. */
  arch: identifier,
  nodeVersion: version,
  ci: z.boolean(),
});

export const TelemetryCommandEvent = z.object({
  type: z.literal('command'),
  command: identifier,
  exitCode: z.number().int(),
  durationMs,
  errorCategory: identifier.nullable(),
  /** Whether this was the first tracked command for this install. */
  firstRun: z.boolean(),
});

export const TelemetryRunEvent = z.object({
  type: z.literal('run'),
  /** Random per-run UUID that links a run to its `harness_run` events. */
  runId: z.uuid(),
  dynos: count,
  scenarios: count,
  jobs: count,
  iterations: count,
  passed: z.boolean(),
  configFormats: identifierList,
  features: identifierList,
});

export const TelemetryHarnessRunEvent = z.object({
  type: z.literal('harness_run'),
  runId: z.uuid(),
  harness: identifier,
  harnessVersion: version.nullable(),
  model: z.string().min(1).max(TELEMETRY_LIMITS.modelLength).nullable(),
  jobs: count,
  passed: count,
  assertionFailed: count,
  harnessFailed: count,
  setupFailed: count,
  timedOut: count,
  /** Job time measured by Dynobox, summed over the harness's jobs. */
  wallMs: durationMs,
  /** Job time the harness reported itself, when it reports one. */
  reportedMs: durationMs.nullable(),
  unknownToolEvents: count,
});

export const TelemetryEvent = z.discriminatedUnion('type', [
  TelemetryCommandEvent,
  TelemetryRunEvent,
  TelemetryHarnessRunEvent,
]);

export const TelemetryBatchV1 = z.object({
  schemaVersion: z.literal(TELEMETRY_SCHEMA_VERSION),
  context: TelemetryContext,
  events: z.array(TelemetryEvent).min(1).max(TELEMETRY_LIMITS.eventsPerBatch),
});

/** Every batch version the API accepts. */
export const TelemetryBatch = TelemetryBatchV1;

export type TelemetryContext = z.infer<typeof TelemetryContext>;
export type TelemetryCommandEvent = z.infer<typeof TelemetryCommandEvent>;
export type TelemetryRunEvent = z.infer<typeof TelemetryRunEvent>;
export type TelemetryHarnessRunEvent = z.infer<typeof TelemetryHarnessRunEvent>;
export type TelemetryEvent = z.infer<typeof TelemetryEvent>;
export type TelemetryBatchV1 = z.infer<typeof TelemetryBatchV1>;
export type TelemetryBatch = z.infer<typeof TelemetryBatch>;
