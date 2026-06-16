/**
 * Load a single dyno file (TS, JS, MJS, or YAML) and return a
 * module-shaped object that `resolveConfigModule` from the SDK can
 * unwrap.
 *
 * Code paths:
 *   - `*.yaml` / `*.yml` → parse with `yaml`, return `{default: parsed}`.
 *   - everything else    → import via `tsx`'s ESM API so both `.ts` and
 *                          `.js` / `.mjs` configs work without a separate
 *                          build step.
 *
 * Some bundlers (and certain tsx outputs) wrap the config in
 * `{default: {default: …}}`. `normalizeLoadedModule` unwraps one level so
 * the SDK resolver always sees a plain `{default: …}` module shape.
 */

import {register} from 'node:module';
import {extname, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

import {tsImport} from 'tsx/esm/api';

import {loadYamlDyno} from './yamlLoader.js';

const YAML_EXTENSIONS = new Set(['.yaml', '.yml']);
const CLI_OWNED_SDK_SPECIFIERS = [
  '@dynobox/sdk',
  '@dynobox/sdk/compiler',
  '@dynobox/sdk/ir',
] as const;

let dynoboxSdkResolverRegistered = false;

/**
 * Resolve a dyno file path to a module-namespace-like object.
 *
 * Callers typically follow with
 * `resolveConfigModule(normalizeLoadedModule(...))` from the SDK.
 */
export async function loadDyno(filePath: string): Promise<unknown> {
  const absolute = resolve(filePath);
  if (YAML_EXTENSIONS.has(extname(absolute).toLowerCase())) {
    return loadYamlDyno(absolute);
  }
  return loadConfigModule(absolute);
}

/**
 * Backwards-compatible alias. Prefer `loadDyno`. Retained because the
 * existing `runCommand` import points here; will be removed once the
 * call site has migrated.
 */
export async function loadConfigModule(configPath: string): Promise<unknown> {
  registerDynoboxSdkResolver();
  const configUrl = pathToFileURL(resolve(configPath)).href;
  return tsImport(configUrl, import.meta.url);
}

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

function registerDynoboxSdkResolver() {
  if (dynoboxSdkResolverRegistered) return;

  const resolutions = Object.fromEntries(
    CLI_OWNED_SDK_SPECIFIERS.map((specifier) => [
      specifier,
      import.meta.resolve(specifier),
    ]),
  );
  const loaderSource = `
const resolutions = new Map(${JSON.stringify(Object.entries(resolutions))});

export async function resolve(specifier, context, nextResolve) {
  const resolved = resolutions.get(specifier);
  if (resolved !== undefined) return {url: resolved, shortCircuit: true};
  return nextResolve(specifier, context);
}
`;

  register(
    `data:text/javascript,${encodeURIComponent(loaderSource)}`,
    import.meta.url,
  );
  dynoboxSdkResolverRegistered = true;
}
