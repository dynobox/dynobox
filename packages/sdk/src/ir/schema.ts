import {z} from 'zod';

import {
  isShellToolMatcher,
  TOOL_KINDS,
  type ShellToolMatcher,
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
    z.object({
      id: z.string().min(1),
      kind: z.literal('tool.called'),
      toolKind: z.enum(TOOL_KINDS),
      matcher: shellToolMatcherSchema.optional(),
    }),
  ])
  .superRefine((assertion, ctx) => {
    if (
      assertion.kind === 'tool.called' &&
      assertion.matcher !== undefined &&
      assertion.toolKind !== 'shell'
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['matcher'],
        message:
          'Tool assertion matchers are only supported for tool.called("shell", matcher).',
      });
    }
  });

export const irScenarioSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  prompt: z.string().min(1),
  harness: z.enum(HARNESS_IDS),
  setup: z.array(z.string().min(1)),
  endpoints: z.array(irEndpointSchema),
  assertions: z.array(irAssertionSchema),
});

export const irSchema = z.object({
  version: irVersionSchema,
  name: z.string().optional(),
  scenarios: z.array(irScenarioSchema).min(1),
});
