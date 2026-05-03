import {z} from 'zod';

import {
  isShellToolMatcher,
  type ShellToolMatcher,
  TOOL_KINDS,
} from '../types/brands.js';
import {HARNESS_IDS} from '../types/harness.js';
import {HTTP_METHODS} from '../types/http-method.js';

export const IR_VERSION = '0.1' as const;

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

const shellToolMatcherSchema = z.custom<ShellToolMatcher>(isShellToolMatcher, {
  message:
    'Shell tool matcher must specify exactly one string field: equals, includes, startsWith, or matches.',
});

const irToolCalledAssertionSchema = z.object({
  id: z.string().min(1),
  kind: z.literal('tool.called'),
  toolKind: z.enum(TOOL_KINDS),
  matcher: shellToolMatcherSchema.optional(),
});

const irToolNotCalledAssertionSchema = z.object({
  id: z.string().min(1),
  kind: z.literal('tool.notCalled'),
  toolKind: z.enum(TOOL_KINDS),
  matcher: shellToolMatcherSchema.optional(),
});

const irSequenceToolCalledStepSchema = z.object({
  kind: z.literal('tool.called'),
  toolKind: z.enum(TOOL_KINDS),
  matcher: shellToolMatcherSchema.optional(),
});

export const irAssertionSchema = z
  .discriminatedUnion('kind', [
    z.object({
      id: z.string().min(1),
      kind: z.literal('http.called'),
      endpointId: z.string().min(1),
      status: z.number().int().optional(),
    }),
    z.object({
      id: z.string().min(1),
      kind: z.literal('http.notCalled'),
      endpointId: z.string().min(1),
    }),
    irToolCalledAssertionSchema,
    irToolNotCalledAssertionSchema,
    z.object({
      id: z.string().min(1),
      kind: z.literal('artifact.exists'),
      path: z.string().min(1),
    }),
    z.object({
      id: z.string().min(1),
      kind: z.literal('artifact.contains'),
      path: z.string().min(1),
      text: z.string(),
    }),
    z.object({
      id: z.string().min(1),
      kind: z.literal('transcript.contains'),
      text: z.string(),
    }),
    z.object({
      id: z.string().min(1),
      kind: z.literal('finalMessage.contains'),
      text: z.string(),
    }),
    z.object({
      id: z.string().min(1),
      kind: z.literal('sequence.inOrder'),
      steps: z.array(irSequenceToolCalledStepSchema).min(1),
    }),
  ])
  .superRefine((assertion, ctx) => {
    if (
      (assertion.kind === 'tool.called' ||
        assertion.kind === 'tool.notCalled') &&
      assertion.matcher !== undefined &&
      assertion.toolKind !== 'shell'
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['matcher'],
        message:
          'Tool assertion matchers are only supported for shell tool assertions.',
      });
    }

    if (assertion.kind === 'sequence.inOrder') {
      assertion.steps.forEach((step, index) => {
        if (step.matcher !== undefined && step.toolKind !== 'shell') {
          ctx.addIssue({
            code: 'custom',
            path: ['steps', index, 'matcher'],
            message:
              'Tool assertion matchers are only supported for shell tool assertions.',
          });
        }
      });
    }
  });

export const irScenarioSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  prompt: z.string().min(1),
  harnesses: z.array(z.enum(HARNESS_IDS)).min(1),
  setup: z.array(z.string().min(1)),
  endpoints: z.array(irEndpointSchema),
  assertions: z.array(irAssertionSchema),
});

export const irSchema = z.object({
  version: irVersionSchema,
  name: z.string().optional(),
  scenarios: z.array(irScenarioSchema).min(1),
});
