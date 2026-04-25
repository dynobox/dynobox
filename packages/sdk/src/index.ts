import {z} from 'zod';

export const version = '0.0.1';

const scenarioSchema = z.object({
  name: z.string(),
  prompt: z.string(),
});

export const configSchema = z.object({
  scenarios: z.array(scenarioSchema),
});

const configModuleSchema = z.object({
  default: configSchema,
});

export type DynoboxScenarioConfig = z.infer<typeof scenarioSchema>;
export type DynoboxConfig = z.infer<typeof configSchema>;

type HttpPlaceholder = (...args: unknown[]) => never;

/**
 * Creates a placeholder helper that throws until the real SDK helper API exists.
 *
 * @param name The helper name to include in the error message.
 * @returns A function that throws when invoked.
 */
function createNotImplementedHelper(name: string): HttpPlaceholder {
  return () => {
    throw new Error(`${name} is not implemented yet.`);
  };
}

export const http = {
  endpoint: createNotImplementedHelper('http.endpoint'),
  called: createNotImplementedHelper('http.called'),
  notCalled: createNotImplementedHelper('http.notCalled'),
};

/**
 * Provides a typed passthrough for authoring Dynobox configs in TypeScript.
 *
 * @param config The config object authored by the user.
 * @returns The same config object, preserving its inferred type.
 */
export function defineConfig<TConfig extends DynoboxConfig>(
  config: TConfig,
): TConfig {
  return config;
}

/**
 * Validates a Dynobox config at runtime using the current scaffold schema.
 *
 * @param config The config object to validate.
 * @returns The validated config object.
 */
export function compile(config: DynoboxConfig): DynoboxConfig {
  return configSchema.parse(config);
}

/**
 * Resolves a loaded config module and enforces the default-export contract.
 *
 * @param moduleExport The raw module namespace object returned by the loader.
 * @returns The validated Dynobox config from the module default export.
 */
export function resolveConfigModule(moduleExport: unknown): DynoboxConfig {
  return configModuleSchema.parse(moduleExport).default;
}
