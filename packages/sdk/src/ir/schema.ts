import {z} from 'zod';

import {
  type FileToolKind,
  isShellToolMatcher,
  type ShellToolMatcher,
  TOOL_KINDS,
} from '../types/brands.js';
import {HARNESS_IDS, PERMISSION_MODES} from '../types/harness.js';
import {HTTP_METHODS} from '../types/httpMethod.js';

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

export const irHarnessConfigSchema = z.object({
  id: z.enum(HARNESS_IDS),
  model: z.string().min(1).optional(),
  permissionMode: z.enum(PERMISSION_MODES).optional(),
});

const shellToolMatcherSchema = z.custom<ShellToolMatcher>(isShellToolMatcher, {
  message:
    'Shell tool matcher must specify exactly one string field: equals, includes, startsWith, or matches.',
});

const toolPathMatcherSchema = z.object({
  path: z.string().min(1),
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

const irSequenceToolCalledStepSchema = z.object({
  kind: z.literal('tool.called'),
  toolKind: z.enum(TOOL_KINDS),
  matcher: shellToolMatcherSchema.optional(),
  pathMatcher: toolPathMatcherSchema.optional(),
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
      steps: z.array(irSequenceToolCalledStepSchema).min(1),
    }),
    z.object({
      id: z.string().min(1),
      label: z.string().min(1).optional(),
      kind: z.literal('skill.invoked'),
      skill: z.string().min(1),
    }),
  ])
  .superRefine((assertion, ctx) => {
    const fileToolKinds = new Set<FileToolKind>([
      'read_file',
      'write_file',
      'edit_file',
      'search_files',
    ]);

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

    if (
      (assertion.kind === 'tool.called' ||
        assertion.kind === 'tool.notCalled') &&
      assertion.pathMatcher !== undefined &&
      !fileToolKinds.has(assertion.toolKind as FileToolKind)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['pathMatcher'],
        message:
          'Tool assertion path matchers are only supported for file-oriented tool assertions.',
      });
    }

    if (
      (assertion.kind === 'tool.called' ||
        assertion.kind === 'tool.notCalled') &&
      assertion.matcher !== undefined &&
      assertion.pathMatcher !== undefined
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['pathMatcher'],
        message:
          'Tool assertions may specify matcher or pathMatcher, not both.',
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

        if (
          step.pathMatcher !== undefined &&
          !fileToolKinds.has(step.toolKind as FileToolKind)
        ) {
          ctx.addIssue({
            code: 'custom',
            path: ['steps', index, 'pathMatcher'],
            message:
              'Tool assertion path matchers are only supported for file-oriented tool assertions.',
          });
        }

        if (step.matcher !== undefined && step.pathMatcher !== undefined) {
          ctx.addIssue({
            code: 'custom',
            path: ['steps', index, 'pathMatcher'],
            message:
              'Tool assertions may specify matcher or pathMatcher, not both.',
          });
        }
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
  endpoints: z.array(irEndpointSchema),
  assertions: z.array(irAssertionSchema),
});

export const irSchema = z.object({
  version: irVersionSchema,
  name: z.string().optional(),
  scenarios: z.array(irScenarioSchema).min(1),
});
