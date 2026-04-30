import {z} from 'zod';

import {
  isShellToolMatcher,
  TOOL_KINDS,
  type Endpoint,
  type ShellToolMatcher,
} from '../types/brands.js';
import {HARNESS_IDS} from '../types/harness.js';
import {HTTP_METHODS} from '../types/http-method.js';

/**
 * Zod schemas for structural validation of authored configs.
 *
 * Semantic checks (e.g. assertion endpoint references) happen in `compile`,
 * which has access to the merged endpoint set. These schemas only enforce
 * shape.
 *
 * Object schemas use `.loose()` so brand symbols on author-supplied objects
 * survive validation untouched.
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

const calledAssertionSchema = z
  .object({
    kind: z.literal('http.called'),
    endpoint: z.string(),
    status: z.number().int().optional(),
  })
  .loose();

const notCalledAssertionSchema = z
  .object({
    kind: z.literal('http.notCalled'),
    endpoint: z.string(),
  })
  .loose();

const shellToolMatcherSchema = z.custom<ShellToolMatcher>(isShellToolMatcher, {
  message:
    'Shell tool matcher must specify exactly one string field: equals, includes, startsWith, or matches.',
});

const toolCalledAssertionSchema = z
  .object({
    kind: z.literal('tool.called'),
    toolKind: z.enum(TOOL_KINDS),
    matcher: shellToolMatcherSchema.optional(),
  })
  .loose();

export const assertionSchema = z
  .discriminatedUnion('kind', [
    calledAssertionSchema,
    notCalledAssertionSchema,
    toolCalledAssertionSchema,
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

export const scenarioSchema = z.object({
  name: z.string().min(1),
  prompt: z.string().min(1),
  harness: z.enum(HARNESS_IDS).optional(),
  setup: z.array(z.string().min(1)).optional(),
  endpoints: z.record(z.string(), endpointSchema).optional(),
  assertions: z.array(assertionSchema).optional(),
});

export const configSchema = z.object({
  name: z.string().optional(),
  version: z.string().optional(),
  harness: z.enum(HARNESS_IDS).optional(),
  setup: z.array(z.string().min(1)).optional(),
  endpoints: z.record(z.string(), endpointSchema).optional(),
  scenarios: z.array(scenarioSchema).min(1),
});
