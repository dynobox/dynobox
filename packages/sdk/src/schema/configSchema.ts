import {z} from 'zod';

import {
  type Endpoint,
  isShellCommandMatcher,
  type ShellCommandMatcher,
  TOOL_KINDS,
} from '../types/brands.js';
import {HARNESS_IDS, PERMISSION_MODES} from '../types/harness.js';
import {HTTP_METHODS} from '../types/httpMethod.js';

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
    message:
      'Shell command matcher must specify exactly one string field: equals, includes, startsWith, or matches.',
  },
);

const toolCalledStepSchema = z
  .object({
    type: z.literal('tool.called'),
    tool: z.enum(TOOL_KINDS),
    command: shellCommandMatcherSchema.optional(),
  })
  .strict();

const toolCalledAssertionSchema = toolCalledStepSchema
  .merge(assertionBaseSchema)
  .strict();

const toolNotCalledAssertionSchema = z
  .object({
    type: z.literal('tool.notCalled'),
    tool: z.enum(TOOL_KINDS),
    command: shellCommandMatcherSchema.optional(),
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
    steps: z.array(toolCalledStepSchema).min(1),
  })
  .merge(assertionBaseSchema)
  .strict();

const skillInvokedAssertionSchema = z
  .object({
    type: z.literal('skill.invoked'),
    skill: z.string().min(1),
  })
  .merge(assertionBaseSchema)
  .strict();

export const assertionSchema = z
  .discriminatedUnion('type', [
    calledAssertionSchema,
    notCalledAssertionSchema,
    toolCalledAssertionSchema,
    toolNotCalledAssertionSchema,
    artifactExistsAssertionSchema,
    artifactContainsAssertionSchema,
    transcriptContainsAssertionSchema,
    finalMessageContainsAssertionSchema,
    sequenceInOrderAssertionSchema,
    skillInvokedAssertionSchema,
  ])
  .superRefine((assertion, ctx) => {
    if (
      (assertion.type === 'tool.called' ||
        assertion.type === 'tool.notCalled') &&
      assertion.command !== undefined &&
      assertion.tool !== 'shell'
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['command'],
        message:
          'Command matchers are only supported for shell tool assertions.',
      });
    }

    if (assertion.type === 'sequence.inOrder') {
      assertion.steps.forEach((step, index) => {
        if (step.command !== undefined && step.tool !== 'shell') {
          ctx.addIssue({
            code: 'custom',
            path: ['steps', index, 'command'],
            message:
              'Command matchers are only supported for shell tool assertions.',
          });
        }
      });
    }
  });

export const scenarioSchema = z.object({
  id: authoredIdSchema.optional(),
  name: z.string().min(1),
  prompt: z.string().min(1),
  harnesses: z.array(harnessRunConfigSchema).min(1).optional(),
  setup: z.array(z.string().min(1)).optional(),
  endpoints: z.record(endpointKeySchema, endpointSchema).optional(),
  assertions: z.array(assertionSchema).optional(),
});

export const configSchema = z.object({
  name: z.string().optional(),
  version: z.string().optional(),
  harnesses: z.array(harnessRunConfigSchema).min(1).optional(),
  setup: z.array(z.string().min(1)).optional(),
  endpoints: z.record(endpointKeySchema, endpointSchema).optional(),
  scenarios: z.array(scenarioSchema).min(1),
});
