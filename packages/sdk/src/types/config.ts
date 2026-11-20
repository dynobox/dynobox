import type {Assertion, Endpoint} from './brands.js';
import type {HarnessId, HarnessRunConfig} from './harness.js';
import type {ScenarioMcpMocks} from './mcp.js';

export type CliMockResponse = {
  exitCode: number;
  stdout?: string;
  stderr?: string;
};

export type CliMockHandlerContext = {
  argv: string[];
  cwd: string;
  env: Record<string, string | undefined>;
};

export type CliMockConfig =
  | {
      response: CliMockResponse;
      responses?: never;
      onExhausted?: never;
      handler?: never;
    }
  | {
      response?: never;
      responses: CliMockResponse[];
      onExhausted?: 'error' | 'repeat-last' | CliMockResponse;
      handler?: never;
    }
  | {
      response?: never;
      responses?: never;
      onExhausted?: never;
      handler: (
        context: CliMockHandlerContext,
      ) => CliMockResponse | Promise<CliMockResponse>;
    };

export type ScenarioCliMocks = Record<string, CliMockConfig>;

/**
 * Continue the conversation after the agent's first turn. Each reply resumes
 * the agent's session as the next user message.
 */
export type ScenarioUser =
  | {
      /** Messages sent in order, one after each agent turn. */
      replies: readonly string[];
      persona?: never;
      harness?: never;
      model?: never;
      maxTurns?: never;
    }
  | {
      replies?: never;
      /** Who the simulated user is and what they want. */
      persona: string;
      /** Harness that plays the persona. Defaults to `claude-code`. */
      harness?: HarnessId;
      /** Model for the persona harness. Defaults to the harness default. */
      model?: string;
      /** Most agent turns to run, including the first. Defaults to 5. */
      maxTurns?: number;
    };

/**
 * The author-facing scenario shape.
 *
 * Generic over:
 * - `EKeys`: the union of endpoint keys that assertions in this scenario
 *   may reference. `defineDyno` widens this to (global ∪ local) per
 *   scenario; `defineScenario` widens it to (declared globals ∪ local).
 * - `E`: the concrete endpoint map. Helpers capture this so `keyof E &
 *   string` produces the local key union.
 *
 * Defaults make `ScenarioInput` (no type args) the runtime/storage shape.
 */
export type ScenarioInput<
  EKeys extends string = string,
  E extends Record<string, Endpoint> = Record<string, Endpoint>,
> = {
  id?: string;
  name: string;
  prompt: string;
  harnesses?: HarnessRunConfig[];
  setup?: string[];
  fixtures?: string | readonly string[];
  cliMocks?: ScenarioCliMocks;
  mcpMocks?: ScenarioMcpMocks;
  /** Make the scenario multi-turn: reply to the agent after each turn. */
  user?: ScenarioUser;
  endpoints?: E;
  assertions?: ReadonlyArray<Assertion<EKeys>>;
};

/**
 * The runtime shape of an authored Dynobox config. Authors typically reach
 * this type indirectly via `defineDyno`, which adds per-scenario key
 * inference on top.
 */
export type DynoboxConfig = {
  name?: string;
  /**
   * The thing being tested (e.g. `github-pr-agent`). Dynos that share a
   * target are grouped together in run reporting and on the dashboard.
   * Defaults to the dyno file's parent directory name when omitted.
   */
  target?: string;
  version?: string;
  harnesses?: HarnessRunConfig[];
  setup?: string[];
  endpoints?: Record<string, Endpoint>;
  scenarios: ScenarioInput[];
};
