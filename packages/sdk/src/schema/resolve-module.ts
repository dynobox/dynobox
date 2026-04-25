import {z} from 'zod';

import type {DynoboxConfig} from '../types/config.js';
import {configSchema} from './config-schema.js';

const configModuleSchema = z.object({
  default: configSchema,
});

/**
 * Resolves a loaded config module and enforces the default-export contract.
 *
 * @param moduleExport The raw module namespace object returned by the loader.
 * @returns The validated Dynobox config from the module default export.
 */
export function resolveConfigModule(moduleExport: unknown): DynoboxConfig {
  return configModuleSchema.parse(moduleExport)
    .default as unknown as DynoboxConfig;
}
