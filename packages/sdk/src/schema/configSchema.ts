import {z} from 'zod';

import {
  type Endpoint,
  type FileToolKind,
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

const commandNotCalledAssertionSchema = z
  .object({
    type: z.literal('command.notCalled'),
    executable: z.string().min(1),
    command: commandMatcherSchema.optional(),
  })
  .merge(assertionBaseSchema)
  .strict();

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
    steps: z
      .array(
        z.discriminatedUnion('type', [
          toolCalledStepSchema,
          commandCalledStepSchema,
        ]),
      )
      .min(1),
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

export const assertionSchema = z
  .discriminatedUnion('type', [
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
    sequenceInOrderAssertionSchema,
    skillReferencedAssertionSchema,
  ])
  .superRefine((assertion, ctx) => {
    const fileToolKinds = new Set<FileToolKind>([
      'read_file',
      'write_file',
      'edit_file',
      'search_files',
    ]);

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

    if (
      (assertion.type === 'tool.called' ||
        assertion.type === 'tool.notCalled') &&
      assertion.path !== undefined &&
      !fileToolKinds.has(assertion.tool as FileToolKind)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['path'],
        message:
          'Path matchers are only supported for file-oriented tool assertions.',
      });
    }

    if (
      (assertion.type === 'tool.called' ||
        assertion.type === 'tool.notCalled') &&
      assertion.command !== undefined &&
      assertion.path !== undefined
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['path'],
        message: 'Tool assertions may specify command or path, not both.',
      });
    }

    if (assertion.type === 'sequence.inOrder') {
      assertion.steps.forEach((step, index) => {
        if (step.type !== 'tool.called') return;

        if (step.command !== undefined && step.tool !== 'shell') {
          ctx.addIssue({
            code: 'custom',
            path: ['steps', index, 'command'],
            message:
              'Command matchers are only supported for shell tool assertions.',
          });
        }

        if (
          step.path !== undefined &&
          !fileToolKinds.has(step.tool as FileToolKind)
        ) {
          ctx.addIssue({
            code: 'custom',
            path: ['steps', index, 'path'],
            message:
              'Path matchers are only supported for file-oriented tool assertions.',
          });
        }

        if (step.command !== undefined && step.path !== undefined) {
          ctx.addIssue({
            code: 'custom',
            path: ['steps', index, 'path'],
            message: 'Tool assertions may specify command or path, not both.',
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
