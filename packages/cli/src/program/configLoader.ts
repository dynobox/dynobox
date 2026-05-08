/**
 * Load a user-supplied dynobox config module via `tsx`'s ESM API so both
 * `.ts` and `.js`/`.mjs` configs work without a separate build step.
 *
 * The returned value is the module's namespace; `resolveConfigModule` from
 * the SDK handles unwrapping `default` / nested `default.default` shapes.
 */

import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

import {tsImport} from 'tsx/esm/api';

export async function loadConfigModule(configPath: string): Promise<unknown> {
  const configUrl = pathToFileURL(resolve(configPath)).href;
  return tsImport(configUrl, import.meta.url);
}

/**
 * Some bundlers (and certain tsx outputs) wrap the config in
 * `{default: {default: …}}`. Unwrap one level when we detect that shape so
 * the SDK resolver sees a plain `{default: …}` module.
 */
export function normalizeLoadedModule(moduleExport: unknown): unknown {
  if (
    isRecord(moduleExport) &&
    isRecord(moduleExport.default) &&
    'default' in moduleExport.default
  ) {
    return moduleExport.default;
  }
  return moduleExport;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
