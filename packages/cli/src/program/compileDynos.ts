/**
 * Load and compile each discovered dyno file in turn, accumulating
 * per-file errors instead of aborting on the first failure.
 *
 * A single bad file should not block the rest of a directory from
 * running. The CLI surfaces every failure (config-error block per file)
 * and still exits non-zero — the goal is for authors to see all
 * problems at once.
 *
 * Each successfully compiled IR has its scenario/assertion/endpoint IDs
 * namespaced by the source file so two files that name a scenario the
 * same way produce distinct job IDs, distinct debug log filenames, and
 * unique entries in `assertionByIdForJobs`.
 */

import {relative} from 'node:path';

import {compile, resolveConfigModule} from '@dynobox/sdk/compiler';
import type {Ir, IrAssertion, IrEndpoint, IrScenario} from '@dynobox/sdk/ir';

import {loadDyno, normalizeLoadedModule} from './configLoader.js';

export type DynoCompileSuccess = {
  filePath: string;
  /** Sanitized relative path used as the prefix for every IR id. */
  sourceSlug: string;
  ir: Ir;
};

export type DynoCompileError = {
  filePath: string;
  message: string;
};

export type CompileDynosResult = {
  compiled: DynoCompileSuccess[];
  errors: DynoCompileError[];
};

/**
 * Load and compile each path in `filePaths`. Per-file errors are caught
 * and returned alongside any successful compilations. Returns in input
 * order.
 */
export async function compileDynos(
  filePaths: readonly string[],
  options: {cwd?: string} = {},
): Promise<CompileDynosResult> {
  const cwd = options.cwd ?? process.cwd();
  const compiled: DynoCompileSuccess[] = [];
  const errors: DynoCompileError[] = [];

  for (const filePath of filePaths) {
    try {
      const loaded = await loadDyno(filePath);
      const config = resolveConfigModule(normalizeLoadedModule(loaded));
      const ir = compile(config);
      const sourceSlug = makeSourceSlug(filePath, cwd, compiled);
      compiled.push({
        filePath,
        sourceSlug,
        ir: prefixIrIds(ir, sourceSlug),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push({filePath, message});
    }
  }

  return {compiled, errors};
}

/**
 * Build a stable, readable slug from `filePath` relative to `cwd`. The
 * slug avoids regex/path metachars so it can be safely embedded in
 * filenames (debug logs) and IDs (job ids, assertion ids).
 *
 * Falls back to suffixing a counter if two files would produce the
 * same slug (e.g. absolute paths outside `cwd`).
 */
function makeSourceSlug(
  filePath: string,
  cwd: string,
  alreadyCompiled: readonly DynoCompileSuccess[],
): string {
  const rel = relative(cwd, filePath) || filePath;
  const base = rel.replace(/^[./\\]+/, '').replace(/[^A-Za-z0-9._-]+/g, '-');
  const safe = base.length > 0 ? base : 'dyno';
  let candidate = safe;
  let n = 1;
  while (alreadyCompiled.some((c) => c.sourceSlug === candidate)) {
    candidate = `${safe}-${n}`;
    n += 1;
  }
  return candidate;
}

function prefixIrIds(ir: Ir, prefix: string): Ir {
  return {
    ...ir,
    scenarios: ir.scenarios.map((scenario) => prefixScenario(scenario, prefix)),
  };
}

function prefixScenario(scenario: IrScenario, prefix: string): IrScenario {
  return {
    ...scenario,
    id: `${prefix}::${scenario.id}`,
    endpoints: scenario.endpoints.map((endpoint) =>
      prefixEndpoint(endpoint, prefix),
    ),
    assertions: scenario.assertions.map((assertion) =>
      prefixAssertion(assertion, prefix),
    ),
  };
}

function prefixEndpoint(endpoint: IrEndpoint, prefix: string): IrEndpoint {
  return {...endpoint, id: `${prefix}::${endpoint.id}`};
}

function prefixAssertion(assertion: IrAssertion, prefix: string): IrAssertion {
  const prefixed = {...assertion, id: `${prefix}::${assertion.id}`};
  if (prefixed.type === 'http.called' || prefixed.type === 'http.notCalled') {
    return {...prefixed, endpointId: `${prefix}::${prefixed.endpointId}`};
  }
  return prefixed;
}
