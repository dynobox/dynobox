import {existsSync} from 'node:fs';
import {dirname, join, sep} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

import {shellQuote} from '../dyno/index.js';
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
 * Dynos inside `.agents/skills/<name>/...` or `.claude/skills/<name>/...`
 * also get setup commands that copy the skill instructions into each scenario
 * work directory.
 */
export function defineDyno<
  const GE extends EndpointMap | undefined,
  const S extends ReadonlyArray<ScenarioInput<string, EndpointMap>>,
>(config: {
  name?: string;
  target?: string;
  version?: string;
  harnesses?: HarnessRunConfig[];
  setup?: string[];
  endpoints?: GE;
  scenarios: S & ConstrainScenarios<GE, S>;
}): DynoboxConfig {
  return applyAuthoringDefaults(config as unknown as DynoboxConfig);
}

function applyAuthoringDefaults(config: DynoboxConfig): DynoboxConfig {
  const callerUrl = inferConfigModuleUrl();
  if (callerUrl === undefined) return config;

  return applyDefaultSkillSetup(
    applyDefaultFixtures(config, callerUrl),
    callerUrl,
  );
}

function applyDefaultFixtures(
  config: DynoboxConfig,
  callerUrl: string,
): DynoboxConfig {
  const defaultFixtures = defaultFixturesPath(callerUrl);
  if (defaultFixtures === undefined) return config;

  const scenarios = config.scenarios.map((scenario) =>
    scenario.fixtures === undefined
      ? {...scenario, fixtures: defaultFixtures}
      : scenario,
  );
  return {...config, scenarios};
}

function applyDefaultSkillSetup(
  config: DynoboxConfig,
  callerUrl: string,
): DynoboxConfig {
  const skill = defaultSkillSetup(callerUrl);
  if (skill === undefined) return config;

  const skillSetup = [
    `mkdir -p ${shellQuote(skill.targetDir)}`,
    `cp ${shellQuote(skill.sourceFile)} ${shellQuote(skill.targetFile)}`,
  ];
  const scenarios = config.scenarios.map((scenario) => ({
    ...scenario,
    setup: [...skillSetup, ...(scenario.setup ?? [])],
  }));

  return {
    ...config,
    scenarios,
  };
}

function defaultFixturesPath(callerUrl: string): string | undefined {
  const fixtures = join(dirname(fileURLToPath(callerUrl)), 'fixtures');
  return existsSync(fixtures) ? fixtures : undefined;
}

function defaultSkillSetup(callerUrl: string):
  | {
      sourceFile: string;
      targetDir: string;
      targetFile: string;
    }
  | undefined {
  const skillDir = findAuthoredSkillDir(dirname(fileURLToPath(callerUrl)));
  if (skillDir === undefined) return undefined;

  const sourceFile = join(skillDir.dir, 'SKILL.md');
  if (!existsSync(sourceFile)) return undefined;

  const targetDir = `${skillDir.root}/skills/${skillDir.name}`;
  return {
    sourceFile,
    targetDir,
    targetFile: `${targetDir}/SKILL.md`,
  };
}

function findAuthoredSkillDir(
  startDir: string,
): {dir: string; name: string; root: '.agents' | '.claude'} | undefined {
  let current = startDir;
  while (true) {
    const parts = current.split(sep);
    const skillName = parts.at(-1);
    const root = parts.at(-3);
    if (
      skillName !== undefined &&
      (root === '.agents' || root === '.claude') &&
      parts.at(-2) === 'skills'
    ) {
      return {dir: current, name: skillName, root};
    }

    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
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
