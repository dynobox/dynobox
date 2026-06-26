import {z} from 'zod';

import {
  isShellToolMatcher,
  type ShellToolMatcher,
  TOOL_KINDS,
} from '../types/brands.js';
import {
  IR_TOOL_MATCHER_MESSAGES,
  isToolAssertionKind,
  validateToolAssertionNode,
} from '../schema/toolMatcherValidation.js';
import {HARNESS_IDS, PERMISSION_MODES} from '../types/harness.js';
import {HTTP_METHODS} from '../types/httpMethod.js';

export const IR_VERSION = '0.2' as const;

export const irVersionSchema = z.literal(IR_VERSION);

export const irEndpointSchema = z.object({
  id: z.string().min(1),
  key: z.string().min(1),
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
});

export const irHarnessConfigSchema = z.object({
  id: z.enum(HARNESS_IDS),
  model: z.string().min(1).optional(),
  permissionMode: z.enum(PERMISSION_MODES).optional(),
});

const shellToolMatcherSchema = z.custom<ShellToolMatcher>(isShellToolMatcher, {
  message:
    'Shell tool matcher must specify exactly one string field: equals, includes, startsWith, or matches.',
});

const textMatcherSchema = shellToolMatcherSchema;

const toolPathMatcherSchema = z.object({
  path: z.string().min(1),
});

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

const irToolCalledAssertionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1).optional(),
  kind: z.literal('tool.called'),
  toolKind: z.enum(TOOL_KINDS),
  matcher: shellToolMatcherSchema.optional(),
  pathMatcher: toolPathMatcherSchema.optional(),
});

const irToolNotCalledAssertionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1).optional(),
  kind: z.literal('tool.notCalled'),
  toolKind: z.enum(TOOL_KINDS),
  matcher: shellToolMatcherSchema.optional(),
  pathMatcher: toolPathMatcherSchema.optional(),
});

const irCommandCalledAssertionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1).optional(),
  kind: z.literal('command.called'),
  executable: z.string().min(1),
  matcher: commandMatcherSchema.optional(),
});

const irCommandNotCalledAssertionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1).optional(),
  kind: z.literal('command.notCalled'),
  executable: z.string().min(1),
  matcher: commandMatcherSchema.optional(),
});

const irVerifyCommandAssertionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1).optional(),
  kind: z.literal('verify.command'),
  command: z.string().min(1),
  exitCode: z.number().int().optional(),
  stdout: textMatcherSchema.optional(),
  stderr: textMatcherSchema.optional(),
});

const irSequenceToolCalledStepSchema = z.object({
  kind: z.literal('tool.called'),
  toolKind: z.enum(TOOL_KINDS),
  matcher: shellToolMatcherSchema.optional(),
  pathMatcher: toolPathMatcherSchema.optional(),
});

const irSequenceCommandCalledStepSchema = z.object({
  kind: z.literal('command.called'),
  executable: z.string().min(1),
  matcher: commandMatcherSchema.optional(),
});

const irSequenceStepSchema = z.discriminatedUnion('kind', [
  irSequenceToolCalledStepSchema,
  irSequenceCommandCalledStepSchema,
]);

const irHttpCalledAssertionNodeSchema = z.object({
  kind: z.literal('http.called'),
  endpointId: z.string().min(1),
  status: z.number().int().optional(),
});

const irHttpNotCalledAssertionNodeSchema = z.object({
  kind: z.literal('http.notCalled'),
  endpointId: z.string().min(1),
});

const irArtifactExistsAssertionNodeSchema = z.object({
  kind: z.literal('artifact.exists'),
  path: z.string().min(1),
});

const irArtifactContainsAssertionNodeSchema = z.object({
  kind: z.literal('artifact.contains'),
  path: z.string().min(1),
  text: z.string(),
});

const irTranscriptContainsAssertionNodeSchema = z.object({
  kind: z.literal('transcript.contains'),
  text: z.string(),
});

const irFinalMessageContainsAssertionNodeSchema = z.object({
  kind: z.literal('finalMessage.contains'),
  text: z.string(),
});

const irSkillReferencedAssertionNodeSchema = z.object({
  kind: z.literal('skill.referenced'),
  skill: z.string().min(1),
});

const irAssertionNodeSchema = z
  .discriminatedUnion('kind', [
    irHttpCalledAssertionNodeSchema,
    irHttpNotCalledAssertionNodeSchema,
    irToolCalledAssertionSchema.omit({id: true, label: true}),
    irToolNotCalledAssertionSchema.omit({id: true, label: true}),
    irCommandCalledAssertionSchema.omit({id: true, label: true}),
    irCommandNotCalledAssertionSchema.omit({id: true, label: true}),
    irArtifactExistsAssertionNodeSchema,
    irArtifactContainsAssertionNodeSchema,
    irTranscriptContainsAssertionNodeSchema,
    irFinalMessageContainsAssertionNodeSchema,
    irSkillReferencedAssertionNodeSchema,
  ])
  .superRefine((assertion, ctx) => {
    validateIrAssertionNode(assertion, ctx, []);
  });

export const irAssertionSchema = z
  .discriminatedUnion('kind', [
    z.object({
      id: z.string().min(1),
      label: z.string().min(1).optional(),
      kind: z.literal('http.called'),
      endpointId: z.string().min(1),
      status: z.number().int().optional(),
    }),
    z.object({
      id: z.string().min(1),
      label: z.string().min(1).optional(),
      kind: z.literal('http.notCalled'),
      endpointId: z.string().min(1),
    }),
    irToolCalledAssertionSchema,
    irToolNotCalledAssertionSchema,
    irCommandCalledAssertionSchema,
    irCommandNotCalledAssertionSchema,
    irVerifyCommandAssertionSchema,
    z.object({
      id: z.string().min(1),
      label: z.string().min(1).optional(),
      kind: z.literal('artifact.exists'),
      path: z.string().min(1),
    }),
    z.object({
      id: z.string().min(1),
      label: z.string().min(1).optional(),
      kind: z.literal('artifact.contains'),
      path: z.string().min(1),
      text: z.string(),
    }),
    z.object({
      id: z.string().min(1),
      label: z.string().min(1).optional(),
      kind: z.literal('transcript.contains'),
      text: z.string(),
    }),
    z.object({
      id: z.string().min(1),
      label: z.string().min(1).optional(),
      kind: z.literal('finalMessage.contains'),
      text: z.string(),
    }),
    z.object({
      id: z.string().min(1),
      label: z.string().min(1).optional(),
      kind: z.literal('sequence.inOrder'),
      steps: z.array(irSequenceStepSchema).min(1),
    }),
    z.object({
      id: z.string().min(1),
      label: z.string().min(1).optional(),
      kind: z.literal('anyOf'),
      steps: z.array(irAssertionNodeSchema).min(1),
    }),
    z.object({
      id: z.string().min(1),
      label: z.string().min(1).optional(),
      kind: z.literal('skill.referenced'),
      skill: z.string().min(1),
    }),
  ])
  .superRefine((assertion, ctx) => {
    if (isToolAssertionKind(assertion.kind)) {
      validateToolAssertionNode(assertion, ctx, [], irToolMatcherOptions);
    }

    if (
      assertion.kind === 'verify.command' &&
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

    if (assertion.kind === 'sequence.inOrder') {
      assertion.steps.forEach((step, index) => {
        validateIrSequenceStep(step, ctx, ['steps', index]);
      });
    }
  });

const irToolMatcherOptions = {
  kindField: 'kind' as const,
  toolKindField: 'toolKind',
  shellMatcherField: 'matcher',
  pathMatcherField: 'pathMatcher',
  fieldPaths: {shellMatcher: 'matcher', pathMatcher: 'pathMatcher'},
  messages: IR_TOOL_MATCHER_MESSAGES,
};

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

function validateIrToolNode(
  assertion: unknown,
  ctx: z.RefinementCtx,
  path: (string | number)[],
): void {
  validateToolAssertionNode(assertion, ctx, path, irToolMatcherOptions);
}

export const irScenarioSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  prompt: z.string().min(1),
  harnesses: z.array(irHarnessConfigSchema).min(1),
  setup: z.array(z.string().min(1)),
  fixtures: z.array(z.string().min(1)),
  endpoints: z.array(irEndpointSchema),
  assertions: z.array(irAssertionSchema),
});

export const irSchema = z.object({
  version: irVersionSchema,
  name: z.string().optional(),
  target: z.string().optional(),
  scenarios: z.array(irScenarioSchema).min(1),
});
