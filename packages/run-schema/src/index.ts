import {z} from 'zod';

export const RUN_UPLOAD_V2_SCHEMA_VERSION = 2 as const;
export const RUN_UPLOAD_SCHEMA_VERSION = 3 as const;

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
  harnessVersionLength: 128,
  assertionIdLength: 512,
  assertionLabelLength: 512,
  assertionTypeLength: 64,
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
const assertionMatcherString = z
  .string()
  .min(1)
  .max(RUN_UPLOAD_LIMITS.assertionDetailLength)
  .nullable()
  .optional();
const verifyAssertionMatcherString = z
  .string()
  .max(RUN_UPLOAD_LIMITS.assertionDetailLength)
  .nullable()
  .optional();

const assertionMatcherSchema = z
  .object({
    equals: assertionMatcherString,
    includes: assertionMatcherString,
    startsWith: assertionMatcherString,
    matches: assertionMatcherString,
  })
  .strict();

const verifyAssertionMatcherSchema = z
  .object({
    equals: verifyAssertionMatcherString,
    includes: verifyAssertionMatcherString,
    startsWith: verifyAssertionMatcherString,
    matches: verifyAssertionMatcherString,
  })
  .strict();

const regexPatternSchema = z
  .object({
    source: assertionDetailString,
    flags: z.string().max(16),
  })
  .strict();

const commandMatcherSchema = z
  .object({
    args: z
      .array(assertionDetailString)
      .max(RUN_UPLOAD_LIMITS.assertionChildren)
      .optional(),
    argsInOrder: z
      .array(assertionDetailString)
      .max(RUN_UPLOAD_LIMITS.assertionChildren)
      .optional(),
    argsMatching: z
      .array(regexPatternSchema)
      .max(RUN_UPLOAD_LIMITS.assertionChildren)
      .optional(),
    originalIncludes: assertionDetailString.optional(),
    originalMatches: regexPatternSchema.optional(),
  })
  .strict();

const assertionCommandDetailSchema = z.union([
  assertionMatcherSchema,
  commandMatcherSchema,
  assertionDetailString,
]);

const runUploadAssertionDefinitionNodeV2Schema = z
  .object({
    type: z.string().min(1).max(RUN_UPLOAD_LIMITS.assertionTypeLength),
    tool: optionalNullableString(RUN_UPLOAD_LIMITS.assertionTypeLength),
    executable: optionalNullableString(RUN_UPLOAD_LIMITS.assertionDetailLength),
    command: assertionCommandDetailSchema.optional(),
    endpointId: optionalNullableString(RUN_UPLOAD_LIMITS.assertionDetailLength),
    status: z.number().int().optional(),
    skill: optionalNullableString(RUN_UPLOAD_LIMITS.assertionDetailLength),
    exitCode: z.number().int().optional(),
    stdout: verifyAssertionMatcherSchema.optional(),
    stderr: verifyAssertionMatcherSchema.optional(),
    path: optionalNullableString(RUN_UPLOAD_LIMITS.assertionDetailLength),
    text: optionalNullableString(RUN_UPLOAD_LIMITS.assertionDetailLength),
  })
  .strict();

export const runUploadAssertionDefinitionV2Schema =
  runUploadAssertionDefinitionNodeV2Schema
    .extend({
      steps: z
        .array(runUploadAssertionDefinitionNodeV2Schema)
        .max(RUN_UPLOAD_LIMITS.assertionChildren)
        .optional(),
    })
    .strict();

export const runUploadAssertionDisplayChildV2Schema = z
  .object({
    index: z.number().int().positive(),
    type: z.string().min(1).max(RUN_UPLOAD_LIMITS.assertionTypeLength),
    title: assertionDetailString,
    expectation: assertionDetailString,
    observed: optionalNullableString(RUN_UPLOAD_LIMITS.assertionDetailLength),
    passed: z.boolean().nullable(),
  })
  .strict();

export const runUploadAssertionDisplayV2Schema = z
  .object({
    title: assertionDetailString,
    expectation: assertionDetailString,
    observed: optionalNullableString(RUN_UPLOAD_LIMITS.assertionDetailLength),
    children: z
      .array(runUploadAssertionDisplayChildV2Schema)
      .max(RUN_UPLOAD_LIMITS.assertionChildren),
  })
  .strict();

export const runUploadAssertionEvidenceV2Schema = z
  .object({
    observedCount: countSchema.optional(),
    matchedCount: countSchema.optional(),
    matchedBranchIndex: z.number().int().positive().optional(),
    observedKinds: z
      .array(z.string().min(1).max(RUN_UPLOAD_LIMITS.assertionTypeLength))
      .max(RUN_UPLOAD_LIMITS.evidenceItems)
      .optional(),
    matches: z
      .array(assertionDetailString)
      .max(RUN_UPLOAD_LIMITS.evidenceItems)
      .optional(),
  })
  .strict();

export const runUploadTotalsV2Schema = z
  .object({
    jobs: countSchema,
    passed: countSchema,
    failed: countSchema,
    warnings: countSchema,
    durationMs: durationMsSchema,
  })
  .strict();

export const runUploadAssertionV2Schema = z
  .object({
    assertionId: z.string().min(1).max(RUN_UPLOAD_LIMITS.assertionIdLength),
    label: z.string().min(1).max(RUN_UPLOAD_LIMITS.assertionLabelLength),
    type: z.string().min(1).max(RUN_UPLOAD_LIMITS.assertionTypeLength),
    passed: z.boolean(),
    message: z.string().min(1).max(RUN_UPLOAD_LIMITS.assertionMessageLength),
    definition: runUploadAssertionDefinitionV2Schema.optional(),
    display: runUploadAssertionDisplayV2Schema.optional(),
    evidence: runUploadAssertionEvidenceV2Schema.optional(),
  })
  .strict();

export const runUploadJobV2Schema = z
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
      .array(runUploadAssertionV2Schema)
      .max(RUN_UPLOAD_LIMITS.assertionsPerJob),
    diagnostics: z
      .array(z.string().min(1).max(RUN_UPLOAD_LIMITS.diagnosticLength))
      .max(RUN_UPLOAD_LIMITS.diagnosticsPerJob),
    warnings: z
      .array(z.string().min(1).max(RUN_UPLOAD_LIMITS.warningLength))
      .max(RUN_UPLOAD_LIMITS.warningsPerJob),
  })
  .strict();

export const runUploadJobV3Schema = runUploadJobV2Schema
  .extend({
    harness: z
      .object({
        id: z.string().min(1).max(RUN_UPLOAD_LIMITS.harnessIdLength),
        model: optionalNullableString(RUN_UPLOAD_LIMITS.modelLength),
        version: z
          .string()
          .min(1)
          .max(RUN_UPLOAD_LIMITS.harnessVersionLength)
          .nullable(),
      })
      .strict(),
  })
  .strict();

/**
 * One authored `.dyno` test spec inside a run, grouped under the target it
 * tests. Jobs nest here so per-dyno totals stay self-describing.
 */
export const runUploadDynoV2Schema = z
  .object({
    dynoPath: z.string().min(1).max(RUN_UPLOAD_LIMITS.dynoPathLength),
    name: optionalNullableString(RUN_UPLOAD_LIMITS.dynoNameLength),
    target: z.string().min(1).max(RUN_UPLOAD_LIMITS.targetLength),
    status: z.enum(RUN_UPLOAD_STATUS),
    totals: runUploadTotalsV2Schema,
    jobs: z.array(runUploadJobV2Schema).max(RUN_UPLOAD_LIMITS.jobsPerDyno),
  })
  .strict();

export const runUploadDynoV3Schema = runUploadDynoV2Schema
  .extend({
    jobs: z.array(runUploadJobV3Schema).max(RUN_UPLOAD_LIMITS.jobsPerDyno),
  })
  .strict();

export const RunUploadV2 = z
  .object({
    schemaVersion: z.literal(RUN_UPLOAD_V2_SCHEMA_VERSION),
    createdAt: z.iso.datetime(),
    cliVersion: z.string().min(1).max(RUN_UPLOAD_LIMITS.cliVersionLength),
    gitHash: optionalNullableString(RUN_UPLOAD_LIMITS.gitHashLength),
    /** The path the CLI was pointed at (`dynobox run <inputPath>`). */
    inputPath: optionalNullableString(RUN_UPLOAD_LIMITS.inputPathLength),
    status: z.enum(RUN_UPLOAD_STATUS),
    totals: runUploadTotalsV2Schema,
    dynos: z.array(runUploadDynoV2Schema).max(RUN_UPLOAD_LIMITS.dynos),
  })
  .strict();

export const RunUploadV3 = RunUploadV2.extend({
  schemaVersion: z.literal(RUN_UPLOAD_SCHEMA_VERSION),
  dynos: z.array(runUploadDynoV3Schema).max(RUN_UPLOAD_LIMITS.dynos),
}).strict();

export const RunUpload = z.discriminatedUnion('schemaVersion', [
  RunUploadV2,
  RunUploadV3,
]);

export const RunSharingUpdate = z
  .object({
    public: z.boolean(),
  })
  .strict();

export type RunUploadStatus = (typeof RUN_UPLOAD_STATUS)[number];
export type RunUploadJobStatus = (typeof RUN_UPLOAD_JOB_STATUS)[number];
export type RunUploadTotalsV2 = z.infer<typeof runUploadTotalsV2Schema>;
export type RunUploadAssertionDefinitionV2 = z.infer<
  typeof runUploadAssertionDefinitionV2Schema
>;
export type RunUploadAssertionDisplayChildV2 = z.infer<
  typeof runUploadAssertionDisplayChildV2Schema
>;
export type RunUploadAssertionDisplayV2 = z.infer<
  typeof runUploadAssertionDisplayV2Schema
>;
export type RunUploadAssertionEvidenceV2 = z.infer<
  typeof runUploadAssertionEvidenceV2Schema
>;
export type RunUploadAssertionV2 = z.infer<typeof runUploadAssertionV2Schema>;
export type RunUploadJobV2 = z.infer<typeof runUploadJobV2Schema>;
export type RunUploadDynoV2 = z.infer<typeof runUploadDynoV2Schema>;
export type RunUploadV2 = z.infer<typeof RunUploadV2>;
export type RunUploadJobV3 = z.infer<typeof runUploadJobV3Schema>;
export type RunUploadDynoV3 = z.infer<typeof runUploadDynoV3Schema>;
export type RunUploadV3 = z.infer<typeof RunUploadV3>;
export type RunUpload = z.infer<typeof RunUpload>;
export type RunUploadSchemaVersion = RunUpload['schemaVersion'];

export type RunUploadCreateInputV2 = z.input<typeof RunUploadV2>;
export type RunUploadCreateInputV3 = z.input<typeof RunUploadV3>;

export type RunSharingUpdate = z.infer<typeof RunSharingUpdate>;

export type RunSummary = {
  id: string;
  url: string;
  createdAt: string;
  cliVersion: string;
  schemaVersion: RunUploadSchemaVersion;
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
  type: string;
  passed: boolean;
  message: string | null;
  definition: RunUploadAssertionDefinitionV2 | null;
  display: RunUploadAssertionDisplayV2 | null;
  evidence: RunUploadAssertionEvidenceV2 | null;
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
    version: string | null;
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
  summary: RunUploadTotalsV2;
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
