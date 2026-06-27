import {z} from 'zod';

import {
  type Endpoint,
  isShellCommandMatcher,
  type ShellCommandMatcher,
  TOOL_KINDS,
} from '../types/brands.js';
import {HARNESS_IDS, PERMISSION_MODES} from '../types/harness.js';
import {HTTP_METHODS} from '../types/httpMethod.js';
import {
  isToolAssertionKind,
  SHELL_COMMAND_MATCHER_SHAPE_MESSAGE,
  TOOL_MATCHER_MESSAGES,
  validateToolAssertionNode,
} from './toolMatcherValidation.js';

const endpointKeySchema = z
  .string()
  .regex(
    /^[A-Za-z0-9_-]+$/,
    'Endpoint keys may only contain letters, numbers, underscores, and hyphens.',
  );

const authoredIdSchema = z
  .string()
  .min(1)
  .regex(
    /^[A-Za-z0-9._-]+$/,
    'IDs may only contain letters, numbers, dots, underscores, and hyphens.',
  );

const assertionBaseSchema = z.object({
  id: authoredIdSchema.optional(),
  label: z.string().min(1).optional(),
});

/**
 * Zod schemas for structural validation of authored configs.
 *
 * Semantic checks (e.g. assertion endpoint references) happen in `compile`,
 * which has access to the merged endpoint set. These schemas only enforce
 * shape.
 *
 * Assertion object schemas are strict so legacy authoring fields fail fast
 * instead of being silently ignored.
 */

export const endpointSchema: z.ZodType<Endpoint> = z
  .object({
    method: z.enum(HTTP_METHODS),
    url: z.url(),
    headers: z.record(z.string(), z.string()).optional(),
    body: z.unknown().optional(),
    response: z
      .object({
        status: z.number().int().optional(),
        headers: z.record(z.string(), z.string()).optional(),
        body: z.unknown().optional(),
      })
      .optional(),
  })
  .loose() as unknown as z.ZodType<Endpoint>;

const harnessRunConfigSchema = z.union([
  z.enum(HARNESS_IDS),
  z.object({
    id: z.enum(HARNESS_IDS),
    model: z.string().min(1).optional(),
    permissionMode: z.enum(PERMISSION_MODES).optional(),
  }),
]);

const calledAssertionSchema = z
  .object({
    type: z.literal('http.called'),
    endpoint: z.string(),
    status: z.number().int().optional(),
  })
  .merge(assertionBaseSchema)
  .strict();

const notCalledAssertionSchema = z
  .object({
    type: z.literal('http.notCalled'),
    endpoint: z.string(),
  })
  .merge(assertionBaseSchema)
  .strict();

const shellCommandMatcherSchema = z.custom<ShellCommandMatcher>(
  isShellCommandMatcher,
  {
    message: SHELL_COMMAND_MATCHER_SHAPE_MESSAGE,
  },
);

const textMatcherSchema = shellCommandMatcherSchema;

const commandMatcherSchema = z
  .object({
    args: z.array(z.string()).optional(),
    argsInOrder: z.array(z.string()).optional(),
    argsMatching: z.array(z.instanceof(RegExp)).optional(),
    originalIncludes: z.string().optional(),
    originalMatches: z.instanceof(RegExp).optional(),
  })
  .strict()
  .refine((matcher) => Object.keys(matcher).length > 0, {
    message: 'Command matcher must specify at least one matcher field.',
  });

const toolCalledStepSchema = z
  .object({
    type: z.literal('tool.called'),
    tool: z.enum(TOOL_KINDS),
    command: shellCommandMatcherSchema.optional(),
    path: z.string().min(1).optional(),
  })
  .strict();

const toolCalledAssertionSchema = toolCalledStepSchema
  .merge(assertionBaseSchema)
  .strict();

const commandCalledStepSchema = z
  .object({
    type: z.literal('command.called'),
    executable: z.string().min(1),
    command: commandMatcherSchema.optional(),
  })
  .strict();

const commandCalledAssertionSchema = commandCalledStepSchema
  .merge(assertionBaseSchema)
  .strict();

const sequenceStepSchema = z.discriminatedUnion('type', [
  toolCalledStepSchema,
  commandCalledStepSchema,
]);

const commandNotCalledAssertionSchema = z
  .object({
    type: z.literal('command.notCalled'),
    executable: z.string().min(1),
    command: commandMatcherSchema.optional(),
  })
  .merge(assertionBaseSchema)
  .strict();

const verifyCommandAssertionSchema = z
  .object({
    type: z.literal('verify.command'),
    command: z.string().min(1),
    exitCode: z.number().int().optional(),
    stdout: textMatcherSchema.optional(),
    stderr: textMatcherSchema.optional(),
  })
  .merge(assertionBaseSchema)
  .strict()
  .refine(
    (assertion) =>
      assertion.exitCode !== undefined ||
      assertion.stdout !== undefined ||
      assertion.stderr !== undefined,
    {
      message:
        'Verify command assertions must specify exitCode, stdout, or stderr.',
    },
  );

const toolNotCalledAssertionSchema = z
  .object({
    type: z.literal('tool.notCalled'),
    tool: z.enum(TOOL_KINDS),
    command: shellCommandMatcherSchema.optional(),
    path: z.string().min(1).optional(),
  })
  .merge(assertionBaseSchema)
  .strict();

const artifactExistsAssertionSchema = z
  .object({
    type: z.literal('artifact.exists'),
    path: z.string().min(1),
  })
  .merge(assertionBaseSchema)
  .strict();

const artifactContainsAssertionSchema = z
  .object({
    type: z.literal('artifact.contains'),
    path: z.string().min(1),
    text: z.string(),
  })
  .merge(assertionBaseSchema)
  .strict();

const transcriptContainsAssertionSchema = z
  .object({
    type: z.literal('transcript.contains'),
    text: z.string(),
  })
  .merge(assertionBaseSchema)
  .strict();

const finalMessageContainsAssertionSchema = z
  .object({
    type: z.literal('finalMessage.contains'),
    text: z.string(),
  })
  .merge(assertionBaseSchema)
  .strict();

const sequenceInOrderAssertionSchema = z
  .object({
    type: z.literal('sequence.inOrder'),
    steps: z.array(sequenceStepSchema).min(1),
  })
  .merge(assertionBaseSchema)
  .strict();

const skillReferencedAssertionSchema = z
  .object({
    type: z.literal('skill.referenced'),
    skill: z.string().min(1),
  })
  .merge(assertionBaseSchema)
  .strict();

const anyOfBranchAssertionSchema = z.discriminatedUnion('type', [
  calledAssertionSchema,
  notCalledAssertionSchema,
  commandCalledAssertionSchema,
  commandNotCalledAssertionSchema,
  toolCalledAssertionSchema,
  toolNotCalledAssertionSchema,
  artifactExistsAssertionSchema,
  artifactContainsAssertionSchema,
  transcriptContainsAssertionSchema,
  finalMessageContainsAssertionSchema,
  skillReferencedAssertionSchema,
]);

const anyOfAssertionSchema = z
  .object({
    type: z.literal('anyOf'),
    steps: z.array(anyOfBranchAssertionSchema).min(1),
  })
  .merge(assertionBaseSchema)
  .strict();

const authoringToolMatcherOptions = {
  kindField: 'type' as const,
  toolKindField: 'tool',
  shellMatcherField: 'command',
  pathMatcherField: 'path',
  fieldPaths: {shellMatcher: 'command', pathMatcher: 'path'},
  messages: TOOL_MATCHER_MESSAGES,
};

export const assertionSchema = z
  .discriminatedUnion('type', [
    calledAssertionSchema,
    notCalledAssertionSchema,
    commandCalledAssertionSchema,
    commandNotCalledAssertionSchema,
    verifyCommandAssertionSchema,
    toolCalledAssertionSchema,
    toolNotCalledAssertionSchema,
    artifactExistsAssertionSchema,
    artifactContainsAssertionSchema,
    transcriptContainsAssertionSchema,
    finalMessageContainsAssertionSchema,
    sequenceInOrderAssertionSchema,
    anyOfAssertionSchema,
    skillReferencedAssertionSchema,
  ])
  .superRefine((value, ctx) => {
    if (isToolAssertionKind(value.type)) {
      validateToolAssertionNode(value, ctx, [], authoringToolMatcherOptions);
    }

    if (value.type === 'sequence.inOrder') {
      value.steps.forEach((step, index) => {
        validateSequenceStep(step, ctx, ['steps', index]);
      });
    }

    if (value.type === 'anyOf') {
      validateAnyOfAssertion(value, ctx, ['steps']);
    }
  });

export type AuthoredAssertion = z.infer<typeof assertionSchema>;

function validateAnyOfAssertion(
  assertion: Extract<AuthoredAssertion, {type: 'anyOf'}>,
  ctx: z.RefinementCtx,
  path: (string | number)[],
): void {
  assertion.steps.forEach((step, index) => {
    rejectBranchMetadata(step, ctx, [...path, index]);
    validateToolAssertion(step, ctx, [...path, index]);
  });
}

// `id`/`label` are accepted by the shared branch schemas but discarded when
// compiling a branch to IR, so they cannot affect IR, evidence, or UI. Reject
// them rather than silently dropping them; labeling belongs on the anyOf itself.
function rejectBranchMetadata(
  step: {id?: string | undefined; label?: string | undefined},
  ctx: z.RefinementCtx,
  path: (string | number)[],
): void {
  if (step.id !== undefined) {
    ctx.addIssue({
      code: 'custom',
      path: [...path, 'id'],
      message:
        'anyOf branches may not define an id; ids are only supported on top-level assertions.',
    });
  }
  if (step.label !== undefined) {
    ctx.addIssue({
      code: 'custom',
      path: [...path, 'label'],
      message:
        'anyOf branches may not define a label; labels are only supported on top-level assertions.',
    });
  }
}

function validateSequenceStep(
  step: unknown,
  ctx: z.RefinementCtx,
  path: (string | number)[],
): void {
  validateToolAssertion(step, ctx, path);
}

function validateToolAssertion(
  assertion: unknown,
  ctx: z.RefinementCtx,
  path: (string | number)[],
): void {
  validateToolAssertionNode(assertion, ctx, path, authoringToolMatcherOptions);
}

export const scenarioSchema = z.object({
  id: authoredIdSchema.optional(),
  name: z.string().min(1),
  prompt: z.string().min(1),
  harnesses: z.array(harnessRunConfigSchema).min(1).optional(),
  setup: z.array(z.string().min(1)).optional(),
  fixtures: z.union([z.string().min(1), z.array(z.string().min(1))]).optional(),
  endpoints: z.record(endpointKeySchema, endpointSchema).optional(),
  assertions: z.array(assertionSchema).optional(),
});

export const configSchema = z.object({
  name: z.string().optional(),
  target: z.string().min(1).optional(),
  version: z.string().optional(),
  harnesses: z.array(harnessRunConfigSchema).min(1).optional(),
  setup: z.array(z.string().min(1)).optional(),
  endpoints: z.record(endpointKeySchema, endpointSchema).optional(),
  scenarios: z.array(scenarioSchema).min(1),
});
