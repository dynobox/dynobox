import {
  ASSERTION_BRAND,
  type McpCalledAssertion,
  type McpNotCalledAssertion,
} from '../types/brands.js';
import type {JsonObject} from '../types/mcp.js';

/** Assert against calls recorded by the scenario's declared MCP mocks. */
export const mcp = {
  called(
    server: string,
    tool: string,
    options?: {input?: JsonObject},
  ): McpCalledAssertion {
    return {
      [ASSERTION_BRAND]: true,
      type: 'mcp.called',
      server,
      tool,
      ...(options?.input === undefined ? {} : {input: options.input}),
    };
  },
  notCalled(
    server: string,
    tool: string,
    options?: {input?: JsonObject},
  ): McpNotCalledAssertion {
    return {
      [ASSERTION_BRAND]: true,
      type: 'mcp.notCalled',
      server,
      tool,
      ...(options?.input === undefined ? {} : {input: options.input}),
    };
  },
};
