/** Values that can cross the MCP JSON transport without conversion or loss. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | JsonObject;

export type JsonObject = {[key: string]: JsonValue};

/** V1 supports text content and optional structured JSON output. */
export type McpToolResult = {
  content: {type: 'text'; text: string}[];
  structuredContent?: JsonObject;
  isError?: boolean;
};

/** Advertised unchanged; v1 checks the root shape but does not enforce it. */
export type McpInputSchema = JsonObject & {type: 'object'};

export type McpMockTool = {
  description?: string;
  inputSchema: McpInputSchema;
} & (
  | {
      response: McpToolResult;
      responses?: never;
      onExhausted?: never;
    }
  | {
      response?: never;
      responses: McpToolResult[];
      /** Defaults to an infrastructure failure when the sequence runs out. */
      onExhausted?: 'error' | 'repeat-last' | McpToolResult;
    }
);

export type McpMockServer = {
  instructions?: string;
  tools: Record<string, McpMockTool>;
};

export type ScenarioMcpMocks = Record<string, McpMockServer>;

export type McpCallCategory =
  | 'success'
  | 'tool_error'
  | 'unknown_tool'
  | 'exhausted'
  | 'transport_failed';

export type McpMockFailure =
  | 'unknown_tool'
  | 'exhausted'
  | 'limit_exceeded'
  | 'protocol_failed'
  | 'pending_calls'
  | 'cleanup_failed'
  | 'not_ready';

/** In-memory evidence only. Never serialize inputs into reports or uploads. */
export type McpCallRecord = {
  readonly sequence: number;
  readonly server: string;
  readonly tool: string;
  readonly input: JsonObject;
  readonly category: McpCallCategory;
};

/** A sealed controller snapshot; readiness also requires adapter evidence. */
export type McpObservation = {
  readonly finalized: boolean;
  readonly ready: boolean;
  readonly failures: readonly McpMockFailure[];
  readonly tools: Readonly<Record<string, readonly string[]>>;
  readonly calls: readonly McpCallRecord[];
};
