import {describe, expect, it} from 'vitest';

import {anyOf, defineDyno, mcp, sequence, verify} from '../index.js';
import {compile} from '../ir/compile.js';
import {irScenarioSchema, irSchema} from '../ir/schema.js';
import {scenarioSchema} from './configSchema.js';
import {mcpJsonObjectSchema, mcpMocksSchema} from './mcpMocks.js';

const response = {content: [{type: 'text' as const, text: 'receipt'}]};
const inputSchema = {
  type: 'object' as const,
  properties: {id: {type: 'string'}},
  required: ['id'],
};
const tool = {inputSchema, response};
const mocks = {linear: {tools: {save_issue: tool}}};

describe('MCP definitions', () => {
  it('accepts static, sequential, fallback, and intentional error responses', () => {
    const definitions = {
      linear: {
        instructions: 'Use these tools.',
        tools: {
          static: tool,
          sequence: {
            inputSchema,
            responses: [response, {content: [], isError: true}],
          },
          repeat: {
            inputSchema,
            responses: [response],
            onExhausted: 'repeat-last',
          },
          fallback: {
            inputSchema,
            responses: [response],
            onExhausted: {content: [], structuredContent: {ok: true}},
          },
        },
      },
    };
    expect(mcpMocksSchema.parse(definitions)).toEqual(definitions);
  });

  it.each([
    {},
    {linear: {tools: {}}},
    {'bad name': mocks.linear},
    {['a'.repeat(129)]: mocks.linear},
    {linear: {tools: {'-bad': tool}}},
    {linear: {tools: {save_issue: {...tool, responses: [response]}}}},
    {linear: {tools: {save_issue: {...tool, onExhausted: 'error'}}}},
    {linear: {tools: {save_issue: {inputSchema, responses: []}}}},
    {linear: {tools: {save_issue: {inputSchema, handler: () => response}}}},
    {linear: {tools: {save_issue: {...tool, inputSchema: {type: 'array'}}}}},
    {
      linear: {
        tools: {
          save_issue: {
            ...tool,
            response: {content: [{type: 'image', data: 'abc'}]},
          },
        },
      },
    },
    {
      linear: {
        tools: {save_issue: {...tool, response: {...response, extra: true}}},
      },
    },
  ])('rejects invalid definition %#', (value) => {
    expect(mcpMocksSchema.safeParse(value).success).toBe(false);
  });

  it('preserves case and accepts portable names at the length boundary', () => {
    const value = {
      Linear: mocks.linear,
      linear: mocks.linear,
      ['a'.repeat(128)]: mocks.linear,
    };
    expect(mcpMocksSchema.parse(value)).toEqual(value);
  });

  it('only checks schema root shape; does not resolve references or enforce keywords', () => {
    const value = {
      linear: {
        tools: {
          save_issue: {
            ...tool,
            inputSchema: {
              type: 'object',
              required: 'not validated',
              $ref: 'https://example.invalid/schema',
              properties: {
                id: {type: 'string', default: 'unchanged', format: 'custom'},
              },
            },
          },
        },
      },
    };
    expect(mcpMocksSchema.parse(value)).toEqual(value);
  });

  it('copies schemas, structured results, and sequence responses', () => {
    const value = {
      linear: {
        tools: {
          save_issue: {
            inputSchema: structuredClone(inputSchema),
            responses: [{...response, structuredContent: {nested: {ok: true}}}],
          },
        },
      },
    };
    const parsed = mcpMocksSchema.parse(value);
    value.linear.tools.save_issue.inputSchema.required.push('state');
    value.linear.tools.save_issue.responses[0]!.structuredContent.nested.ok = false;
    expect(parsed.linear!.tools.save_issue!.inputSchema.required).toEqual([
      'id',
    ]);
    expect(parsed).not.toEqual(value);
  });
});

describe('JSON-only values', () => {
  it.each([
    undefined,
    NaN,
    Infinity,
    1n,
    () => 1,
    Symbol('secret'),
    new Date(),
    /x/,
    new Map(),
    new Set(),
    new Array(1),
    Object.assign(new Array(1), {extra: true}),
  ])('rejects non-JSON input %#', (value) => {
    expect(mcpJsonObjectSchema.safeParse({value}).success).toBe(false);
  });

  it('rejects cycles, accessors, symbol keys, and hidden properties', () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    for (const value of [
      cycle,
      {
        get secret() {
          throw new Error('must not invoke');
        },
      },
      {[Symbol('x')]: 1},
      Object.defineProperty({}, 'secret', {value: 1}),
    ]) {
      expect(mcpJsonObjectSchema.safeParse(value).success).toBe(false);
    }
  });

  it('accepts shared references and returns independent JSON copies', () => {
    const child = {value: 1};
    const result = mcpJsonObjectSchema.parse({a: child, b: child});
    expect(result).toEqual({a: {value: 1}, b: {value: 1}});
    expect(result.a).not.toBe(child);
    expect(result.a).not.toBe(result.b);
  });
});

describe('MCP authoring and IR', () => {
  it('compiles helpers and anyOf branches into IR 0.4', () => {
    const config = defineDyno({
      scenarios: [
        {
          name: 'MCP',
          prompt: 'Save issue',
          mcpMocks: mocks,
          assertions: [
            mcp.called('linear', 'save_issue', {input: {id: 'ENG-123'}}),
            anyOf([
              mcp.notCalled('linear', 'save_issue', {
                input: {state: 'Canceled'},
              }),
              verify.command('true', {exitCode: 0}),
            ]),
          ],
        },
      ],
    });
    const ir = compile(config);
    expect(ir.version).toBe('0.4');
    expect(irSchema.parse(ir)).toEqual(ir);
    expect(ir.scenarios[0]!.assertions[0]).toMatchObject({
      type: 'mcp.called',
      server: 'linear',
      tool: 'save_issue',
      input: {id: 'ENG-123'},
    });
  });

  it('accepts plain assertion objects used by YAML', () => {
    expect(
      scenarioSchema.safeParse({
        name: 'MCP',
        prompt: 'Save',
        mcpMocks: mocks,
        assertions: [
          {type: 'mcp.called', server: 'linear', tool: 'save_issue'},
        ],
      }).success,
    ).toBe(true);
  });

  it.each([
    mcp.called('missing', 'save_issue'),
    mcp.notCalled('linear', 'missing'),
    mcp.called('Linear', 'save_issue'),
    mcp.called('linear', 'save_issue', {input: {}}),
    anyOf([mcp.notCalled('missing', 'save_issue')]),
  ])('rejects invalid assertion %# in authoring and IR', (assertion) => {
    const scenario = {
      name: 'MCP',
      prompt: 'Save',
      mcpMocks: mocks,
      assertions: [assertion],
    };
    expect(scenarioSchema.safeParse(scenario).success).toBe(false);
    expect(
      irScenarioSchema.safeParse({
        ...scenario,
        id: 's',
        harnesses: [{id: 'claude-code'}],
        setup: [],
        fixtures: [],
        endpoints: [],
        assertions: [{...assertion, id: 'a'}],
      }).success,
    ).toBe(false);
  });

  it('rejects assertions without mocks and MCP sequence steps', () => {
    expect(
      scenarioSchema.safeParse({
        name: 'MCP',
        prompt: 'Save',
        assertions: [mcp.notCalled('linear', 'save_issue')],
      }).success,
    ).toBe(false);
    // @ts-expect-error MCP assertions are deliberately excluded from sequence steps.
    const assertion = sequence.inOrder([mcp.called('linear', 'save_issue')]);
    expect(
      scenarioSchema.safeParse({
        name: 'MCP',
        prompt: 'Save',
        mcpMocks: mocks,
        assertions: [assertion],
      }).success,
    ).toBe(false);
  });
});
