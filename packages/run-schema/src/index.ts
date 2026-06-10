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
  targetLength: 256,
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
  jobs: 1_000,
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

export const RunUploadV1 = z
  .object({
    schemaVersion: z.literal(RUN_UPLOAD_SCHEMA_VERSION),
    createdAt: z.iso.datetime(),
    cliVersion: z.string().min(1).max(RUN_UPLOAD_LIMITS.cliVersionLength),
    gitHash: optionalNullableString(RUN_UPLOAD_LIMITS.gitHashLength),
    target: optionalNullableString(RUN_UPLOAD_LIMITS.targetLength),
    status: z.enum(RUN_UPLOAD_STATUS),
    totals: runUploadTotalsV1Schema,
    jobs: z.array(runUploadJobV1Schema).max(RUN_UPLOAD_LIMITS.jobs),
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
export type RunUploadV1 = z.infer<typeof RunUploadV1>;

export type RunUploadCreateInputV1 = z.input<typeof RunUploadV1>;

export type RunInsertV1 = Omit<RunUploadV1, 'jobs'> & {
  passCount: number;
  failCount: number;
  warningCount: number;
  summary: RunUploadTotalsV1;
};

export type RunJobInsertV1 = RunUploadJobV1 & {
  runId: string;
  assertionCount: number;
  passedAssertionCount: number;
  failedAssertionCount: number;
  warningCount: number;
};

export type RunAssertionInsertV1 = RunUploadAssertionV1 & {
  runId: string;
  jobId: string;
};

export type RunSharingUpdate = z.infer<typeof RunSharingUpdate>;

export type RunSummary = {
  id: string;
  url: string;
  createdAt: string;
  cliVersion: string;
  schemaVersion: typeof RUN_UPLOAD_SCHEMA_VERSION;
  gitHash: string | null;
  target: string | null;
  status: RunUploadStatus;
  passCount: number;
  failCount: number;
  warningCount: number;
  durationMs: number;
  public: boolean;
};

export type RunGitHashMetric = {
  gitHash: string | null;
  runCount: number;
  passCount: number;
  failCount: number;
  warningCount: number;
  durationMs: number;
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

export type RunJobDetail = {
  id: string;
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

export type RunUploadResponse = {
  id: string;
  url: string;
};

export type RunListResponse = {
  runs: RunSummary[];
  metrics: {
    byGitHash: RunGitHashMetric[];
  };
};

export type RunDetailResponse = {
  run: RunDetail;
};

export type RunUpdateResponse = {
  run: RunSummary;
};
