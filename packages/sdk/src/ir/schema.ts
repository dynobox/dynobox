import {z} from 'zod';

import {
  isToolAssertionKind,
  SHELL_COMMAND_MATCHER_SHAPE_MESSAGE,
  TOOL_MATCHER_MESSAGES,
  validateToolAssertionNode,
} from '../schema/toolMatcherValidation.js';
import {
  isShellCommandMatcher,
  type ShellCommandMatcher,
  TOOL_KINDS,
} from '../types/brands.js';
import type {CliMockHandlerContext, CliMockResponse} from '../types/config.js';
import {HARNESS_IDS, PERMISSION_MODES} from '../types/harness.js';
import {HTTP_METHODS} from '../types/httpMethod.js';

export const IR_VERSION = '0.3' as const;

export const irVersionSchema = z.literal(IR_VERSION);

export const irEndpointSchema = z.object({
  id: z.string().min(1),
  key: z.string().min(1),
  method: z.enum(HTTP_METHODS),
  url: z.url(),
});

export const irHarnessConfigSchema = z.object({
  id: z.enum(HARNESS_IDS),
  model: z.string().min(1).optional(),
  permissionMode: z.enum(PERMISSION_MODES).optional(),
});

const cliMockExecutableSchema = z
  .string()
  .min(1, 'CLI mock executable names may not be empty.')
  .refine(
    (value) =>
      value !== '.' &&
      value !== '..' &&
      !value.includes('/') &&
      !value.includes('\\') &&
      !value.includes('\0'),
    'CLI mock executable names must be bare executable names without path separators or null bytes.',
  );

const irCliMockResponseSchema = z
  .object({
    exitCode: z.number().int().min(0).max(255),
    stdout: z.string(),
    stderr: z.string(),
  })
  .strict();

const cliMockHandlerSchema = z.custom<
  (context: CliMockHandlerContext) => CliMockResponse | Promise<CliMockResponse>
>((value) => typeof value === 'function', {
  message: 'CLI mock handlers must be functions.',
});

const irCliMockConfigSchema = z.union([
  z
    .object({
      response: irCliMockResponseSchema,
    })
    .strict(),
  z
    .object({
      responses: z.array(irCliMockResponseSchema).min(1),
      onExhausted: z.union([
        z.literal('error'),
        z.literal('repeat-last'),
        irCliMockResponseSchema,
      ]),
    })
    .strict(),
  z
    .object({
      handler: cliMockHandlerSchema,
    })
    .strict(),
]);

const shellCommandMatcherSchema = z.custom<ShellCommandMatcher>(
  isShellCommandMatcher,
  {
    message: SHELL_COMMAND_MATCHER_SHAPE_MESSAGE,
  },
);

const textMatcherSchema = shellCommandMatcherSchema;

const regexPatternSchema = z.object({
  source: z.string(),
  flags: z.string(),
});

const commandMatcherSchema = z.object({
  args: z.array(z.string()).optional(),
  argsInOrder: z.array(z.string()).optional(),
  argsMatching: z.array(regexPatternSchema).optional(),
  originalIncludes: z.string().optional(),
  originalMatches: regexPatternSchema.optional(),
});

const irAssertionBaseSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1).optional(),
});

const irHttpCalledAssertionNodeSchema = z.object({
  type: z.literal('http.called'),
  endpointId: z.string().min(1),
  status: z.number().int().optional(),
});

const irHttpCalledAssertionSchema = irAssertionBaseSchema.merge(
  irHttpCalledAssertionNodeSchema,
);

const irHttpNotCalledAssertionNodeSchema = z.object({
  type: z.literal('http.notCalled'),
  endpointId: z.string().min(1),
});

const irHttpNotCalledAssertionSchema = irAssertionBaseSchema.merge(
  irHttpNotCalledAssertionNodeSchema,
);

const irToolCalledAssertionNodeSchema = z.object({
  type: z.literal('tool.called'),
  tool: z.enum(TOOL_KINDS),
  command: shellCommandMatcherSchema.optional(),
  path: z.string().min(1).optional(),
});

const irToolCalledAssertionSchema = irAssertionBaseSchema.merge(
  irToolCalledAssertionNodeSchema,
);

const irToolNotCalledAssertionNodeSchema = z.object({
  type: z.literal('tool.notCalled'),
  tool: z.enum(TOOL_KINDS),
  command: shellCommandMatcherSchema.optional(),
  path: z.string().min(1).optional(),
});

const irToolNotCalledAssertionSchema = irAssertionBaseSchema.merge(
  irToolNotCalledAssertionNodeSchema,
);

const irCommandCalledAssertionNodeSchema = z.object({
  type: z.literal('command.called'),
  executable: z.string().min(1),
  command: commandMatcherSchema.optional(),
});

const irCommandCalledAssertionSchema = irAssertionBaseSchema.merge(
  irCommandCalledAssertionNodeSchema,
);

const irCommandNotCalledAssertionNodeSchema = z.object({
  type: z.literal('command.notCalled'),
  executable: z.string().min(1),
  command: commandMatcherSchema.optional(),
});

const irCommandNotCalledAssertionSchema = irAssertionBaseSchema.merge(
  irCommandNotCalledAssertionNodeSchema,
);

const irVerifyCommandAssertionNodeSchema = z.object({
  type: z.literal('verify.command'),
  command: z.string().min(1),
  exitCode: z.number().int().optional(),
  stdout: textMatcherSchema.optional(),
  stderr: textMatcherSchema.optional(),
});

const irVerifyCommandAssertionSchema = irAssertionBaseSchema.merge(
  irVerifyCommandAssertionNodeSchema,
);

const irSequenceStepSchema = z.discriminatedUnion('type', [
  irToolCalledAssertionNodeSchema,
  irCommandCalledAssertionNodeSchema,
]);

const irArtifactExistsAssertionNodeSchema = z.object({
  type: z.literal('artifact.exists'),
  path: z.string().min(1),
});

const irArtifactExistsAssertionSchema = irAssertionBaseSchema.merge(
  irArtifactExistsAssertionNodeSchema,
);

const irArtifactNotExistsAssertionNodeSchema = z.object({
  type: z.literal('artifact.notExists'),
  path: z.string().min(1),
});

const irArtifactNotExistsAssertionSchema = irAssertionBaseSchema.merge(
  irArtifactNotExistsAssertionNodeSchema,
);

const irArtifactContainsAssertionNodeSchema = z.object({
  type: z.literal('artifact.contains'),
  path: z.string().min(1),
  text: z.string(),
});

const irArtifactContainsAssertionSchema = irAssertionBaseSchema.merge(
  irArtifactContainsAssertionNodeSchema,
);

const irArtifactUnchangedAssertionNodeSchema = z.object({
  type: z.literal('artifact.unchanged'),
  path: z.string().min(1),
});

const irArtifactUnchangedAssertionSchema = irAssertionBaseSchema.merge(
  irArtifactUnchangedAssertionNodeSchema,
);

const irTranscriptContainsAssertionNodeSchema = z.object({
  type: z.literal('transcript.contains'),
  text: z.string(),
});

const irTranscriptContainsAssertionSchema = irAssertionBaseSchema.merge(
  irTranscriptContainsAssertionNodeSchema,
);

const irFinalMessageContainsAssertionNodeSchema = z.object({
  type: z.literal('finalMessage.contains'),
  text: z.string(),
});

const irFinalMessageContainsAssertionSchema = irAssertionBaseSchema.merge(
  irFinalMessageContainsAssertionNodeSchema,
);

const irSequenceInOrderAssertionSchema = irAssertionBaseSchema.merge(
  z.object({
    type: z.literal('sequence.inOrder'),
    steps: z.array(irSequenceStepSchema).min(1),
  }),
);

const irSkillReferencedAssertionNodeSchema = z.object({
  type: z.literal('skill.referenced'),
  skill: z.string().min(1),
});

const irSkillReferencedAssertionSchema = irAssertionBaseSchema.merge(
  irSkillReferencedAssertionNodeSchema,
);

const irToolMatcherOptions = {
  kindField: 'type' as const,
  toolKindField: 'tool',
  shellMatcherField: 'command',
  pathMatcherField: 'path',
  messages: TOOL_MATCHER_MESSAGES,
};

function validateIrToolNode(
  assertion: unknown,
  ctx: z.RefinementCtx,
  path: (string | number)[],
): void {
  validateToolAssertionNode(assertion, ctx, path, irToolMatcherOptions);
}

function validateIrAssertionNode(
  assertion: unknown,
  ctx: z.RefinementCtx,
  path: (string | number)[],
): void {
  validateIrToolNode(assertion, ctx, path);
}

function validateIrSequenceStep(
  step: unknown,
  ctx: z.RefinementCtx,
  path: (string | number)[],
): void {
  validateIrToolNode(step, ctx, path);
}

const irAssertionNodeSchema = z
  .discriminatedUnion('type', [
    irHttpCalledAssertionNodeSchema,
    irHttpNotCalledAssertionNodeSchema,
    irToolCalledAssertionNodeSchema,
    irToolNotCalledAssertionNodeSchema,
    irCommandCalledAssertionNodeSchema,
    irCommandNotCalledAssertionNodeSchema,
    irVerifyCommandAssertionNodeSchema,
    irArtifactExistsAssertionNodeSchema,
    irArtifactNotExistsAssertionNodeSchema,
    irArtifactContainsAssertionNodeSchema,
    irArtifactUnchangedAssertionNodeSchema,
    irTranscriptContainsAssertionNodeSchema,
    irFinalMessageContainsAssertionNodeSchema,
    irSkillReferencedAssertionNodeSchema,
  ])
  .superRefine((assertion, ctx) => {
    validateIrAssertionNode(assertion, ctx, []);
    if (
      assertion.type === 'verify.command' &&
      assertion.exitCode === undefined &&
      assertion.stdout === undefined &&
      assertion.stderr === undefined
    ) {
      ctx.addIssue({
        code: 'custom',
        message:
          'Verify command assertions must specify exitCode, stdout, or stderr.',
      });
    }
  });

const irAnyOfAssertionSchema = irAssertionBaseSchema.merge(
  z.object({
    type: z.literal('anyOf'),
    steps: z.array(irAssertionNodeSchema).min(1),
  }),
);

export const irAssertionSchema = z
  .discriminatedUnion('type', [
    irHttpCalledAssertionSchema,
    irHttpNotCalledAssertionSchema,
    irToolCalledAssertionSchema,
    irToolNotCalledAssertionSchema,
    irCommandCalledAssertionSchema,
    irCommandNotCalledAssertionSchema,
    irVerifyCommandAssertionSchema,
    irArtifactExistsAssertionSchema,
    irArtifactNotExistsAssertionSchema,
    irArtifactContainsAssertionSchema,
    irArtifactUnchangedAssertionSchema,
    irTranscriptContainsAssertionSchema,
    irFinalMessageContainsAssertionSchema,
    irSequenceInOrderAssertionSchema,
    irAnyOfAssertionSchema,
    irSkillReferencedAssertionSchema,
  ])
  .superRefine((assertion, ctx) => {
    if (isToolAssertionKind(assertion.type)) {
      validateToolAssertionNode(assertion, ctx, [], irToolMatcherOptions);
    }

    if (
      assertion.type === 'verify.command' &&
      assertion.exitCode === undefined &&
      assertion.stdout === undefined &&
      assertion.stderr === undefined
    ) {
      ctx.addIssue({
        code: 'custom',
        message:
          'Verify command assertions must specify exitCode, stdout, or stderr.',
      });
    }

    if (assertion.type === 'sequence.inOrder') {
      assertion.steps.forEach((step, index) => {
        validateIrSequenceStep(step, ctx, ['steps', index]);
      });
    }
  });

export const irScenarioSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  prompt: z.string().min(1),
  harnesses: z.array(irHarnessConfigSchema).min(1),
  setup: z.array(z.string().min(1)),
  fixtures: z.array(z.string().min(1)),
  cliMocks: z
    .record(cliMockExecutableSchema, irCliMockConfigSchema)
    .default({}),
  endpoints: z.array(irEndpointSchema),
  assertions: z.array(irAssertionSchema),
});

export const irSchema = z.object({
  version: irVersionSchema,
  name: z.string().optional(),
  target: z.string().optional(),
  scenarios: z.array(irScenarioSchema).min(1),
});
