import {z} from 'zod';

import type {JsonObject, JsonValue} from '../types/mcp.js';

/** Reject values JSON serialization would change, omit, or fail to encode. */
function isJson(
  value: unknown,
  ancestors = new Set<object>(),
): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || ancestors.has(value)) return false;
  const array = Array.isArray(value);
  if (
    !array &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  )
    return false;
  ancestors.add(value);
  try {
    const keys = Reflect.ownKeys(value);
    if (array && keys.length !== value.length + 1) return false;
    return keys.every((key) => {
      if (array && key === 'length') return true;
      if (typeof key !== 'string') return false;
      if (
        array &&
        (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)
      )
        return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      return (
        descriptor.enumerable === true &&
        'value' in descriptor &&
        isJson(descriptor.value, ancestors)
      );
    });
  } finally {
    ancestors.delete(value);
  }
}

export const mcpJsonObjectSchema = z
  .custom<JsonObject>(
    (value) =>
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      isJson(value),
    'Expected a JSON-only object.',
  )
  .transform((value) => JSON.parse(JSON.stringify(value)) as JsonObject);

export const mcpNameSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/,
    'Expected a portable MCP name (1–128 letters, digits, dots, underscores, or hyphens, starting with a letter or digit).',
  );

export const mcpInputMatcherSchema = mcpJsonObjectSchema.refine(
  (value) => Object.keys(value).length > 0,
  'MCP input matchers must not be empty.',
);

export const mcpToolResultSchema = z
  .object({
    content: z.array(
      z.object({type: z.literal('text'), text: z.string()}).strict(),
    ),
    structuredContent: mcpJsonObjectSchema.optional(),
    isError: z.boolean().optional(),
  })
  .strict();

const toolShape = {
  description: z.string().optional(),
  inputSchema: mcpJsonObjectSchema.refine(
    (value) => value.type === 'object',
    "MCP inputSchema must have type: 'object'.",
  ),
};

const toolSchema = z.union([
  z.object({...toolShape, response: mcpToolResultSchema}).strict(),
  z
    .object({
      ...toolShape,
      responses: z.array(mcpToolResultSchema).min(1),
      onExhausted: z
        .union([
          z.literal('error'),
          z.literal('repeat-last'),
          mcpToolResultSchema,
        ])
        .optional(),
    })
    .strict(),
]);

/** Shared definition validation for authoring, IR, and the local controller. */
export const mcpMocksSchema = z.preprocess(
  (value, ctx) => {
    if (!isJson(value)) {
      ctx.addIssue({
        code: 'custom',
        message: 'MCP mock definitions must contain only JSON values.',
      });
      return z.NEVER;
    }
    return value;
  },
  z
    .record(
      mcpNameSchema,
      z
        .object({
          instructions: z.string().optional(),
          tools: z
            .record(mcpNameSchema, toolSchema)
            .refine(
              (value) => Object.keys(value).length > 0,
              'MCP servers must declare at least one tool.',
            ),
        })
        .strict(),
    )
    .refine(
      (value) => Object.keys(value).length > 0,
      'Declare at least one MCP mock server.',
    ),
);

type AssertionReference = {
  type: string;
  server?: string;
  tool?: string;
  steps?: readonly AssertionReference[];
};

/** Applies equally to plain YAML assertions and SDK helper output. */
export function validateMcpReferences(
  scenario: {
    mcpMocks?: Record<string, {tools: Record<string, unknown>}> | undefined;
    assertions?: readonly AssertionReference[] | undefined;
  },
  ctx: z.RefinementCtx,
): void {
  function visit(
    assertion: AssertionReference,
    path: (string | number)[],
  ): void {
    if (assertion.type === 'anyOf') {
      assertion.steps?.forEach((step, index) =>
        visit(step, [...path, 'steps', index]),
      );
    }
    if (assertion.type !== 'mcp.called' && assertion.type !== 'mcp.notCalled')
      return;
    const server = assertion.server;
    const tool = assertion.tool;
    const mocks = scenario.mcpMocks;
    if (
      server === undefined ||
      tool === undefined ||
      mocks === undefined ||
      !Object.hasOwn(mocks, server) ||
      !Object.hasOwn(mocks[server]!.tools, tool)
    ) {
      ctx.addIssue({
        code: 'custom',
        path,
        message:
          'MCP assertions must reference a declared mock server and tool.',
      });
    }
  }
  scenario.assertions?.forEach((assertion, index) =>
    visit(assertion, ['assertions', index]),
  );
}
