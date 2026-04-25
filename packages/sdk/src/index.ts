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

export function defineConfig<TConfig extends DynoboxConfig>(
  config: TConfig,
): TConfig {
  return config;
}

export function compile(config: DynoboxConfig): DynoboxConfig {
  return configSchema.parse(config);
}

export function resolveConfigModule(moduleExport: unknown): DynoboxConfig {
  return configModuleSchema.parse(moduleExport).default;
}
