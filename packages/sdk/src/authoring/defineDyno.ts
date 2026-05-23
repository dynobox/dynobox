import {existsSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

import type {Endpoint} from '../types/brands.js';
import type {DynoboxConfig, ScenarioInput} from '../types/config.js';
import type {HarnessRunConfig} from '../types/harness.js';

type EndpointMap = Record<string, Endpoint>;

/**
 * For a tuple of scenario shapes, produce a parallel tuple where each
 * scenario's assertions are constrained to keys ∈ (global ∪ thatScenario.local).
 *
 * This is the type-level enforcement of the assertion-key invariant.
 */
type ConstrainScenarios<
  GE extends EndpointMap | undefined,
  S extends ReadonlyArray<ScenarioInput<string, EndpointMap>>,
> = {
  [I in keyof S]: ScenarioInput<
    | (GE extends EndpointMap ? keyof GE & string : never)
    | (S[I]['endpoints'] extends EndpointMap
        ? keyof S[I]['endpoints'] & string
        : never)
  >;
};

/**
 * Provides a typed passthrough for authoring dynos. The mapped
 * type over `scenarios` constrains each scenario's assertion endpoint keys
 * to keys present in (global ∪ that scenario's local) endpoints.
 *
 * @param config The config object authored by the user.
 * @returns The same config object, narrowed to `DynoboxConfig` for downstream use.
 *
 * When called from a JS/TS dyno file with an adjacent `fixtures/` directory,
 * scenarios that omit `fixtures` are automatically assigned that directory.
 */
export function defineDyno<
  const GE extends EndpointMap | undefined,
  const S extends ReadonlyArray<ScenarioInput<string, EndpointMap>>,
>(config: {
  name?: string;
  version?: string;
  harnesses?: HarnessRunConfig[];
  setup?: string[];
  endpoints?: GE;
  scenarios: S & ConstrainScenarios<GE, S>;
}): DynoboxConfig {
  return applyDefaultFixtures(config as unknown as DynoboxConfig);
}

function applyDefaultFixtures(config: DynoboxConfig): DynoboxConfig {
  const defaultFixtures = defaultFixturesPath();
  if (defaultFixtures === undefined) return config;

  const scenarios = config.scenarios.map((scenario) =>
    scenario.fixtures === undefined
      ? {...scenario, fixtures: defaultFixtures}
      : scenario,
  );
  return {...config, scenarios};
}

function defaultFixturesPath(): string | undefined {
  const callerUrl = inferConfigModuleUrl();
  if (callerUrl === undefined) return undefined;
  const fixtures = join(dirname(fileURLToPath(callerUrl)), 'fixtures');
  return existsSync(fixtures) ? fixtures : undefined;
}

function inferConfigModuleUrl(): string | undefined {
  const stack = new Error().stack;
  if (stack === undefined) return undefined;

  for (const line of stack.split('\n').slice(1)) {
    const file = parseStackFrameFile(line);
    if (file === undefined || isSdkFrame(file)) continue;
    return file.startsWith('file://') ? file : pathToFileURL(file).href;
  }
  return undefined;
}

function parseStackFrameFile(line: string): string | undefined {
  const fileUrl = line.match(/(file:\/\/.*?):\d+:\d+/u)?.[1];
  if (fileUrl !== undefined) return fileUrl;

  const absolutePath = line.match(
    /\(?((?:\/|[A-Za-z]:\\).*?):\d+:\d+\)?$/u,
  )?.[1];
  return absolutePath;
}

function isSdkFrame(file: string): boolean {
  const normalized = file.replaceAll('\\', '/');
  return (
    normalized.includes('/packages/sdk/src/authoring/defineDyno.') ||
    normalized.includes('/packages/sdk/dist/')
  );
}
