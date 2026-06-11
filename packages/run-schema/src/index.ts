import {z} from 'zod';

export const RUN_UPLOAD_SCHEMA_VERSION = 1 as const;

export const RUN_UPLOAD_STATUS = ['passed', 'failed'] as const;
export const RUN_UPLOAD_JOB_STATUS = [
  'passed',
  'setup_failed',
  'harness_failed',
  'assertion_failed',
] as const;

export const RUN_UPLOAD_LIMITS = {
  cliVersionLength: 64,
  gitHashLength: 128,
  inputPathLength: 256,
  targetLength: 256,
  dynoPathLength: 512,
  dynoNameLength: 256,
  scenarioIdLength: 512,
  scenarioNameLength: 512,
  harnessIdLength: 64,
  modelLength: 128,
  assertionIdLength: 512,
  assertionLabelLength: 512,
  assertionKindLength: 64,
  assertionMessageLength: 2_000,
  diagnosticsPerJob: 20,
  diagnosticLength: 2_000,
  warningsPerJob: 20,
  warningLength: 2_000,
  assertionDetailLength: 2_000,
  assertionChildren: 50,
  evidenceItems: 50,
  dynos: 200,
  jobsPerDyno: 1_000,
  assertionsPerJob: 200,
} as const;

const countSchema = z.number().int().nonnegative();
const durationMsSchema = z.number().int().nonnegative();

const optionalNullableString = (maxLength: number) =>
  z.string().min(1).max(maxLength).nullable().optional();

const assertionDetailString = z
  .string()
  .min(1)
  .max(RUN_UPLOAD_LIMITS.assertionDetailLength);

const assertionMatcherSchema = z
  .object({
    equals: optionalNullableString(RUN_UPLOAD_LIMITS.assertionDetailLength),
    includes: optionalNullableString(RUN_UPLOAD_LIMITS.assertionDetailLength),
    startsWith: optionalNullableString(RUN_UPLOAD_LIMITS.assertionDetailLength),
    matches: optionalNullableString(RUN_UPLOAD_LIMITS.assertionDetailLength),
  })
  .strict();

const runUploadAssertionDefinitionStepV1Schema = z
  .object({
    kind: z.string().min(1).max(RUN_UPLOAD_LIMITS.assertionKindLength),
    toolKind: optionalNullableString(RUN_UPLOAD_LIMITS.assertionKindLength),
    matcher: assertionMatcherSchema.optional(),
    pathMatcher: z.object({path: assertionDetailString}).strict().optional(),
  })
  .strict();

export const runUploadAssertionDefinitionV1Schema = z
  .object({
    kind: z.string().min(1).max(RUN_UPLOAD_LIMITS.assertionKindLength),
    toolKind: optionalNullableString(RUN_UPLOAD_LIMITS.assertionKindLength),
    matcher: assertionMatcherSchema.optional(),
    pathMatcher: z.object({path: assertionDetailString}).strict().optional(),
    endpointId: optionalNullableString(RUN_UPLOAD_LIMITS.assertionDetailLength),
    status: z.number().int().optional(),
    skill: optionalNullableString(RUN_UPLOAD_LIMITS.assertionDetailLength),
    path: optionalNullableString(RUN_UPLOAD_LIMITS.assertionDetailLength),
    text: optionalNullableString(RUN_UPLOAD_LIMITS.assertionDetailLength),
    steps: z
      .array(runUploadAssertionDefinitionStepV1Schema)
      .max(RUN_UPLOAD_LIMITS.assertionChildren)
      .optional(),
  })
  .strict();

export const runUploadAssertionDisplayChildV1Schema = z
  .object({
    index: z.number().int().positive(),
    kind: z.string().min(1).max(RUN_UPLOAD_LIMITS.assertionKindLength),
    title: assertionDetailString,
    expectation: assertionDetailString,
    observed: optionalNullableString(RUN_UPLOAD_LIMITS.assertionDetailLength),
    passed: z.boolean().nullable(),
  })
  .strict();

export const runUploadAssertionDisplayV1Schema = z
  .object({
    title: assertionDetailString,
    expectation: assertionDetailString,
    observed: optionalNullableString(RUN_UPLOAD_LIMITS.assertionDetailLength),
    children: z
      .array(runUploadAssertionDisplayChildV1Schema)
      .max(RUN_UPLOAD_LIMITS.assertionChildren),
  })
  .strict();

export const runUploadAssertionEvidenceV1Schema = z
  .object({
    observedCount: countSchema.optional(),
    matchedCount: countSchema.optional(),
    observedKinds: z
      .array(z.string().min(1).max(RUN_UPLOAD_LIMITS.assertionKindLength))
      .max(RUN_UPLOAD_LIMITS.evidenceItems)
      .optional(),
    matches: z
      .array(assertionDetailString)
      .max(RUN_UPLOAD_LIMITS.evidenceItems)
      .optional(),
  })
  .strict();

export const runUploadTotalsV1Schema = z
  .object({
    jobs: countSchema,
    passed: countSchema,
    failed: countSchema,
    warnings: countSchema,
    durationMs: durationMsSchema,
  })
  .strict();

export const runUploadAssertionV1Schema = z
  .object({
    assertionId: z.string().min(1).max(RUN_UPLOAD_LIMITS.assertionIdLength),
    label: z.string().min(1).max(RUN_UPLOAD_LIMITS.assertionLabelLength),
    kind: z.string().min(1).max(RUN_UPLOAD_LIMITS.assertionKindLength),
    passed: z.boolean(),
    message: z.string().min(1).max(RUN_UPLOAD_LIMITS.assertionMessageLength),
    definition: runUploadAssertionDefinitionV1Schema.optional(),
    display: runUploadAssertionDisplayV1Schema.optional(),
    evidence: runUploadAssertionEvidenceV1Schema.optional(),
  })
  .strict();

export const runUploadJobV1Schema = z
  .object({
    jobId: z.string().min(1).max(RUN_UPLOAD_LIMITS.scenarioIdLength),
    scenario: z
      .object({
        id: z.string().min(1).max(RUN_UPLOAD_LIMITS.scenarioIdLength),
        name: z.string().min(1).max(RUN_UPLOAD_LIMITS.scenarioNameLength),
      })
      .strict(),
    harness: z
      .object({
        id: z.string().min(1).max(RUN_UPLOAD_LIMITS.harnessIdLength),
        model: optionalNullableString(RUN_UPLOAD_LIMITS.modelLength),
      })
      .strict(),
    iteration: z.number().int().positive(),
    status: z.enum(RUN_UPLOAD_JOB_STATUS),
    passed: z.boolean(),
    durationMs: durationMsSchema,
    assertions: z
      .array(runUploadAssertionV1Schema)
      .max(RUN_UPLOAD_LIMITS.assertionsPerJob),
    diagnostics: z
      .array(z.string().min(1).max(RUN_UPLOAD_LIMITS.diagnosticLength))
      .max(RUN_UPLOAD_LIMITS.diagnosticsPerJob),
    warnings: z
      .array(z.string().min(1).max(RUN_UPLOAD_LIMITS.warningLength))
      .max(RUN_UPLOAD_LIMITS.warningsPerJob),
  })
  .strict();

/**
 * One authored `.dyno` test spec inside a run, grouped under the target it
 * tests. Jobs nest here so per-dyno totals stay self-describing.
 */
export const runUploadDynoV1Schema = z
  .object({
    dynoPath: z.string().min(1).max(RUN_UPLOAD_LIMITS.dynoPathLength),
    name: optionalNullableString(RUN_UPLOAD_LIMITS.dynoNameLength),
    target: z.string().min(1).max(RUN_UPLOAD_LIMITS.targetLength),
    status: z.enum(RUN_UPLOAD_STATUS),
    totals: runUploadTotalsV1Schema,
    jobs: z.array(runUploadJobV1Schema).max(RUN_UPLOAD_LIMITS.jobsPerDyno),
  })
  .strict();

export const RunUploadV1 = z
  .object({
    schemaVersion: z.literal(RUN_UPLOAD_SCHEMA_VERSION),
    createdAt: z.iso.datetime(),
    cliVersion: z.string().min(1).max(RUN_UPLOAD_LIMITS.cliVersionLength),
    gitHash: optionalNullableString(RUN_UPLOAD_LIMITS.gitHashLength),
    /** The path the CLI was pointed at (`dynobox run <inputPath>`). */
    inputPath: optionalNullableString(RUN_UPLOAD_LIMITS.inputPathLength),
    status: z.enum(RUN_UPLOAD_STATUS),
    totals: runUploadTotalsV1Schema,
    dynos: z.array(runUploadDynoV1Schema).max(RUN_UPLOAD_LIMITS.dynos),
  })
  .strict();

export const RunSharingUpdate = z
  .object({
    public: z.boolean(),
  })
  .strict();

export type RunUploadStatus = (typeof RUN_UPLOAD_STATUS)[number];
export type RunUploadJobStatus = (typeof RUN_UPLOAD_JOB_STATUS)[number];
export type RunUploadTotalsV1 = z.infer<typeof runUploadTotalsV1Schema>;
export type RunUploadAssertionDefinitionV1 = z.infer<
  typeof runUploadAssertionDefinitionV1Schema
>;
export type RunUploadAssertionDisplayChildV1 = z.infer<
  typeof runUploadAssertionDisplayChildV1Schema
>;
export type RunUploadAssertionDisplayV1 = z.infer<
  typeof runUploadAssertionDisplayV1Schema
>;
export type RunUploadAssertionEvidenceV1 = z.infer<
  typeof runUploadAssertionEvidenceV1Schema
>;
export type RunUploadAssertionV1 = z.infer<typeof runUploadAssertionV1Schema>;
export type RunUploadJobV1 = z.infer<typeof runUploadJobV1Schema>;
export type RunUploadDynoV1 = z.infer<typeof runUploadDynoV1Schema>;
export type RunUploadV1 = z.infer<typeof RunUploadV1>;

export type RunUploadCreateInputV1 = z.input<typeof RunUploadV1>;

export type RunSharingUpdate = z.infer<typeof RunSharingUpdate>;

export type RunSummary = {
  id: string;
  url: string;
  createdAt: string;
  cliVersion: string;
  schemaVersion: typeof RUN_UPLOAD_SCHEMA_VERSION;
  gitHash: string | null;
  /** The path the CLI was pointed at when the run was created. */
  inputPath: string | null;
  status: RunUploadStatus;
  targetCount: number;
  dynoCount: number;
  /** Passed/failed job counts. */
  passCount: number;
  failCount: number;
  assertionCount: number;
  passedAssertionCount: number;
  failedAssertionCount: number;
  warningCount: number;
  durationMs: number;
  public: boolean;
};

export type RunAssertionDetail = {
  id: string;
  assertionId: string;
  label: string;
  kind: string;
  passed: boolean;
  message: string | null;
  definition: RunUploadAssertionDefinitionV1 | null;
  display: RunUploadAssertionDisplayV1 | null;
  evidence: RunUploadAssertionEvidenceV1 | null;
};

/** The dyno a stored job belongs to. */
export type RunJobDynoRef = {
  dynoId: string;
  dynoPath: string;
  name: string | null;
  target: string;
};

export type RunJobDetail = {
  id: string;
  dyno: RunJobDynoRef;
  scenario: {
    id: string;
    name: string;
  };
  harness: {
    id: string;
    model: string | null;
  };
  iteration: number;
  status: RunUploadJobStatus;
  passed: boolean;
  durationMs: number;
  assertionCount: number;
  passedAssertionCount: number;
  failedAssertionCount: number;
  warningCount: number;
  diagnostics: string[];
  warnings: string[];
  assertions: RunAssertionDetail[];
};

export type RunDetail = RunSummary & {
  isOwner: boolean;
  summary: RunUploadTotalsV1;
  jobs: RunJobDetail[];
};

export type TargetRunRef = {
  runId: string;
  createdAt: string;
  status: RunUploadStatus;
  harnesses: string[];
};

/**
 * Aggregate health for one target — the thing being tested — built from the
 * most recent run that included the target plus a short run history.
 */
export type TargetSummary = {
  target: string;
  status: RunUploadStatus;
  dynoCount: number;
  scenarioCount: number;
  jobCount: number;
  assertionCount: number;
  passedAssertionCount: number;
  failedAssertionCount: number;
  warningCount: number;
  lastRunId: string;
  lastRunAt: string;
  /** Per-run status for this target, newest first. */
  recentRuns: TargetRunRef[];
};

/** One dyno under a target, summarized from its most recent run. */
export type TargetDynoSummary = {
  /** Stable identifier for the dyno across runs (its authored path). */
  dynoId: string;
  dynoPath: string;
  name: string | null;
  target: string;
  status: RunUploadStatus;
  scenarioCount: number;
  jobCount: number;
  assertionCount: number;
  passedAssertionCount: number;
  failedAssertionCount: number;
  warningCount: number;
  lastRunId: string;
  lastRunAt: string;
};

/** One scenario's results within a dyno for a selected run. */
export type DynoScenarioResult = {
  scenarioId: string;
  scenarioName: string;
  status: RunUploadStatus;
  jobCount: number;
  passedJobCount: number;
  failedJobCount: number;
  assertionCount: number;
  passedAssertionCount: number;
  failedAssertionCount: number;
  warningCount: number;
  durationMs: number;
  jobs: RunJobDetail[];
};

/** A dyno's results scoped to a single selected run. */
export type DynoRunDetail = {
  runId: string;
  createdAt: string;
  status: RunUploadStatus;
  gitHash: string | null;
  cliVersion: string;
  harnesses: string[];
  scenarioCount: number;
  jobCount: number;
  assertionCount: number;
  passedAssertionCount: number;
  failedAssertionCount: number;
  warningCount: number;
  durationMs: number;
  scenarios: DynoScenarioResult[];
};

export type DynoRunRef = {
  runId: string;
  createdAt: string;
  status: RunUploadStatus;
  gitHash: string | null;
};

export type RunUploadResponse = {
  id: string;
  url: string;
};

export type RunListResponse = {
  runs: RunSummary[];
};

export type RunDetailResponse = {
  run: RunDetail;
};

export type RunUpdateResponse = {
  run: RunSummary;
};

export type TargetListResponse = {
  targets: TargetSummary[];
};

export type TargetDetailResponse = {
  target: string;
  dynos: TargetDynoSummary[];
};

export type DynoDetailResponse = {
  dynoId: string;
  dynoPath: string;
  name: string | null;
  target: string;
  /** Runs that included this dyno, newest first (selector options). */
  runs: DynoRunRef[];
  /** The selected run's results, or null when the run has no data. */
  run: DynoRunDetail | null;
};
